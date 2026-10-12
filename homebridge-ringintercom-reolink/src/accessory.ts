import type { API, DoorbellController, PlatformAccessory, Service } from 'homebridge';
import type { RingApi, RingIntercom } from 'ring-client-api';
import type { Log } from './log.js';
import { Rebroadcast } from './rebroadcast.js';
import { RecordingDelegate } from './recording.js';
import { ReolinkClient } from './reolink.js';
import { RingIntercomAudio } from './ring-audio.js';
import type { CameraConfig } from './settings.js';
import { StreamingDelegate } from './streaming.js';

function firmwareVersion(value: unknown) {
    const match = String(value ?? '').match(/\d+(\.\d+){0,2}/);
    return match ? match[0] : '1.0.0';
}

// enough for the HKSV prebuffer (4s) plus one GOP.
const PREBUFFER_MS = 10000;
const SUB_STREAM_IDLE_MS = 30000;

/**
 * One HomeKit video doorbell: picture from the Reolink camera, doorbell, audio and
 * door opener from the Ring Intercom, HomeKit Secure Video with motion from the camera.
 */
export class IntercomDoorbell {
    readonly controller: DoorbellController;
    private reolink?: ReolinkClient;
    private rebroadcasts = new Map<'main' | 'sub', Rebroadcast>();
    private streaming: StreamingDelegate;
    private recording: RecordingDelegate;
    private audio?: RingIntercomAudio;
    private lockService?: Service;
    private batteryService?: Service;
    private motionPoll?: NodeJS.Timeout;
    private motionPollFailed = false;
    private cameraMotion = false;
    private dingMotion = false;
    private dingMotionTimeout?: NodeJS.Timeout;
    private relockTimeout?: NodeJS.Timeout;
    private subscriptions: { unsubscribe(): void }[] = [];

    constructor(
        private api: API,
        private log: Log,
        public accessory: PlatformAccessory,
        private config: CameraConfig,
        private intercom: RingIntercom,
        getRingApi: () => RingApi,
        private ffmpegPath: string,
    ) {
        const hap = api.hap;
        const name = accessory.displayName;

        accessory.getService(hap.Service.AccessoryInformation)!
            .setCharacteristic(hap.Characteristic.Manufacturer, 'Ring / Reolink')
            .setCharacteristic(hap.Characteristic.Model, `${intercom.deviceType} + Reolink`)
            .setCharacteristic(hap.Characteristic.SerialNumber, String((intercom.data as any).device_id || intercom.id))
            // HomeKit only accepts numeric versions (x.y.z), Ring reports e.g. "Up To Date".
            .setCharacteristic(hap.Characteristic.FirmwareRevision, firmwareVersion((intercom.data as any).firmware_version));

        if (config.intercomAudio !== false)
            this.audio = new RingIntercomAudio(getRingApi, intercom, ffmpegPath, log);

        this.streaming = new StreamingDelegate(api, log, {
            name,
            ffmpegPath,
            getRebroadcast: purpose => this.getRebroadcast(purpose === 'live' ? config.liveStream || 'main' : 'main'),
            reolink: () => this.getReolink(),
            intercomAudio: this.audio,
            twoWayAudio: config.twoWayAudio !== false,
        });

        this.recording = new RecordingDelegate(api, log, {
            ffmpegPath,
            getRebroadcast: () => this.getRebroadcast(config.recordingStream || 'main'),
        });

        const resolutions: [number, number, number][] = [
            [1920, 1080, 30],
            [1280, 960, 30],
            [1280, 720, 30],
            [1024, 768, 30],
            [640, 480, 30],
            [640, 360, 30],
            [480, 360, 30],
            [480, 270, 30],
            [320, 240, 30],
            [320, 240, 15],
            [320, 180, 30],
        ];

        this.controller = new hap.DoorbellController({
            cameraStreamCount: 2,
            delegate: this.streaming,
            streamingOptions: {
                supportedCryptoSuites: [hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
                video: {
                    resolutions,
                    codec: {
                        profiles: [hap.H264Profile.BASELINE, hap.H264Profile.MAIN, hap.H264Profile.HIGH],
                        levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2, hap.H264Level.LEVEL4_0],
                    },
                },
                audio: {
                    twoWayAudio: !!this.audio && config.twoWayAudio !== false,
                    codecs: [
                        {
                            type: hap.AudioStreamingCodecType.OPUS,
                            samplerate: [hap.AudioStreamingSamplerate.KHZ_16, hap.AudioStreamingSamplerate.KHZ_24],
                        },
                    ],
                },
            },
            recording: {
                options: {
                    prebufferLength: 4000,
                    overrideEventTriggerOptions: [hap.EventTriggerOption.MOTION, hap.EventTriggerOption.DOORBELL],
                    mediaContainerConfiguration: [
                        {
                            type: hap.MediaContainerType.FRAGMENTED_MP4,
                            fragmentLength: 4000,
                        },
                    ],
                    video: {
                        type: hap.VideoCodecType.H264,
                        parameters: {
                            profiles: [hap.H264Profile.BASELINE, hap.H264Profile.MAIN, hap.H264Profile.HIGH],
                            levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2, hap.H264Level.LEVEL4_0],
                        },
                        resolutions,
                    },
                    audio: {
                        codecs: [
                            {
                                type: hap.AudioRecordingCodecType.AAC_LC,
                                samplerate: [hap.AudioRecordingSamplerate.KHZ_16, hap.AudioRecordingSamplerate.KHZ_24, hap.AudioRecordingSamplerate.KHZ_32],
                                audioChannels: 1,
                            },
                        ],
                    },
                },
                delegate: this.recording,
            },
            sensors: {
                motion: config.motion !== false,
            },
        });
        this.streaming.controller = this.controller;
        this.recording.controller = this.controller;
        accessory.configureController(this.controller);

        this.setupLock();
        this.setupBattery();
        this.setupDoorbell();
        this.startMotion();

        // the main stream is kept open for the HKSV prebuffer and an instant live view.
        this.getRebroadcast('main').start();
    }

    private getReolink() {
        if (!this.reolink) {
            const c = this.config;
            if (!c.reolinkHost)
                throw new Error('reolinkHost is not configured');
            this.reolink = new ReolinkClient({
                host: c.reolinkHost,
                username: c.reolinkUsername || 'admin',
                password: c.reolinkPassword || '',
                channel: c.reolinkChannel || 0,
                rtspPort: c.reolinkRtspPort || 554,
                rtspPath: c.reolinkRtspPath || 'h264Preview',
                protocol: c.reolinkProtocol || 'rtsp',
                https: !!c.reolinkHttps,
            }, this.log);
        }
        return this.reolink;
    }

    private getRebroadcast(id: 'main' | 'sub') {
        let rebroadcast = this.rebroadcasts.get(id);
        if (!rebroadcast) {
            rebroadcast = new Rebroadcast(
                `Reolink ${id}`,
                () => this.getReolink().getStream(id),
                this.ffmpegPath,
                this.log,
                {
                    prebufferMs: PREBUFFER_MS,
                    idleStopMs: id === 'main' ? 0 : SUB_STREAM_IDLE_MS,
                },
            );
            this.rebroadcasts.set(id, rebroadcast);
        }
        return rebroadcast;
    }

    private setupDoorbell() {
        const resetSeconds = this.config.motionResetSeconds || 10;
        this.subscriptions.push(this.intercom.onDing.subscribe(() => {
            this.log.log('Ring Intercom ding');
            this.controller.ringDoorbell();

            if (this.config.dingTriggersMotion) {
                this.dingMotion = true;
                this.updateMotion();
                clearTimeout(this.dingMotionTimeout);
                this.dingMotionTimeout = setTimeout(() => {
                    this.dingMotion = false;
                    this.updateMotion();
                }, resetSeconds * 1000);
            }
        }));
    }

    private setupLock() {
        if (this.config.lock === false)
            return;
        const hap = this.api.hap;
        const { LockCurrentState, LockTargetState } = hap.Characteristic;
        const name = `${this.accessory.displayName} Türöffner`;
        const service = this.accessory.getServiceById(hap.Service.LockMechanism, 'door')
            || this.accessory.addService(hap.Service.LockMechanism, name, 'door');
        this.lockService = service;
        service.setCharacteristic(hap.Characteristic.Name, name);
        service.updateCharacteristic(LockCurrentState, LockCurrentState.SECURED);
        service.updateCharacteristic(LockTargetState, LockTargetState.SECURED);

        const showUnlocked = () => {
            service.updateCharacteristic(LockTargetState, LockTargetState.UNSECURED);
            service.updateCharacteristic(LockCurrentState, LockCurrentState.UNSECURED);
            clearTimeout(this.relockTimeout);
            this.relockTimeout = setTimeout(() => {
                service.updateCharacteristic(LockTargetState, LockTargetState.SECURED);
                service.updateCharacteristic(LockCurrentState, LockCurrentState.SECURED);
            }, (this.config.unlockSeconds || 5) * 1000);
        };

        service.getCharacteristic(LockTargetState).onSet(async value => {
            if (value !== LockTargetState.UNSECURED) {
                // the door locks by itself, "locking" just resets the state.
                service.updateCharacteristic(LockCurrentState, LockCurrentState.SECURED);
                return;
            }
            this.log.log('opening the door');
            try {
                await this.intercom.unlock();
                showUnlocked();
            }
            catch (e) {
                this.log.error('opening the door failed:', (e as Error).message);
                setTimeout(() => service.updateCharacteristic(LockTargetState, LockTargetState.SECURED), 1000);
                throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
            }
        });

        this.subscriptions.push(this.intercom.onUnlocked.subscribe(() => {
            this.log.log('door opened');
            showUnlocked();
        }));
    }

    private setupBattery() {
        const hap = this.api.hap;
        const level = this.intercom.batteryLevel;
        if (level == null)
            return;
        const service = this.accessory.getService(hap.Service.Battery) || this.accessory.addService(hap.Service.Battery);
        this.batteryService = service;
        const update = () => {
            const level = this.intercom.batteryLevel;
            if (level == null)
                return;
            service.updateCharacteristic(hap.Characteristic.BatteryLevel, level);
            service.updateCharacteristic(hap.Characteristic.StatusLowBattery, level < 20
                ? hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
                : hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
        };
        update();
        this.subscriptions.push(this.intercom.onBatteryLevel.subscribe(update));
    }

    private updateMotion() {
        const service = this.controller.motionService;
        if (!service)
            return;
        const motion = this.cameraMotion || this.dingMotion;
        const characteristic = service.getCharacteristic(this.api.hap.Characteristic.MotionDetected);
        if (characteristic.value !== motion) {
            this.log.debug(`motion ${motion ? 'detected' : 'ended'}`);
            characteristic.updateValue(motion);
        }
    }

    private startMotion() {
        if (this.config.motion === false)
            return;
        const interval = Math.max(1, this.config.motionPollSeconds || 2) * 1000;
        this.motionPoll = setInterval(async () => {
            try {
                this.cameraMotion = await this.getReolink().getMotionState();
                if (this.motionPollFailed)
                    this.log.log('Reolink motion state available again');
                this.motionPollFailed = false;
            }
            catch (e) {
                if (!this.motionPollFailed)
                    this.log.warn('Reolink motion state unavailable:', (e as Error).message);
                this.motionPollFailed = true;
                this.cameraMotion = false;
            }
            this.updateMotion();
        }, interval);
    }

    shutdown() {
        clearInterval(this.motionPoll);
        clearTimeout(this.dingMotionTimeout);
        clearTimeout(this.relockTimeout);
        for (const s of this.subscriptions)
            s.unsubscribe();
        this.subscriptions = [];
        this.streaming.stopAll();
        this.recording.stop();
        this.audio?.stop();
        for (const rebroadcast of this.rebroadcasts.values())
            rebroadcast.stop();
    }
}
