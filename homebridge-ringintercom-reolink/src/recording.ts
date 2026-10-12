import type { ChildProcess } from 'child_process';
import type { Readable } from 'stream';
import type {
    API,
    CameraController,
    CameraRecordingConfiguration,
    CameraRecordingDelegate,
    HDSProtocolSpecificErrorReason,
    RecordingPacket,
} from 'homebridge';
import { killQuiet, spawnFFmpeg } from './ffmpeg.js';
import type { Log } from './log.js';
import type { Rebroadcast } from './rebroadcast.js';

// AudioRecordingSamplerate -> Hz
const SAMPLE_RATES = [8000, 16000, 24000, 32000, 44100, 48000];
// safety net, HomeKit normally closes the recording itself once the event is over.
const MAX_RECORDING_MS = 5 * 60 * 1000;

interface Mp4Box {
    type: string;
    data: Buffer;
}

/**
 * Splits an mp4 byte stream into its top level boxes.
 */
async function* readBoxes(readable: Readable): AsyncGenerator<Mp4Box> {
    let pending: Buffer = Buffer.alloc(0);
    for await (const chunk of readable) {
        pending = pending.length ? Buffer.concat([pending, chunk as Buffer]) : chunk as Buffer;
        while (pending.length >= 8) {
            let size = pending.readUInt32BE(0);
            let header = 8;
            if (size === 1) {
                if (pending.length < 16)
                    break;
                size = Number(pending.readBigUInt64BE(8));
                header = 16;
            }
            if (size < header)
                throw new Error(`invalid mp4 box size ${size}`);
            if (pending.length < size)
                break;
            const type = pending.toString('latin1', 4, 8);
            yield { type, data: pending.subarray(0, size) };
            pending = pending.subarray(size);
        }
    }
}

/**
 * HomeKit Secure Video: the recording is taken from the rebroadcast prebuffer (the
 * seconds before the event plus the live stream), the video is copied, the audio is
 * converted to the AAC configuration HomeKit selected, and the result is sent as
 * fragmented mp4 (one fragment per key frame).
 */
export class RecordingDelegate implements CameraRecordingDelegate {
    controller?: CameraController;
    private active = false;
    private configuration?: CameraRecordingConfiguration;
    private current?: { cp: ChildProcess, closed: boolean };

    constructor(
        private api: API,
        private log: Log,
        private options: {
            ffmpegPath: string;
            getRebroadcast: () => Rebroadcast;
            onActiveChanged?: (active: boolean) => void;
        },
    ) {
    }

    get isActive() {
        return this.active;
    }

    updateRecordingActive(active: boolean): void {
        if (this.active !== active)
            this.log.log(`HomeKit Secure Video ${active ? 'enabled' : 'disabled'}`);
        this.active = active;
        this.options.onActiveChanged?.(active);
    }

    updateRecordingConfiguration(configuration: CameraRecordingConfiguration | undefined): void {
        this.configuration = configuration;
        if (configuration) {
            const { resolution } = configuration.videoCodec;
            this.log.debug(`HomeKit Secure Video configuration: ${resolution[0]}x${resolution[1]}@${resolution[2]}, `
                + `prebuffer ${configuration.prebufferLength}ms, fragments ${configuration.mediaContainerConfiguration.fragmentLength}ms`);
        }
    }

    private get audioActive(): boolean {
        const service = this.controller?.recordingManagement?.operatingModeService;
        if (!service)
            return true;
        const value = service.getCharacteristic(this.api.hap.Characteristic.RecordingAudioActive).value;
        return value === undefined || value === null || !!value;
    }

    async *handleRecordingStreamRequest(streamId: number, signal?: AbortSignal): AsyncGenerator<RecordingPacket> {
        const configuration = this.configuration;
        if (!configuration)
            throw new Error('no recording configuration');

        const rebroadcast = this.options.getRebroadcast();
        const input = await rebroadcast.createInput(configuration.prebufferLength);

        const args = [
            '-hide_banner',
            '-loglevel', 'warning',
            '-fflags', '+genpts',
            '-probesize', '2000000',
            '-analyzeduration', '2000000',
            ...input.inputArguments,
            '-map', '0:v:0',
            '-c:v', 'copy',
        ];

        if (this.audioActive && rebroadcast.hasAudio) {
            const { audioCodec } = configuration;
            const sampleRate = SAMPLE_RATES[audioCodec.samplerate] || 16000;
            args.push(
                '-map', '0:a:0',
                '-c:a', 'aac',
                '-profile:a', 'aac_low',
                '-ar', sampleRate.toString(),
                '-ac', (audioCodec.audioChannels || 1).toString(),
                '-b:a', `${audioCodec.bitrate || 32}k`,
            );
        }

        args.push(
            '-f', 'mp4',
            '-movflags', 'frag_keyframe+empty_moov+default_base_moof+skip_sidx+skip_trailer',
            'pipe:1',
        );

        this.log.log('HomeKit Secure Video recording started');
        const cp = spawnFFmpeg(this.options.ffmpegPath, args, {
            name: 'recording',
            log: this.log,
        });
        const current = { cp, closed: false };
        this.current = current;

        const abort = () => {
            current.closed = true;
            killQuiet(cp);
        };
        signal?.addEventListener('abort', abort);
        const maxDuration = setTimeout(() => {
            this.log.log('HomeKit Secure Video recording reached the maximum duration');
            killQuiet(cp);
        }, MAX_RECORDING_MS);

        let init: Buffer[] = [];
        let fragment: Buffer[] = [];
        let held: Buffer | undefined;
        let fragments = 0;

        try {
            for await (const box of readBoxes(cp.stdout!)) {
                if (current.closed)
                    return;

                if (box.type === 'ftyp' || box.type === 'moov') {
                    init.push(box.data);
                    if (box.type === 'moov') {
                        yield { data: Buffer.concat(init), isLast: false };
                        init = [];
                    }
                    continue;
                }

                fragment.push(box.data);
                if (box.type !== 'mdat')
                    continue;

                // a fragment is complete (moof + mdat). The previous one is sent now, the
                // latest is held back so the final fragment can be marked as the last one.
                const data = Buffer.concat(fragment);
                fragment = [];
                if (held) {
                    fragments++;
                    yield { data: held, isLast: false };
                }
                held = data;
            }

            if (!current.closed && held) {
                fragments++;
                yield { data: held, isLast: true };
            }
        }
        finally {
            clearTimeout(maxDuration);
            signal?.removeEventListener('abort', abort);
            killQuiet(cp);
            if (this.current === current)
                this.current = undefined;
            this.log.log(`HomeKit Secure Video recording ended (${fragments} fragments)`);
        }
    }

    acknowledgeStream(streamId: number): void {
        this.log.debug('HomeKit acknowledged the recording', streamId);
    }

    closeRecordingStream(streamId: number, reason: HDSProtocolSpecificErrorReason | undefined): void {
        if (reason !== undefined && reason !== this.api.hap.HDSProtocolSpecificErrorReason.NORMAL)
            this.log.warn(`HomeKit closed the recording (reason ${reason})`);
        const current = this.current;
        if (current) {
            current.closed = true;
            killQuiet(current.cp);
        }
    }

    stop() {
        if (this.current) {
            this.current.closed = true;
            killQuiet(this.current.cp);
        }
    }
}
