import { ChildProcess, spawn } from 'child_process';
import dgram from 'dgram';
import net from 'net';
import { RingApi, RingCamera, RingIntercom } from 'ring-client-api';
import type { StreamingSession } from 'ring-client-api/streaming/streaming-session';
import { RtpHeader, RtpPacket } from 'werift';

const OPUS_PAYLOAD_TYPE = 111;
// 20ms at 48khz.
const OPUS_FRAME_SAMPLES = 960;
// a 20ms opus (celt) frame of silence.
const OPUS_SILENCE = Buffer.from([0xF8, 0xFF, 0xFE]);

/**
 * Ring Intercoms are not cameras in ring-client-api, so there is no startLiveCall() on them.
 * The live view signalling (wss://api.prod.signalling.ring.devices.a2z.com) only needs the
 * doorbot id, the rest client and a name, so a lightweight RingCamera stand-in is created
 * that reuses the library's WebRTC implementation for the intercom.
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

export function closeQuiet(socket?: dgram.Socket | net.Server | net.Socket) {
    try {
        if (socket instanceof net.Socket)
            socket.destroy();
        else
            socket?.close();
    }
    catch (e) {
    }
}

export function killQuiet(cp?: ChildProcess) {
    try {
        cp?.kill('SIGKILL');
    }
    catch (e) {
    }
}

async function bindUdp(port = 0): Promise<dgram.Socket> {
    const socket = dgram.createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(port, '127.0.0.1', () => {
            socket.removeListener('error', reject);
            resolve();
        });
    });
    return socket;
}

/**
 * Find a free even udp port for ffmpeg to receive rtp on (rtcp uses port + 1).
 */
async function reserveRtpPort(): Promise<number> {
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

/**
 * Manages the (on demand) live audio session with a Ring Intercom.
 * Multiple consumers (video streams with intercom audio, talkback) share one Ring session.
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

    constructor(public getApi: () => RingApi, public intercom: RingIntercom, public getFFmpegPath: () => Promise<string>, public console: Console) {
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
     * Creates a local tcp server which, once a client connects, muxes the video of `videoInputArguments`
     * (e.g. the Reolink RTSP stream) with the live audio of the Ring Intercom into an mpegts stream.
     * Returns the port of the server. The Ring session is held only while a client is connected.
     */
    async createMuxedStreamServer(videoInputArguments: string[]): Promise<number> {
        const server = net.createServer();
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as net.AddressInfo).port;

        // the consumer must connect promptly.
        const connectTimeout = setTimeout(() => closeQuiet(server), 30000);

        server.once('connection', async client => {
            clearTimeout(connectTimeout);
            closeQuiet(server);

            let cp: ChildProcess | undefined;
            let udp: dgram.Socket | undefined;
            let lease: Lease | undefined;
            let silenceTimer: NodeJS.Timeout | undefined;
            let unsubscribe: (() => void) | undefined;
            let closed = false;
            const cleanup = () => {
                if (closed)
                    return;
                closed = true;
                clearInterval(silenceTimer);
                unsubscribe?.();
                killQuiet(cp);
                closeQuiet(udp);
                closeQuiet(client);
                lease?.release();
            };
            client.on('close', cleanup);
            client.on('error', cleanup);

            try {
                // ffmpeg is started right away so the picture is available immediately, even if
                // the Ring session takes a few seconds or fails. Until Ring audio arrives (and
                // whenever it pauses), opus silence is fed in, otherwise ffmpeg would not output anything.
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

                const args = [
                    '-hide_banner',
                    '-loglevel', 'warning',
                    ...videoInputArguments,
                    '-protocol_whitelist', 'pipe,udp,rtp,file,crypto',
                    '-thread_queue_size', '512',
                    // the codec is known from the sdp, no need to wait for probing.
                    '-analyzeduration', '0',
                    '-probesize', '32',
                    '-f', 'sdp',
                    '-i', 'pipe:0',
                    '-map', '0:v:0',
                    '-map', '1:a:0',
                    '-c:v', 'copy',
                    // opus: Rebroadcast can not pass aac from mpegts on to its rtsp server.
                    '-c:a', 'libopus',
                    '-application', 'lowdelay',
                    '-ac', '1',
                    '-ar', '48000',
                    '-b:a', '32k',
                    '-f', 'mpegts',
                    'pipe:1',
                ];

                if (closed)
                    return;
                this.console.log('starting intercom stream');
                cp = spawn(await this.getFFmpegPath(), args, {
                    stdio: ['pipe', 'pipe', 'pipe'],
                });
                cp.stderr!.on('data', data => this.console.log('[intercom-stream]', data.toString().trim()));
                cp.on('exit', code => {
                    this.console.log('intercom stream ffmpeg exited', code);
                    cleanup();
                });
                cp.stdout!.pipe(client);
                cp.stdin!.end(sdp);

                udp = dgram.createSocket('udp4');
                const sendUdp = udp;
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
                    sendUdp.send(rtp.serialize(), rtpPort, '127.0.0.1');
                };

                // fill gaps with silence, paced by the wall clock.
                silenceTimer = setInterval(() => {
                    if (Date.now() - lastRingPacket < 200)
                        return;
                    const expected = (Date.now() - startTime) * 48;
                    while (timestamp + OPUS_FRAME_SAMPLES <= expected) {
                        send(OPUS_SILENCE);
                        timestamp += OPUS_FRAME_SAMPLES;
                        lastRingTimestamp = undefined;
                    }
                }, 20);

                try {
                    lease = await this.acquire();
                }
                catch (e) {
                    this.console.error('Ring Intercom live session failed, streaming video without intercom audio', e);
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
                            this.console.warn('Ring negotiated PCMU audio, which the intercom stream does not support.');
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
                    this.console.log('Ring session ended, continuing intercom stream without audio');
                    lastRingPacket = 0;
                });
                unsubscribe = () => {
                    sub.unsubscribe();
                    ended.unsubscribe();
                };
            }
            catch (e) {
                this.console.error('intercom stream failed', e);
                cleanup();
            }
        });

        return port;
    }

    /**
     * Two way audio: send the audio of `inputArguments` (provided by Scrypted, e.g. HomeKit or WebRTC
     * microphone) to the Ring Intercom speaker.
     */
    async startTalkback(inputArguments: string[]) {
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

        const cp = spawn(await this.getFFmpegPath(), args, {
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        cp.stderr!.on('data', data => this.console.log('[talkback]', data.toString().trim()));

        const talkback = { cp, socket, lease };
        this.talkback = talkback;
        const end = () => {
            if (this.talkback === talkback)
                this.stopTalkback();
        };
        cp.on('exit', () => {
            this.console.log('two way audio ended');
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
