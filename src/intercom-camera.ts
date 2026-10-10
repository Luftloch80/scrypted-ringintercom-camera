import sdk, { Battery, BinarySensor, Camera, FFmpegInput, Intercom, MediaObject, RequestMediaStreamOptions, RequestPictureOptions, ResponseMediaStreamOptions, ResponsePictureOptions, ScryptedDeviceBase, ScryptedInterface, ScryptedMimeTypes, Setting, Settings, SettingValue, VideoCamera } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import type { RingIntercom } from 'ring-client-api';
import type RingIntercomCameraPlugin from './main';
import { ReolinkClient, ReolinkRtspPath } from './reolink';
import { RingIntercomAudio } from './ring-audio';

const { mediaManager, systemManager } = sdk;

export const INTERCOM_STREAM_ID = 'ring-intercom';
const DING_RESET_MS = 10000;

export class RingIntercomCamera extends ScryptedDeviceBase implements VideoCamera, Camera, Intercom, BinarySensor, Battery, Settings {
    audio: RingIntercomAudio;
    private dingTimeout?: NodeJS.Timeout;
    private reolink?: ReolinkClient;

    storageSettings = new StorageSettings(this, {
        videoSource: {
            title: 'Bildquelle',
            description: 'Woher das Kamerabild kommt: direkt von der Reolink-Kamera (IP/Login) oder von einer Kamera, die bereits in Scrypted eingebunden ist (z. B. über das Reolink-Plugin).',
            choices: ['Reolink', 'Scrypted Kamera'],
            defaultValue: 'Reolink',
            immediate: true,
            onPut: () => this.resetVideoSource(),
        },
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
        scryptedCamera: {
            group: 'Scrypted Kamera',
            title: 'Kamera',
            description: 'Vorhandene Scrypted-Kamera, deren Bild verwendet werden soll.',
            type: 'device',
            deviceFilter: ({ id, interfaces }) => id !== this.id && interfaces.includes(ScryptedInterface.VideoCamera),
            onPut: () => this.resetVideoSource(),
        },
        intercomStreamFirst: {
            group: 'Intercom',
            title: 'Intercom-Audio als Standard-Stream',
            description: 'Wenn aktiv, ist der Stream "Kamera + Ring Intercom Audio" der Standard-Stream. Dann hört man im Livebild die Türsprechstelle (startet jedes Mal eine Ring-Sitzung). Sonst wird das Audio der Kamera verwendet und der Intercom-Stream muss explizit ausgewählt werden.',
            type: 'boolean',
            defaultValue: false,
            onPut: () => this.onDeviceEvent(ScryptedInterface.VideoCamera, undefined),
        },
        intercomStreamBase: {
            group: 'Intercom',
            title: 'Video für Intercom-Stream',
            description: 'Welcher Kamera-Stream mit dem Intercom-Audio kombiniert wird.',
            choices: ['Main', 'Sub'],
            defaultValue: 'Main',
            onPut: () => this.onDeviceEvent(ScryptedInterface.VideoCamera, undefined),
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
        });
    }

    updateBattery() {
        const level = this.intercom.batteryLevel;
        if (level != null)
            this.batteryLevel = level;
    }

    resetVideoSource() {
        this.reolink = undefined;
        this.onDeviceEvent(ScryptedInterface.VideoCamera, undefined);
    }

    get useReolink() {
        return this.storageSettings.values.videoSource !== 'Scrypted Kamera';
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

    getScryptedCamera() {
        const id = this.storageSettings.values.scryptedCamera;
        const device = id && systemManager.getDeviceById<VideoCamera & Camera>(id);
        if (!device)
            throw new Error('Bitte in den Einstellungen eine Scrypted-Kamera als Bildquelle auswählen.');
        return device;
    }

    async getSettings(): Promise<Setting[]> {
        const settings = await this.storageSettings.getSettings();
        const useReolink = this.useReolink;
        return settings.filter(s => {
            if (s.group === 'Reolink')
                return useReolink;
            if (s.group === 'Scrypted Kamera')
                return !useReolink;
            return true;
        });
    }

    putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
    }

    // Camera (snapshots come from the video camera, the intercom has none).
    async takePicture(options?: RequestPictureOptions): Promise<MediaObject> {
        if (this.useReolink) {
            const jpeg = await this.getReolink().jpegSnapshot(options?.timeout);
            return this.createMediaObject(jpeg, 'image/jpeg');
        }
        return this.getScryptedCamera().takePicture(options);
    }

    async getPictureOptions(): Promise<ResponsePictureOptions[]> {
        return [];
    }

    // VideoCamera
    private async getSourceStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        if (this.useReolink) {
            return this.getReolink().getStreams().map(stream => ({
                id: stream.id,
                name: stream.name,
                container: 'rtsp',
                tool: 'scrypted',
                video: {
                    codec: this.storageSettings.values.reolinkRtspPath === 'h265Preview' && stream.id === 'main' ? 'h265' : 'h264',
                },
                audio: {},
                destinations: stream.id === 'main' ? ['local', 'local-recorder'] : ['remote', 'remote-recorder', 'low-resolution'],
                // the intercom reports a battery, but the camera is mains powered: allow prebuffering.
                allowBatteryPrebuffer: true,
            }));
        }

        const options = await this.getScryptedCamera().getVideoStreamOptions() || [];
        return options.map(o => ({
            ...o,
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
                codec: source.find(s => s.id === this.getIntercomBaseStreamId(source))?.video?.codec,
            },
            audio: {
                codec: 'aac',
            },
            // no prebuffering: the stream holds a Ring live session while it is in use.
            allowBatteryPrebuffer: false,
        };

        if (!source.length)
            return [intercomStream];

        return this.storageSettings.values.intercomStreamFirst
            ? [intercomStream, ...source]
            : [...source, intercomStream];
    }

    private getIntercomBaseStreamId(source: ResponseMediaStreamOptions[]) {
        if (!source.length)
            return undefined;
        if (this.storageSettings.values.intercomStreamBase === 'Sub')
            return (source[1] || source[0]).id;
        return source[0].id;
    }

    private async getSourceVideoStream(options?: RequestMediaStreamOptions): Promise<MediaObject> {
        if (this.useReolink) {
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
        return this.getScryptedCamera().getVideoStream(options);
    }

    async getVideoStream(options?: RequestMediaStreamOptions): Promise<MediaObject> {
        const vsos = await this.getVideoStreamOptions();
        const id = options?.id || vsos[0]?.id;

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
        this.audio.stop();
    }
}
