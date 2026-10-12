import { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import net from 'net';
import { killQuiet, spawnFFmpeg } from './ffmpeg.js';
import type { Log } from './log.js';
import type { ReolinkStream } from './reolink.js';

const TS_PACKET = 188;
const TS_SYNC = 0x47;

const STALL_TIMEOUT_MS = 15000;
const RESTART_DELAY_MS = 5000;
// consumers that fall this far behind are disconnected.
const MAX_CONSUMER_BACKLOG = 16 * 1024 * 1024;

interface Segment {
    /** wall clock time of the key frame that starts this segment. */
    time: number;
    chunks: Buffer[];
}

/**
 * Rebroadcast of a Reolink stream, similar to the Scrypted Rebroadcast plugin:
 * one connection to the camera, kept open, remuxed to MPEG-TS and held in a prebuffer
 * that starts at key frames. Every consumer (HomeKit live view, HomeKit Secure Video,
 * snapshots) gets the stream from a local tcp server, starting with a key frame, so the
 * picture is available instantly and HKSV recordings contain the seconds before the event.
 */
export class Rebroadcast extends EventEmitter {
    private cp?: ChildProcess;
    private segments: Segment[] = [];
    private pending = Buffer.alloc(0);
    private pat?: Buffer;
    private pmt?: Buffer;
    private pmtPid?: number;
    private videoPid?: number;
    private audioPid?: number;
    private consumers = new Set<net.Socket>();
    private stallTimer?: NodeJS.Timeout;
    private restartTimer?: NodeJS.Timeout;
    private idleTimer?: NodeJS.Timeout;
    private running = false;
    private connected = false;
    private keyframeWarned = false;
    private startedAt = 0;
    private lastData = 0;
    private failures = 0;

    constructor(
        public name: string,
        private getStream: () => ReolinkStream,
        private ffmpegPath: string,
        private log: Log,
        public options: {
            /** how much of the stream is kept, in ms. */
            prebufferMs: number;
            /** stop when nobody consumed the stream for this long (ms), 0: run forever. */
            idleStopMs: number;
        },
    ) {
        super();
        this.setMaxListeners(50);
    }

    get isRunning() {
        return this.running;
    }

    /** whether the stream carries (aac) audio. known once the stream is available. */
    get hasAudio() {
        return this.audioPid !== undefined;
    }

    /** time of the latest received data. */
    get lastDataTime() {
        return this.lastData;
    }

    start() {
        if (this.running)
            return;
        this.running = true;
        this.failures = 0;
        this.spawn();
    }

    stop() {
        this.running = false;
        clearTimeout(this.restartTimer);
        clearTimeout(this.idleTimer);
        clearInterval(this.stallTimer);
        this.stallTimer = undefined;
        killQuiet(this.cp);
        this.cp = undefined;
        this.reset();
        for (const consumer of this.consumers)
            consumer.destroy();
        this.consumers.clear();
    }

    private reset() {
        this.segments = [];
        this.pending = Buffer.alloc(0);
        this.pat = undefined;
        this.pmt = undefined;
        this.pmtPid = undefined;
        this.videoPid = undefined;
        this.audioPid = undefined;
        this.connected = false;
    }

    private inputArguments(stream: ReolinkStream) {
        const common = [
            '-fflags', '+genpts+discardcorrupt',
            '-probesize', '5000000',
            '-analyzeduration', '5000000',
        ];
        switch (stream.protocol) {
            case 'rtsp':
                return [
                    ...common,
                    '-rtsp_transport', 'tcp',
                    '-timeout', '10000000',
                    '-i', stream.url,
                ];
            case 'flv':
                return [
                    ...common,
                    '-rw_timeout', '10000000',
                    '-f', 'flv',
                    '-i', stream.url,
                ];
            default:
                return [
                    ...common,
                    '-rw_timeout', '10000000',
                    '-i', stream.url,
                ];
        }
    }

    private spawn() {
        clearTimeout(this.restartTimer);
        if (!this.running)
            return;
        this.reset();

        const stream = this.getStream();
        const args = [
            '-hide_banner',
            '-loglevel', 'warning',
            ...this.inputArguments(stream),
            '-map', '0:v:0',
            '-map', '0:a:0?',
            '-c:v', 'copy',
            // the camera audio is converted once here, this also smooths out the
            // audio timestamps of some Reolink firmwares.
            '-c:a', 'aac',
            '-b:a', '48k',
            '-dn', '-sn',
            '-f', 'mpegts',
            '-muxdelay', '0',
            '-muxpreload', '0',
            '-flush_packets', '1',
            'pipe:1',
        ];

        this.log.debug(`${this.name}: connecting (${stream.protocol})`);
        const cp = spawnFFmpeg(this.ffmpegPath, args, {
            name: this.name,
            log: this.log,
        });
        this.cp = cp;
        this.startedAt = Date.now();
        this.lastData = 0;

        cp.stdout!.on('data', (data: Buffer) => {
            if (this.cp !== cp)
                return;
            this.lastData = Date.now();
            if (!this.connected) {
                this.connected = true;
                if (this.failures)
                    this.log.log(`${this.name}: connected again`);
                else
                    this.log.log(`${this.name}: connected`);
                this.failures = 0;
            }
            this.onData(data);
        });

        cp.on('exit', code => {
            if (this.cp !== cp)
                return;
            this.cp = undefined;
            this.restart(`ffmpeg exited (${code})`);
        });

        clearInterval(this.stallTimer);
        this.stallTimer = setInterval(() => {
            if (this.cp !== cp)
                return;
            const last = this.lastData || this.startedAt;
            if (Date.now() - last > STALL_TIMEOUT_MS) {
                killQuiet(cp);
                this.cp = undefined;
                this.restart('no data from the camera');
            }
        }, 2000);
    }

    private restart(reason: string) {
        clearInterval(this.stallTimer);
        this.stallTimer = undefined;
        if (!this.running)
            return;
        this.failures++;
        // only log the first failure of a series, a camera reboot would otherwise spam the log.
        if (this.failures === 1)
            this.log.warn(`${this.name}: stream interrupted (${reason}), reconnecting`);
        else if (this.failures === 10)
            this.log.error(`${this.name}: the camera stream keeps failing (${reason}). Check host, user, password and the stream protocol.`);
        for (const consumer of this.consumers)
            consumer.destroy();
        this.consumers.clear();
        this.reset();
        clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => this.spawn(), Math.min(RESTART_DELAY_MS * this.failures, 30000));
    }

    private onData(data: Buffer) {
        let buffer = this.pending.length ? Buffer.concat([this.pending, data]) : data;
        let offset = 0;

        // keep the packets aligned.
        while (offset < buffer.length && buffer[offset] !== TS_SYNC)
            offset++;

        let runStart = offset;
        while (offset + TS_PACKET <= buffer.length) {
            if (buffer[offset] !== TS_SYNC) {
                // lost sync: flush what we have and resync.
                this.push(buffer.subarray(runStart, offset));
                while (offset < buffer.length && buffer[offset] !== TS_SYNC)
                    offset++;
                runStart = offset;
                continue;
            }
            const packet = buffer.subarray(offset, offset + TS_PACKET);
            if (this.inspect(packet)) {
                // a key frame starts with this packet, it starts a new segment.
                this.push(buffer.subarray(runStart, offset));
                runStart = offset;
                this.startSegment();
            }
            offset += TS_PACKET;
        }
        this.push(buffer.subarray(runStart, offset));
        this.pending = Buffer.from(buffer.subarray(offset));
    }

    /**
     * Tracks PAT/PMT and returns true if the packet starts a video key frame.
     */
    private inspect(packet: Buffer): boolean {
        const pid = ((packet[1] & 0x1F) << 8) | packet[2];
        const payloadUnitStart = !!(packet[1] & 0x40);
        const adaptation = (packet[3] >> 4) & 0x3;

        if (pid === 0 && payloadUnitStart) {
            this.pat = Buffer.from(packet);
            const start = this.payloadOffset(packet);
            if (start === undefined)
                return false;
            const section = start + 1 + packet[start];
            // first program entry (skip program 0 = network pid).
            const sectionLength = ((packet[section + 1] & 0x0F) << 8) | packet[section + 2];
            const end = Math.min(section + 3 + sectionLength - 4, TS_PACKET);
            for (let i = section + 8; i + 4 <= end; i += 4) {
                const program = (packet[i] << 8) | packet[i + 1];
                if (program !== 0) {
                    this.pmtPid = ((packet[i + 2] & 0x1F) << 8) | packet[i + 3];
                    break;
                }
            }
            return false;
        }

        if (pid === this.pmtPid && payloadUnitStart) {
            this.pmt = Buffer.from(packet);
            const start = this.payloadOffset(packet);
            if (start === undefined)
                return false;
            const section = start + 1 + packet[start];
            const sectionLength = ((packet[section + 1] & 0x0F) << 8) | packet[section + 2];
            const programInfoLength = ((packet[section + 10] & 0x0F) << 8) | packet[section + 11];
            const end = Math.min(section + 3 + sectionLength - 4, TS_PACKET);
            for (let i = section + 12 + programInfoLength; i + 5 <= end;) {
                const streamType = packet[i];
                const elementaryPid = ((packet[i + 1] & 0x1F) << 8) | packet[i + 2];
                const esInfoLength = ((packet[i + 3] & 0x0F) << 8) | packet[i + 4];
                // h264 / h265
                if (streamType === 0x1B || streamType === 0x24)
                    this.videoPid = elementaryPid;
                // aac (adts)
                else if (streamType === 0x0F)
                    this.audioPid = elementaryPid;
                i += 5 + esInfoLength;
            }
            return false;
        }

        if (pid !== this.videoPid || !payloadUnitStart)
            return false;

        // ffmpeg marks key frames with the random access indicator.
        if (adaptation & 0x2 && packet[4] > 0)
            return !!(packet[5] & 0x40);
        return false;
    }

    private payloadOffset(packet: Buffer): number | undefined {
        const adaptation = (packet[3] >> 4) & 0x3;
        if (!(adaptation & 0x1))
            return undefined;
        let offset = 4;
        if (adaptation & 0x2)
            offset += 1 + packet[4];
        return offset < TS_PACKET ? offset : undefined;
    }

    private startSegment() {
        const now = Date.now();
        this.segments.push({ time: now, chunks: [] });
        this.keyframeWarned = false;
        // drop old segments, but always keep the one that covers the prebuffer start.
        const cutoff = now - this.options.prebufferMs;
        while (this.segments.length > 2 && this.segments[1].time <= cutoff)
            this.segments.shift();
    }

    private push(data: Buffer) {
        if (!data.length)
            return;
        const segment = this.segments[this.segments.length - 1];
        if (segment) {
            segment.chunks.push(data);
        }
        else if (!this.keyframeWarned && this.startedAt && Date.now() - this.startedAt > 15000) {
            this.keyframeWarned = true;
            this.log.warn(`${this.name}: no key frame received for 15 seconds. Set the I-frame interval of the camera to 1x or 2x the frame rate.`);
        }
        for (const consumer of this.consumers) {
            if (consumer.writableLength > MAX_CONSUMER_BACKLOG) {
                this.log.warn(`${this.name}: a consumer is too slow and was disconnected`);
                consumer.destroy();
                continue;
            }
            consumer.write(data);
        }
    }

    /**
     * Waits until the stream is available (connected and a key frame was received).
     */
    async waitForKeyframe(timeoutMs = 15000) {
        this.touch();
        if (this.segments.length)
            return;
        const start = Date.now();
        while (!this.segments.length) {
            if (!this.running)
                throw new Error(`${this.name} is not running`);
            if (Date.now() - start > timeoutMs)
                throw new Error(`${this.name}: no picture from the camera`);
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    private touch() {
        this.start();
        clearTimeout(this.idleTimer);
        if (this.options.idleStopMs && !this.consumers.size) {
            this.idleTimer = setTimeout(() => {
                if (!this.consumers.size)
                    this.stop();
            }, this.options.idleStopMs);
        }
    }

    /**
     * Writes the stream to the socket, starting with the latest key frame that is at least
     * `prebufferMs` old (or the oldest available), followed by the live stream.
     */
    attach(socket: net.Socket, prebufferMs = 0) {
        clearTimeout(this.idleTimer);
        const target = Date.now() - prebufferMs;
        let index = this.segments.length - 1;
        while (index > 0 && this.segments[index].time > target)
            index--;

        if (this.pat)
            socket.write(this.pat);
        if (this.pmt)
            socket.write(this.pmt);
        for (const segment of this.segments.slice(Math.max(index, 0))) {
            for (const chunk of segment.chunks)
                socket.write(chunk);
        }

        this.consumers.add(socket);
        const detach = () => {
            this.consumers.delete(socket);
            this.touch();
        };
        socket.once('close', detach);
        socket.once('error', detach);
    }

    /**
     * Creates a single use local tcp server serving the stream as MPEG-TS.
     * Returns ffmpeg input arguments to read it.
     */
    async createInput(prebufferMs = 0): Promise<{ inputArguments: string[], url: string }> {
        await this.waitForKeyframe();
        const server = net.createServer();
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as net.AddressInfo).port;
        const timeout = setTimeout(() => server.close(), 30000);
        server.once('connection', socket => {
            clearTimeout(timeout);
            server.close();
            socket.setNoDelay(true);
            socket.on('error', () => { });
            this.attach(socket, prebufferMs);
        });
        const url = `tcp://127.0.0.1:${port}`;
        return {
            url,
            inputArguments: [
                '-f', 'mpegts',
                '-i', url,
            ],
        };
    }
}
