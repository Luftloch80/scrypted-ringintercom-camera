import { ChildProcess } from 'child_process';
import dgram from 'dgram';
import { RingApi, RingCamera, RingIntercom } from 'ring-client-api';
import type { StreamingSession } from 'ring-client-api/streaming/streaming-session';
import { RtpHeader, RtpPacket } from 'werift';
import { killQuiet, spawnFFmpeg } from './ffmpeg.js';
import type { Log } from './log.js';

const OPUS_PAYLOAD_TYPE = 111;
// 20ms at 48khz.
const OPUS_FRAME_SAMPLES = 960;
// a 20ms opus (celt) frame of silence.
const OPUS_SILENCE = Buffer.from([0xF8, 0xFF, 0xFE]);

/**
 * Ring Intercoms are not cameras in ring-client-api, so there is no startLiveCall() on them.
 * The live view signalling only needs the doorbot id, the rest client and a name, so a
 * lightweight RingCamera stand-in is created that reuses the library's WebRTC implementation
 * for the intercom.
 */
function startIntercomLiveCall(api: RingApi, intercom: RingIntercom): Promise<StreamingSession> {
    const shim = Object.create(RingCamera.prototype, {
        id: { value: intercom.id },
        restClient: { value: api.restClient },
        data: { get: () => intercom.data },
        name: { get: () => intercom.name },
        isRingEdgeEnabled: { value: false },
    }) as RingCamera;
    return RingCamera.prototype.startLiveCall.call(shim);
}

export function closeQuiet(socket?: dgram.Socket) {
    try {
        socket?.close();
    }
    catch (e) {
    }
}

export async function bindUdp(port = 0, address = '127.0.0.1', type: 'udp4' | 'udp6' = 'udp4'): Promise<dgram.Socket> {
    const socket = dgram.createSocket(type);
    await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(port, address, () => {
            socket.removeListener('error', reject);
            resolve();
        });
    });
    return socket;
}

/**
 * Find a free even udp port for ffmpeg to receive rtp on (rtcp uses port + 1).
 */
export async function reserveRtpPort(): Promise<number> {
    for (let i = 0; i < 20; i++) {
        const probe = await bindUdp();
        const port = probe.address().port;
        closeQuiet(probe);
        if (port % 2 || port > 65000)
            continue;
        try {
            const a = await bindUdp(port);
            const b = await bindUdp(port + 1);
            closeQuiet(a);
            closeQuiet(b);
            return port;
        }
        catch (e) {
        }
    }
    throw new Error('unable to reserve an rtp port');
}

interface Lease {
    session: StreamingSession;
    release(): void;
}

export interface IntercomAudioSource {
    /** sdp to pass to ffmpeg (stdin) to receive the intercom audio as opus rtp. */
    sdp: string;
    stop(): void;
}

/**
 * Manages the (on demand) live audio session with a Ring Intercom.
 * Multiple consumers (live views with intercom audio, talkback) share one Ring session.
 * The session is closed shortly after the last consumer is gone.
 */
export class RingIntercomAudio {
    private session?: StreamingSession;
    private sessionPromise?: Promise<StreamingSession>;
    private leases = new Set<symbol>();
    private idleTimeout?: NodeJS.Timeout;
    private talkback?: {
        cp: ChildProcess;
        socket: dgram.Socket;
        lease: Lease;
    };

    constructor(public getApi: () => RingApi, public intercom: RingIntercom, public ffmpegPath: string, public console: Log) {
    }

    get active() {
        return !!this.session;
    }

    private async startSession() {
        this.console.log('starting Ring Intercom live session');
        const session = await startIntercomLiveCall(this.getApi(), this.intercom);
        this.session = session;
        session.onCallEnded.subscribe(() => {
            this.console.log('Ring Intercom live session ended');
            if (this.session === session) {
                this.session = undefined;
                this.sessionPromise = undefined;
            }
        });
        return session;
    }

    async acquire(): Promise<Lease> {
        clearTimeout(this.idleTimeout);
        const token = Symbol();
        this.leases.add(token);
        try {
            if (!this.sessionPromise)
                this.sessionPromise = this.startSession();
            const session = await this.sessionPromise;
            return {
                session,
                release: () => this.release(token),
            };
        }
        catch (e) {
            this.sessionPromise = undefined;
            this.release(token);
            throw e;
        }
    }

    private release(token: symbol) {
        if (!this.leases.delete(token))
            return;
        if (this.leases.size)
            return;
        clearTimeout(this.idleTimeout);
        this.idleTimeout = setTimeout(() => {
            if (this.leases.size)
                return;
            this.stop();
        }, 5000);
    }

    stop() {
        clearTimeout(this.idleTimeout);
        this.stopTalkback();
        const session = this.session;
        this.session = undefined;
        this.sessionPromise = undefined;
        session?.stop();
    }

    /**
     * Provides the live audio of the Ring Intercom as an opus rtp stream on localhost, described
     * by the returned sdp. Silence is sent until the Ring session delivers audio (and whenever it
     * pauses or fails), so an ffmpeg reading it alongside the video never waits for Ring.
     */
    async startAudioSource(): Promise<IntercomAudioSource> {
        const rtpPort = await reserveRtpPort();
        const sdp = [
            'v=0',
            'o=- 0 0 IN IP4 127.0.0.1',
            's=Ring Intercom',
            'c=IN IP4 127.0.0.1',
            't=0 0',
            `m=audio ${rtpPort} RTP/AVP ${OPUS_PAYLOAD_TYPE}`,
            `a=rtpmap:${OPUS_PAYLOAD_TYPE} opus/48000/2`,
            '',
        ].join('\r\n');

        let lease: Lease | undefined;
        let unsubscribe: (() => void) | undefined;
        let closed = false;

        const udp = dgram.createSocket('udp4');
        const ssrc = Math.floor(Math.random() * 0xFFFFFFFF);
        const startTime = Date.now();
        let sequenceNumber = 0;
        let timestamp = 0;
        let lastRingTimestamp: number | undefined;
        let lastRingPacket = 0;

        const send = (payload: Buffer) => {
            if (closed)
                return;
            const rtp = new RtpPacket(new RtpHeader({
                payloadType: OPUS_PAYLOAD_TYPE,
                sequenceNumber,
                timestamp,
                ssrc,
            }), payload);
            sequenceNumber = (sequenceNumber + 1) & 0xFFFF;
            udp.send(rtp.serialize(), rtpPort, '127.0.0.1');
        };

        // fill gaps with silence, paced by the wall clock.
        const silenceTimer = setInterval(() => {
            if (Date.now() - lastRingPacket < 200)
                return;
            const expected = (Date.now() - startTime) * 48;
            while (timestamp + OPUS_FRAME_SAMPLES <= expected) {
                send(OPUS_SILENCE);
                timestamp += OPUS_FRAME_SAMPLES;
                lastRingTimestamp = undefined;
            }
        }, 20);

        const stop = () => {
            if (closed)
                return;
            closed = true;
            clearInterval(silenceTimer);
            unsubscribe?.();
            closeQuiet(udp);
            lease?.release();
        };

        (async () => {
            try {
                lease = await this.acquire();
            }
            catch (e) {
                this.console.error('Ring Intercom live session failed, streaming without intercom audio:', (e as Error).message);
                return;
            }
            if (closed) {
                lease.release();
                lease = undefined;
                return;
            }
            const { session } = lease;

            let warnedPcmu = false;
            const sub = session.onAudioRtp.subscribe(rtp => {
                if (rtp.header.payloadType === 0) {
                    if (!warnedPcmu) {
                        warnedPcmu = true;
                        this.console.warn('Ring negotiated PCMU audio, which is not supported, the intercom audio stays silent.');
                    }
                    return;
                }
                if (!lastRingPacket)
                    this.console.log('receiving Ring Intercom audio');
                // continue the local timeline using the timing of the ring packets.
                let delta = OPUS_FRAME_SAMPLES;
                if (lastRingTimestamp !== undefined) {
                    const d = (rtp.header.timestamp - lastRingTimestamp) >>> 0;
                    if (d > 0 && d < 48000)
                        delta = d;
                }
                lastRingTimestamp = rtp.header.timestamp;
                lastRingPacket = Date.now();
                timestamp += delta;
                send(rtp.payload);
            });
            const ended = session.onCallEnded.subscribe(() => {
                lastRingPacket = 0;
            });
            unsubscribe = () => {
                sub.unsubscribe();
                ended.unsubscribe();
            };
        })();

        return { sdp, stop };
    }

    get talkbackActive() {
        return !!this.talkback;
    }

    /**
     * Two way audio: send the audio of `inputArguments` (e.g. the HomeKit microphone) to the
     * Ring Intercom speaker. `stdin` is written to ffmpeg's stdin (e.g. an sdp).
     */
    async startTalkback(inputArguments: string[], stdin?: string) {
        this.stopTalkback();

        const lease = await this.acquire();
        const { session } = lease;
        const usingOpus = await session.isUsingOpus.catch(() => true);

        const socket = await bindUdp();
        socket.on('message', message => {
            try {
                session.sendAudioPacket(RtpPacket.deSerialize(message));
            }
            catch (e) {
            }
        });

        session.activateCameraSpeaker();

        const args = [
            '-hide_banner',
            '-loglevel', 'warning',
            ...inputArguments,
            '-vn', '-dn', '-sn',
            ...(usingOpus
                ? ['-acodec', 'libopus', '-application', 'lowdelay', '-ac', '2', '-ar', '48000']
                : ['-acodec', 'pcm_mulaw', '-ac', '1', '-ar', '8000']),
            '-flags', '+global_header',
            '-f', 'rtp',
            `rtp://127.0.0.1:${socket.address().port}?pkt_size=1300`,
        ];

        const cp = spawnFFmpeg(this.ffmpegPath, args, {
            name: 'talkback',
            log: this.console,
            stdio: ['pipe', 'ignore', 'pipe'],
        });
        cp.stdin?.on('error', () => { });
        if (stdin !== undefined)
            cp.stdin?.end(stdin);
        else
            cp.stdin?.end();

        const talkback = { cp, socket, lease };
        this.talkback = talkback;
        const end = () => {
            if (this.talkback === talkback)
                this.stopTalkback();
        };
        cp.on('exit', () => {
            this.console.debug('two way audio ended');
            end();
        });
        session.onCallEnded.subscribe(end);
    }

    stopTalkback() {
        const talkback = this.talkback;
        if (!talkback)
            return;
        this.talkback = undefined;
        killQuiet(talkback.cp);
        closeQuiet(talkback.socket);
        talkback.lease.release();
    }
}
