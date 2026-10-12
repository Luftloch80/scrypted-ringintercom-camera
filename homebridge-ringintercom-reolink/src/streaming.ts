import type { ChildProcess } from 'child_process';
import type dgram from 'dgram';
import type {
    API,
    CameraController,
    CameraStreamingDelegate,
    PrepareStreamCallback,
    PrepareStreamRequest,
    SnapshotRequest,
    SnapshotRequestCallback,
    StreamingRequest,
    StreamRequestCallback,
} from 'homebridge';
import { killQuiet, spawnFFmpeg } from './ffmpeg.js';
import type { Log } from './log.js';
import type { Rebroadcast } from './rebroadcast.js';
import type { ReolinkClient } from './reolink.js';
import { bindUdp, closeQuiet, IntercomAudioSource, reserveRtpPort, RingIntercomAudio } from './ring-audio.js';

const SNAPSHOT_CACHE_MS = 3000;
const RTCP_TIMEOUT_MS = 30000;

interface Session {
    address: string;
    ipv6: boolean;
    videoPort: number;
    videoSrtp: Buffer;
    videoSSRC: number;
    audioPort: number;
    audioSrtp: Buffer;
    audioSSRC: number;
    /** receives rtcp of the video stream from the apple device. */
    videoReturn: dgram.Socket;
    /** receives rtcp and the microphone audio of the apple device. */
    audioReturn: dgram.Socket;
    lastRtcp: number;
    cp?: ChildProcess;
    audioSource?: IntercomAudioSource;
    talkback?: dgram.Socket;
    talkbackPort?: number;
    talkbackStarting?: boolean;
    watchdog?: NodeJS.Timeout;
    stopped?: boolean;
}

export interface StreamingDelegateOptions {
    name: string;
    ffmpegPath: string;
    getRebroadcast: (purpose: 'live' | 'snapshot') => Rebroadcast;
    reolink: () => ReolinkClient;
    intercomAudio?: RingIntercomAudio;
    twoWayAudio: boolean;
}

function srtpParams(key: Buffer, salt: Buffer) {
    return Buffer.concat([key, salt]);
}

function isRtcp(packet: Buffer) {
    // rtcp packet types 200-204 share the second byte position with the rtp marker/payload type.
    return packet.length > 1 && packet[1] >= 200 && packet[1] <= 204;
}

/**
 * HomeKit live view (and snapshots) of the Reolink camera, with the audio of the Ring Intercom
 * and two way audio to the intercom speaker.
 */
export class StreamingDelegate implements CameraStreamingDelegate {
    controller?: CameraController;
    private pending = new Map<string, Session>();
    private sessions = new Map<string, Session>();
    private snapshot?: { time: number, promise: Promise<Buffer> };

    constructor(private api: API, private log: Log, private options: StreamingDelegateOptions) {
    }

    get activeSessions() {
        return this.sessions.size;
    }

    handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): void {
        this.getSnapshot(request.width)
            .then(jpeg => callback(undefined, jpeg))
            .catch(e => {
                this.log.warn('snapshot failed:', (e as Error).message);
                callback(e as Error);
            });
    }

    getSnapshot(width = 640): Promise<Buffer> {
        if (this.snapshot && Date.now() - this.snapshot.time < SNAPSHOT_CACHE_MS)
            return this.snapshot.promise;
        const promise = (async () => {
            try {
                return await this.options.reolink().jpegSnapshot(5000);
            }
            catch (e) {
                this.log.debug('Reolink snapshot failed, using the video stream:', (e as Error).message);
                return this.snapshotFromStream(width);
            }
        })();
        this.snapshot = { time: Date.now(), promise };
        promise.catch(() => {
            if (this.snapshot?.promise === promise)
                this.snapshot = undefined;
        });
        return promise;
    }

    private async snapshotFromStream(width: number): Promise<Buffer> {
        const rebroadcast = this.options.getRebroadcast('snapshot');
        const input = await rebroadcast.createInput(0);
        const args = [
            '-hide_banner',
            '-loglevel', 'error',
            ...input.inputArguments,
            '-frames:v', '1',
            '-vf', `scale=${Math.max(width, 320)}:-2`,
            '-f', 'image2',
            '-c:v', 'mjpeg',
            'pipe:1',
        ];
        const cp = spawnFFmpeg(this.options.ffmpegPath, args, { name: 'snapshot', log: this.log });
        const chunks: Buffer[] = [];
        cp.stdout!.on('data', (data: Buffer) => chunks.push(data));
        const timeout = setTimeout(() => killQuiet(cp), 10000);
        await new Promise(resolve => cp.on('exit', resolve));
        clearTimeout(timeout);
        const jpeg = Buffer.concat(chunks);
        if (!jpeg.length)
            throw new Error('no snapshot from the video stream');
        return jpeg;
    }

    async prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): Promise<void> {
        try {
            const ipv6 = request.addressVersion === 'ipv6';
            const type = ipv6 ? 'udp6' : 'udp4';
            const any = ipv6 ? '::' : '0.0.0.0';
            const videoReturn = await bindUdp(0, any, type);
            const audioReturn = await bindUdp(0, any, type);
            const generate = this.api.hap.CameraController.generateSynchronisationSource;

            const session: Session = {
                address: request.targetAddress,
                ipv6,
                videoPort: request.video.port,
                videoSrtp: srtpParams(request.video.srtp_key, request.video.srtp_salt),
                videoSSRC: generate(),
                audioPort: request.audio.port,
                audioSrtp: srtpParams(request.audio.srtp_key, request.audio.srtp_salt),
                audioSSRC: generate(),
                videoReturn,
                audioReturn,
                lastRtcp: Date.now(),
            };
            this.pending.set(request.sessionID, session);

            callback(undefined, {
                video: {
                    port: videoReturn.address().port,
                    ssrc: session.videoSSRC,
                    srtp_key: request.video.srtp_key,
                    srtp_salt: request.video.srtp_salt,
                },
                audio: {
                    port: audioReturn.address().port,
                    ssrc: session.audioSSRC,
                    srtp_key: request.audio.srtp_key,
                    srtp_salt: request.audio.srtp_salt,
                },
            });
        }
        catch (e) {
            this.log.error('prepare stream failed:', (e as Error).message);
            callback(e as Error);
        }
    }

    handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
        switch (request.type) {
            case this.api.hap.StreamRequestTypes.START: {
                const session = this.pending.get(request.sessionID);
                this.pending.delete(request.sessionID);
                if (!session) {
                    callback(new Error('unknown streaming session'));
                    return;
                }
                this.sessions.set(request.sessionID, session);
                this.startStream(request.sessionID, session, request)
                    .then(() => callback())
                    .catch(e => {
                        this.log.error('live view failed:', (e as Error).message);
                        this.stopSession(request.sessionID);
                        callback(e as Error);
                    });
                return;
            }
            case this.api.hap.StreamRequestTypes.RECONFIGURE:
                // the stream is not transcoded, nothing to change.
                callback();
                return;
            case this.api.hap.StreamRequestTypes.STOP:
                this.stopSession(request.sessionID);
                callback();
                return;
        }
    }

    private async startStream(sessionId: string, session: Session, request: Extract<StreamingRequest, { type: 'start' }>) {
        const { video, audio } = request;
        this.log.log(`live view started (${video.width}x${video.height}, ${session.address})`);

        const rebroadcast = this.options.getRebroadcast('live');
        const input = await rebroadcast.createInput(0);
        if (session.stopped)
            return;

        const target = session.ipv6 ? `[${session.address}]` : session.address;
        const args = [
            '-hide_banner',
            '-loglevel', 'warning',
            '-fflags', '+genpts+nobuffer',
            '-flags', 'low_delay',
            '-probesize', '1000000',
            '-analyzeduration', '1000000',
            ...input.inputArguments,
        ];

        let stdin: string | undefined;
        let audioMap: string | undefined;
        if (this.options.intercomAudio) {
            session.audioSource = await this.options.intercomAudio.startAudioSource();
            stdin = session.audioSource.sdp;
            args.push(
                '-protocol_whitelist', 'pipe,udp,rtp,file,crypto',
                // the codec is known from the sdp, don't wait for audio to probe it.
                '-analyzeduration', '0',
                '-probesize', '32',
                '-f', 'sdp',
                '-i', 'pipe:0',
            );
            audioMap = '1:a:0';
        }
        else if (rebroadcast.hasAudio) {
            audioMap = '0:a:0';
        }

        args.push(
            '-map', '0:v:0',
            '-c:v', 'copy',
            '-payload_type', video.pt.toString(),
            '-ssrc', video.ssrc.toString(),
            '-f', 'rtp',
            '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
            '-srtp_out_params', session.videoSrtp.toString('base64'),
            `srtp://${target}:${session.videoPort}?rtcpport=${session.videoPort}&pkt_size=${video.mtu}`,
        );

        if (audioMap && audio.codec === this.api.hap.AudioStreamingCodecType.OPUS) {
            const sampleRate = (audio.sample_rate || 24) * 1000;
            args.push(
                '-map', audioMap,
                '-c:a', 'libopus',
                '-application', 'lowdelay',
                '-frame_duration', (audio.packet_time || 20).toString(),
                '-ar', sampleRate.toString(),
                '-ac', '1',
                '-b:a', `${audio.max_bit_rate || 24}k`,
                '-flags', '+global_header',
                '-payload_type', audio.pt.toString(),
                '-ssrc', audio.ssrc.toString(),
                '-f', 'rtp',
                '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
                '-srtp_out_params', session.audioSrtp.toString('base64'),
                `srtp://${target}:${session.audioPort}?rtcpport=${session.audioPort}&pkt_size=188`,
            );
        }

        const cp = spawnFFmpeg(this.options.ffmpegPath, args, {
            name: 'live',
            log: this.log,
            stdio: ['pipe', 'ignore', 'pipe'],
        });
        session.cp = cp;
        cp.stdin?.on('error', () => { });
        cp.stdin?.end(stdin);
        cp.on('exit', code => {
            if (session.stopped)
                return;
            this.log.warn(`live view ended unexpectedly (${code})`);
            this.forceStop(sessionId);
        });

        // the apple device sends rtcp reports while it is watching.
        const onRtcp = () => session.lastRtcp = Date.now();
        session.videoReturn.on('message', onRtcp);
        session.watchdog = setInterval(() => {
            if (Date.now() - session.lastRtcp > RTCP_TIMEOUT_MS) {
                this.log.log('live view timed out');
                this.forceStop(sessionId);
            }
        }, 5000);

        session.audioReturn.on('message', message => {
            if (isRtcp(message)) {
                onRtcp();
                return;
            }
            this.onMicrophonePacket(session, request, message);
        });
    }

    /**
     * The microphone audio of the apple device (srtp). It is forwarded to an ffmpeg that sends it
     * to the Ring Intercom speaker. That ffmpeg is started with the first packet.
     */
    private onMicrophonePacket(session: Session, request: Extract<StreamingRequest, { type: 'start' }>, packet: Buffer) {
        const { intercomAudio, twoWayAudio } = this.options;
        if (!intercomAudio || !twoWayAudio || session.stopped)
            return;
        if (session.talkback) {
            session.talkback.send(packet, session.talkbackPort!, '127.0.0.1');
            return;
        }
        if (session.talkbackStarting)
            return;
        session.talkbackStarting = true;

        (async () => {
            const port = await reserveRtpPort();
            const sdp = [
                'v=0',
                'o=- 0 0 IN IP4 127.0.0.1',
                's=HomeKit Microphone',
                'c=IN IP4 127.0.0.1',
                't=0 0',
                `m=audio ${port} RTP/AVP ${request.audio.pt}`,
                `a=rtpmap:${request.audio.pt} opus/48000/2`,
                `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${session.audioSrtp.toString('base64')}`,
                '',
            ].join('\r\n');

            const forward = await bindUdp();
            if (session.stopped) {
                closeQuiet(forward);
                return;
            }
            session.talkback = forward;
            session.talkbackPort = port;
            this.log.log('two way audio to the Ring Intercom started');
            await intercomAudio.startTalkback([
                '-protocol_whitelist', 'pipe,udp,rtp,file,crypto',
                '-f', 'sdp',
                '-c:a', 'libopus',
                '-i', 'pipe:0',
            ], sdp);
        })().catch(e => {
            this.log.error('two way audio failed:', (e as Error).message);
        });
    }

    private forceStop(sessionId: string) {
        this.stopSession(sessionId);
        try {
            this.controller?.forceStopStreamingSession(sessionId);
        }
        catch (e) {
        }
    }

    private stopSession(sessionId: string) {
        const pending = this.pending.get(sessionId);
        if (pending) {
            this.pending.delete(sessionId);
            closeQuiet(pending.videoReturn);
            closeQuiet(pending.audioReturn);
        }

        const session = this.sessions.get(sessionId);
        if (!session)
            return;
        this.sessions.delete(sessionId);
        session.stopped = true;
        clearInterval(session.watchdog);
        killQuiet(session.cp);
        session.audioSource?.stop();
        if (session.talkback) {
            closeQuiet(session.talkback);
            this.options.intercomAudio?.stopTalkback();
        }
        closeQuiet(session.videoReturn);
        closeQuiet(session.audioReturn);
        this.log.log('live view stopped');
    }

    stopAll() {
        for (const id of [...this.sessions.keys(), ...this.pending.keys()])
            this.stopSession(id);
    }
}
