import sdk, { Battery, BinarySensor, Camera, FFmpegInput, Intercom, MediaObject, MotionSensor, RequestMediaStreamOptions, RequestPictureOptions, ResponseMediaStreamOptions, ResponsePictureOptions, ScryptedDeviceBase, ScryptedInterface, ScryptedMimeTypes, Setting, Settings, SettingValue, VideoCamera } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import type { RingIntercom } from 'ring-client-api';
import type RingIntercomCameraPlugin from './main';
import { ReolinkClient, ReolinkEncoderStream, ReolinkRtspPath } from './reolink';
import { RingIntercomAudio } from './ring-audio';

const { mediaManager } = sdk;

export const INTERCOM_STREAM_ID = 'ring-intercom';
const DING_RESET_MS = 10000;
const MOTION_POLL_MS = 2000;

export class RingIntercomCamera extends ScryptedDeviceBase implements VideoCamera, Camera, Intercom, BinarySensor, MotionSensor, Battery, Settings {
    audio: RingIntercomAudio;
    private dingTimeout?: NodeJS.Timeout;
    private reolink?: ReolinkClient;
    private encoderConfig?: Promise<{ main?: ReolinkEncoderStream, sub?: ReolinkEncoderStream } | undefined>;
    private cameraMotion = false;
    private dingMotion = false;
    private dingMotionTimeout?: NodeJS.Timeout;
    private motionPoll?: NodeJS.Timeout;
    private motionPollFailed = false;

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
            defaultValue: '<p>Um im Livebild die Türsprechstelle zu hören: unter <b>Extensions → Rebroadcast</b> bei <i>Local Stream</i> und <i>Remote Stream</i> den Stream <b>Kamera + Ring Intercom Audio</b> wählen. <i>Remote Recording Stream</i> (HomeKit Secure Video) und <i>Local Recording Stream</i> müssen ein Kamera-Stream bleiben.</p>',
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
        this.updateBattery();
        intercom.onBatteryLevel.subscribe(() => this.updateBattery());

        intercom.onDing.subscribe(() => {
            this.console.log('Ring Intercom ding');
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

    updateBattery() {
        const level = this.intercom.batteryLevel;
        if (level != null)
            this.batteryLevel = level;
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
            // the intercom reports a battery, but the camera is mains powered: allow prebuffering.
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
                codec: 'aac',
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

        const port = await this.audio.createMuxedStreamServer(videoInputArguments);
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

    // Intercom (two way audio) via Ring
    async startIntercom(media: MediaObject): Promise<void> {
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
        clearTimeout(this.dingTimeout);
        clearTimeout(this.dingMotionTimeout);
        this.stopMotion();
        this.audio.stop();
    }
}
