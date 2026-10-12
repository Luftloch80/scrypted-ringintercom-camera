import { ChildProcess, spawn } from 'child_process';
import net from 'net';
import sdk, { BinarySensor, Camera, FFmpegInput, Intercom, MediaObject, MotionSensor, RequestMediaStreamOptions, RequestPictureOptions, ResponseMediaStreamOptions, ResponsePictureOptions, ScryptedDeviceBase, ScryptedInterface, ScryptedMimeTypes, Setting, Settings, SettingValue, VideoCamera } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import type { RingIntercom } from 'ring-client-api';
import type RingIntercomCameraPlugin from './main';
import { ReolinkClient, ReolinkEncoderStream, ReolinkRtspPath } from './reolink';
import { RingIntercomAudio } from './ring-audio';

const { mediaManager } = sdk;

export const INTERCOM_STREAM_ID = 'ring-intercom';
const DING_RESET_MS = 10000;
const MOTION_POLL_MS = 2000;

export class RingIntercomCamera extends ScryptedDeviceBase implements VideoCamera, Camera, Intercom, BinarySensor, MotionSensor, Settings {
    audio: RingIntercomAudio;
    private dingTimeout?: NodeJS.Timeout;
    private reolink?: ReolinkClient;
    private encoderConfig?: Promise<{ main?: ReolinkEncoderStream, sub?: ReolinkEncoderStream } | undefined>;
    private cameraMotion = false;
    private dingMotion = false;
    private dingMotionTimeout?: NodeJS.Timeout;
    private motionPoll?: NodeJS.Timeout;
    private motionPollFailed = false;
    private lastDing = 0;
    // streams with camera audio, ended when someone rings so the next live view uses the intercom.
    private cameraAudioStreams = new Set<() => void>();

    storageSettings = new StorageSettings(this, {
        reolinkHost: {
            group: 'Reolink',
            title: 'IP-Adresse',
            description: 'IP-Adresse (optional mit HTTP-Port, z. B. 192.168.1.50:80) der Reolink-Kamera.',
            placeholder: '192.168.1.50',
            onPut: () => this.resetVideoSource(),
        },
        reolinkUsername: {
            group: 'Reolink',
            title: 'Benutzername',
            defaultValue: 'admin',
            onPut: () => this.resetVideoSource(),
        },
        reolinkPassword: {
            group: 'Reolink',
            title: 'Passwort',
            type: 'password',
            onPut: () => this.resetVideoSource(),
        },
        reolinkChannel: {
            group: 'Reolink',
            title: 'Kanal',
            description: '0 für Einzelkameras. Bei NVR/Home Hub der Kanal der Kamera (0-basiert).',
            type: 'number',
            defaultValue: 0,
            onPut: () => this.resetVideoSource(),
        },
        reolinkRtspPort: {
            group: 'Reolink',
            title: 'RTSP-Port',
            type: 'number',
            defaultValue: 554,
            onPut: () => this.resetVideoSource(),
        },
        reolinkRtspPath: {
            group: 'Reolink',
            title: 'RTSP-Pfad',
            description: 'h264Preview funktioniert bei den meisten Modellen. Für 4K/H.265-Kameras h265Preview wählen.',
            choices: ['h264Preview', 'h265Preview', 'Preview'],
            defaultValue: 'h264Preview',
            onPut: () => this.resetVideoSource(),
        },
        reolinkHttps: {
            group: 'Reolink',
            title: 'HTTPS für Snapshots',
            type: 'boolean',
            defaultValue: false,
            onPut: () => this.resetVideoSource(),
        },
        intercomStreamInfo: {
            group: 'Intercom',
            title: 'Intercom-Audio im Livebild',
            type: 'html',
            readonly: true,
            defaultValue: '<p>Damit das Livebild den Intercom nutzt: unter <b>Extensions → Rebroadcast</b> bei <i>Local Stream</i> und <i>Remote Stream</i> den Stream <b>Kamera + Ring Intercom Audio</b> wählen. <i>Remote Recording Stream</i> (HomeKit Secure Video) und <i>Local Recording Stream</i> müssen ein Kamera-Stream bleiben.</p><p>Nach einem Klingeln laufen Ton und Sprechen für die eingestellte Zeit über den Ring Intercom, sonst kommt der Ton von der Kamera und Sprechen ist aus.</p>',
        },
        intercomWindowMinutes: {
            group: 'Intercom',
            title: 'Intercom nach dem Klingeln aktiv (Minuten)',
            description: 'So lange nach einem Klingeln laufen Ton und Sprechen über den Ring Intercom. Danach kommt der Ton im Livebild von der Kamera und Sprechen ist aus. 0 = Intercom immer aktiv.',
            type: 'number',
            defaultValue: 5,
        },
        intercomStreamBase: {
            group: 'Intercom',
            title: 'Video für Intercom-Stream',
            description: 'Welcher Kamera-Stream mit dem Intercom-Audio kombiniert wird.',
            choices: ['Main', 'Sub'],
            defaultValue: 'Main',
            onPut: () => this.onDeviceEvent(ScryptedInterface.VideoCamera, undefined),
        },
        motionSource: {
            group: 'Bewegung (HomeKit Secure Video)',
            title: 'Bewegungserkennung',
            description: 'Bewegungen der Kamera an das Gerät weitergeben. Wird für HomeKit Secure Video benötigt.',
            choices: ['Kamera', 'Aus'],
            defaultValue: 'Kamera',
            onPut: () => this.startMotion(),
        },
        dingTriggersMotion: {
            group: 'Bewegung (HomeKit Secure Video)',
            title: 'Klingeln löst Bewegung aus',
            description: 'Beim Klingeln wird auch eine Bewegung gemeldet, damit HomeKit Secure Video eine Aufnahme startet.',
            type: 'boolean',
            defaultValue: true,
        },
        dingResetSeconds: {
            group: 'Intercom',
            title: 'Klingel-Dauer (Sekunden)',
            description: 'Wie lange das Klingel-Ereignis aktiv bleibt.',
            type: 'number',
            defaultValue: DING_RESET_MS / 1000,
        },
    });

    constructor(public plugin: RingIntercomCameraPlugin, nativeId: string, public intercom: RingIntercom) {
        super(nativeId);

        this.audio = new RingIntercomAudio(() => plugin.api!, intercom, () => mediaManager.getFFmpegPath(), this.console);

        this.binaryState = false;

        intercom.onDing.subscribe(() => {
            this.lastDing = Date.now();
            const minutes = this.intercomWindowMinutes;
            this.console.log('Ring Intercom ding' + (minutes > 0 ? `, intercom audio active for ${minutes} minutes` : ''));
            // a live view with camera audio may still be open (or kept by Rebroadcast): end it,
            // the next one is started with the intercom audio.
            for (const end of [...this.cameraAudioStreams])
                end();
            this.binaryState = true;
            clearTimeout(this.dingTimeout);
            const seconds = parseFloat(this.storageSettings.values.dingResetSeconds) || DING_RESET_MS / 1000;
            this.dingTimeout = setTimeout(() => this.binaryState = false, seconds * 1000);

            if (this.storageSettings.values.dingTriggersMotion) {
                this.dingMotion = true;
                this.updateMotion();
                clearTimeout(this.dingMotionTimeout);
                this.dingMotionTimeout = setTimeout(() => {
                    this.dingMotion = false;
                    this.updateMotion();
                }, Math.max(seconds, 10) * 1000);
            }
        });

        this.motionDetected = false;
        this.startMotion();
    }

    private updateMotion() {
        const motion = this.cameraMotion || this.dingMotion;
        if (this.motionDetected !== motion)
            this.motionDetected = motion;
    }

    private stopMotion() {
        clearInterval(this.motionPoll);
        this.motionPoll = undefined;
        this.cameraMotion = false;
        this.updateMotion();
    }

    startMotion() {
        this.stopMotion();
        if (this.storageSettings.values.motionSource === 'Aus')
            return;

        if (!this.storageSettings.values.reolinkHost)
            return;
        this.motionPoll = setInterval(async () => {
            try {
                this.cameraMotion = await this.getReolink().getMotionState();
                if (this.motionPollFailed)
                    this.console.log('Reolink motion state available again');
                this.motionPollFailed = false;
            }
            catch (e) {
                if (!this.motionPollFailed)
                    this.console.warn('Reolink motion state unavailable', (e as Error).message);
                this.motionPollFailed = true;
                this.cameraMotion = false;
            }
            this.updateMotion();
        }, MOTION_POLL_MS);
    }

    resetVideoSource() {
        this.reolink = undefined;
        this.encoderConfig = undefined;
        this.startMotion();
        this.onDeviceEvent(ScryptedInterface.VideoCamera, undefined);
    }

    getReolink() {
        if (!this.reolink) {
            const v = this.storageSettings.values;
            if (!v.reolinkHost)
                throw new Error('Bitte die IP-Adresse der Reolink-Kamera in den Einstellungen eintragen.');
            this.reolink = new ReolinkClient({
                host: v.reolinkHost,
                username: v.reolinkUsername,
                password: v.reolinkPassword,
                channel: parseInt(v.reolinkChannel) || 0,
                rtspPort: parseInt(v.reolinkRtspPort) || 554,
                rtspPath: v.reolinkRtspPath as ReolinkRtspPath,
                https: !!v.reolinkHttps,
            }, this.console);
        }
        return this.reolink;
    }

    getSettings(): Promise<Setting[]> {
        return this.storageSettings.getSettings();
    }

    putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
    }

    // Camera (snapshots come from the video camera, the intercom has none).
    async takePicture(options?: RequestPictureOptions): Promise<MediaObject> {
        const jpeg = await this.getReolink().jpegSnapshot(options?.timeout);
        return this.createMediaObject(jpeg, 'image/jpeg');
    }

    async getPictureOptions(): Promise<ResponsePictureOptions[]> {
        return [];
    }

    // VideoCamera
    private async getReolinkEncoderConfig() {
        if (!this.encoderConfig) {
            const reolink = this.getReolink();
            this.encoderConfig = reolink.getEncoderConfiguration().catch(e => {
                this.console.warn('unable to read Reolink stream resolutions', (e as Error).message);
                // retry on the next request.
                this.encoderConfig = undefined;
                return undefined;
            });
        }
        return this.encoderConfig;
    }

    private async getSourceStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        const streams = this.getReolink().getStreams();
        const enc = await this.getReolinkEncoderConfig();
        return streams.map(stream => ({
            id: stream.id,
            name: stream.name,
            container: 'rtsp',
            tool: 'scrypted',
            video: {
                codec: this.storageSettings.values.reolinkRtspPath === 'h265Preview' && stream.id === 'main' ? 'h265' : 'h264',
                // the resolutions let Rebroadcast pick the right stream for each destination.
                width: enc?.[stream.id]?.width,
                height: enc?.[stream.id]?.height,
            },
            audio: {},
            destinations: stream.id === 'main' ? ['local', 'local-recorder'] : ['remote', 'remote-recorder', 'low-resolution'],
            allowBatteryPrebuffer: true,
        }));
    }

    async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        let source: ResponseMediaStreamOptions[] = [];
        try {
            source = await this.getSourceStreamOptions();
        }
        catch (e) {
            this.console.warn((e as Error).message);
        }

        const intercomStream: ResponseMediaStreamOptions = {
            id: INTERCOM_STREAM_ID,
            name: 'Kamera + Ring Intercom Audio',
            container: 'mpegts',
            tool: 'ffmpeg',
            video: {
                // no resolution on purpose: Rebroadcast then never picks this stream automatically
                // (e.g. for HomeKit Secure Video), it has to be selected explicitly.
                codec: source.find(s => s.id === this.getIntercomBaseStreamId(source))?.video?.codec,
            },
            audio: {
                // opus: Rebroadcast can not pass aac from mpegts on to its rtsp server.
                codec: 'opus',
            },
            // no prebuffering: the stream holds a Ring live session while it is in use.
            allowBatteryPrebuffer: false,
        };

        // the intercom stream is always last, so it is never the default stream.
        return [...source, intercomStream];
    }

    private getIntercomBaseStreamId(source: ResponseMediaStreamOptions[]) {
        if (!source.length)
            return undefined;
        if (this.storageSettings.values.intercomStreamBase === 'Sub')
            return (source[1] || source[0]).id;
        return source[0].id;
    }

    private async getSourceVideoStream(options?: RequestMediaStreamOptions): Promise<MediaObject> {
        const streams = this.getReolink().getStreams();
        const stream = streams.find(s => s.id === options?.id) || streams[0];
        const vsos = await this.getSourceStreamOptions();
        const mediaStreamOptions = vsos.find(v => v.id === stream.id)!;
        const ffmpegInput: FFmpegInput = {
            url: stream.url,
            container: 'rtsp',
            mediaStreamOptions,
            inputArguments: [
                '-rtsp_transport', 'tcp',
                '-i', stream.url,
            ],
        };
        return mediaManager.createFFmpegMediaObject(ffmpegInput);
    }

    async getVideoStream(options?: RequestMediaStreamOptions): Promise<MediaObject> {
        const vsos = await this.getVideoStreamOptions();
        const id = options?.id || vsos[0]?.id;
        this.console.log('video stream requested', id);

        if (id !== INTERCOM_STREAM_ID)
            return this.getSourceVideoStream({ ...options, id });

        const source = vsos.filter(v => v.id !== INTERCOM_STREAM_ID);
        const baseId = this.getIntercomBaseStreamId(source);
        if (!baseId)
            throw new Error('Keine Bildquelle konfiguriert.');
        const base = await this.getSourceVideoStream({ id: baseId });
        const baseInput = await mediaManager.convertMediaObjectToJSON<FFmpegInput>(base, ScryptedMimeTypes.FFmpegInput);
        const videoInputArguments = baseInput.inputArguments?.length
            ? baseInput.inputArguments
            : ['-i', baseInput.url!];

        let port: number;
        if (this.intercomActive) {
            this.console.log('live view with Ring Intercom audio');
            port = await this.audio.createMuxedStreamServer(videoInputArguments);
        }
        else {
            this.console.log('live view with camera audio (no recent ding)');
            port = await this.createCameraAudioStreamServer(videoInputArguments);
        }
        const url = `tcp://127.0.0.1:${port}`;
        const ffmpegInput: FFmpegInput = {
            url,
            container: 'mpegts',
            mediaStreamOptions: vsos.find(v => v.id === INTERCOM_STREAM_ID),
            inputArguments: [
                '-f', 'mpegts',
                '-i', url,
            ],
        };
        return mediaManager.createFFmpegMediaObject(ffmpegInput);
    }

    private get intercomWindowMinutes() {
        const minutes = parseFloat(this.storageSettings.values.intercomWindowMinutes);
        return Number.isFinite(minutes) ? minutes : 5;
    }

    /**
     * Whether the Ring Intercom is used for audio and talking right now.
     */
    get intercomActive() {
        const minutes = this.intercomWindowMinutes;
        if (minutes <= 0)
            return true;
        return Date.now() - this.lastDing < minutes * 60 * 1000;
    }

    /**
     * The intercom stream outside of the intercom window: the camera video and audio,
     * in the same format (mpegts, aac) as the stream with the intercom audio.
     */
    private async createCameraAudioStreamServer(videoInputArguments: string[]): Promise<number> {
        const server = net.createServer();
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as net.AddressInfo).port;
        const connectTimeout = setTimeout(() => server.close(), 30000);
        const ffmpegPath = await mediaManager.getFFmpegPath();

        server.once('connection', client => {
            clearTimeout(connectTimeout);
            server.close();

            let cp: ChildProcess | undefined;
            const end = () => {
                this.cameraAudioStreams.delete(end);
                try {
                    cp?.kill('SIGKILL');
                }
                catch (e) {
                }
                client.destroy();
            };
            this.cameraAudioStreams.add(end);
            client.on('close', end);
            client.on('error', end);

            cp = spawn(ffmpegPath, [
                '-hide_banner',
                '-loglevel', 'warning',
                ...videoInputArguments,
                '-map', '0:v:0',
                '-map', '0:a:0?',
                '-c:v', 'copy',
                // opus: Rebroadcast can not pass aac from mpegts on to its rtsp server.
                '-c:a', 'libopus',
                '-application', 'lowdelay',
                '-ac', '1',
                '-ar', '48000',
                '-b:a', '32k',
                '-f', 'mpegts',
                'pipe:1',
            ], {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            cp.stderr!.on('data', data => this.console.log('[camera-stream]', data.toString().trim()));
            cp.on('exit', end);
            cp.stdout!.pipe(client);
        });

        return port;
    }

    // Intercom (two way audio) via Ring
    async startIntercom(media: MediaObject): Promise<void> {
        if (!this.intercomActive) {
            this.console.log(`two way audio ignored: the intercom is only active for ${this.intercomWindowMinutes} minutes after a ding`);
            return;
        }
        const ffmpegInput = await mediaManager.convertMediaObjectToJSON<FFmpegInput>(media, ScryptedMimeTypes.FFmpegInput);
        const inputArguments = ffmpegInput.inputArguments?.length
            ? ffmpegInput.inputArguments
            : ['-i', ffmpegInput.url!];
        await this.audio.startTalkback(inputArguments);
    }

    async stopIntercom(): Promise<void> {
        this.audio.stopTalkback();
    }

    release() {
        for (const end of [...this.cameraAudioStreams])
            end();
        clearTimeout(this.dingTimeout);
        clearTimeout(this.dingMotionTimeout);
        this.stopMotion();
        this.audio.stop();
    }
}
