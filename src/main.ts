import sdk, { Device, DeviceProvider, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, Setting, Settings, SettingValue } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import crypto from 'crypto';
import { RingApi, RingIntercom } from 'ring-client-api';
import { RingRestClient } from 'ring-client-api/rest-client';
import { RingIntercomCamera } from './intercom-camera';
import { RingIntercomLock } from './intercom-lock';

const { deviceManager, mediaManager } = sdk;

const LOCK_SUFFIX = '-lock';

class RingIntercomCameraPlugin extends ScryptedDeviceBase implements DeviceProvider, Settings {
    api?: RingApi;
    loginClient?: RingRestClient;
    intercoms = new Map<string, RingIntercom>();
    devices = new Map<string, RingIntercomCamera | RingIntercomLock>();
    discovery?: Promise<void>;

    settingsStorage = new StorageSettings(this, {
        systemId: {
            title: 'System ID',
            hide: true,
            persistedDefaultValue: crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex'),
        },
        controlCenterDisplayName: {
            hide: true,
            defaultValue: 'scrypted-ringintercom',
        },
        email: {
            title: 'Ring E-Mail',
            onPut: () => this.relogin(),
        },
        password: {
            title: 'Ring Passwort',
            type: 'password',
            onPut: () => this.relogin(),
        },
        loginCode: {
            title: 'Zwei-Faktor-Code',
            description: 'Wenn 2FA aktiv ist: den von Ring per SMS/E-Mail gesendeten Code hier eintragen.',
            noStore: true,
            onPut: async (oldValue, newValue) => {
                await this.tryLogin(newValue);
                this.console.log('login with 2 factor code completed');
                await this.startDiscovery();
            },
        },
        refreshToken: {
            hide: true,
        },
        pollingSeconds: {
            title: 'Status-Abfrage (Sekunden)',
            description: 'Intervall, in dem Status und Akkustand des Intercoms abgefragt werden. Klingel-Ereignisse kommen unabhängig davon per Push.',
            type: 'number',
            defaultValue: 60,
            onPut: () => this.startDiscovery(),
        },
    });

    constructor() {
        super();
        this.startDiscovery();
    }

    startDiscovery() {
        this.discovery = this.discoverDevices();
        this.discovery.catch(e => this.console.error('discovery failed', e));
        return this.discovery;
    }

    relogin() {
        this.settingsStorage.values.refreshToken = '';
        clearTimeout(this.reloginTimeout);
        // wait until email and password are both entered.
        this.reloginTimeout = setTimeout(() => this.startDiscovery(), 1000);
    }
    private reloginTimeout?: NodeJS.Timeout;

    async tryLogin(code?: string) {
        const createRingApi = async () => {
            this.api?.disconnect();
            const pollingSeconds = parseInt(this.settingsStorage.values.pollingSeconds) || 60;
            this.api = new RingApi({
                refreshToken: this.settingsStorage.values.refreshToken,
                controlCenterDisplayName: this.settingsStorage.values.controlCenterDisplayName,
                systemId: this.settingsStorage.values.systemId,
                ffmpegPath: await mediaManager.getFFmpegPath(),
                cameraStatusPollingSeconds: pollingSeconds,
            });
            this.api.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => {
                this.settingsStorage.values.refreshToken = newRefreshToken;
            });
        };

        if (this.settingsStorage.values.refreshToken && !code) {
            await createRingApi();
            return;
        }

        const { email, password } = this.settingsStorage.values;
        if (!email || !password) {
            this.log.a('Bitte Ring E-Mail und Passwort eingeben, um die Einrichtung abzuschließen.');
            throw new Error('Ring refresh token, email and password are missing.');
        }

        if (!code || !this.loginClient) {
            this.loginClient = new RingRestClient({
                email,
                password,
                controlCenterDisplayName: this.settingsStorage.values.controlCenterDisplayName,
                systemId: this.settingsStorage.values.systemId,
            });
        }

        try {
            const auth = code
                ? await this.loginClient.getAuth(code)
                : await this.loginClient.getCurrentAuth();
            this.settingsStorage.values.refreshToken = auth.refresh_token;
        }
        catch (e) {
            if (!code && this.loginClient.promptFor2fa) {
                this.log.a('Ring hat einen Login-Code gesendet. Bitte im Feld "Zwei-Faktor-Code" eintragen.');
                throw new Error('Ring two factor code required.');
            }
            this.console.error(e);
            this.log.a('Ring Login fehlgeschlagen.');
            throw e;
        }

        await createRingApi();
    }

    async discoverDevices() {
        await this.tryLogin();
        this.console.log('Ring login successful, discovering intercoms');

        const locations = await this.api!.getLocations();
        const devices: Device[] = [];
        this.intercoms.clear();

        for (const location of locations) {
            for (const intercom of location.intercoms) {
                const nativeId = intercom.id.toString();
                this.intercoms.set(nativeId, intercom);

                const info = {
                    manufacturer: 'Ring',
                    model: intercom.deviceType,
                    firmware: (intercom.data as any).firmware_version,
                    serialNumber: (intercom.data as any).device_id,
                };

                const interfaces = [
                    ScryptedInterface.VideoCamera,
                    ScryptedInterface.Camera,
                    ScryptedInterface.Intercom,
                    ScryptedInterface.BinarySensor,
                    // motion is required for HomeKit Secure Video.
                    ScryptedInterface.MotionSensor,
                    ScryptedInterface.Settings,
                ];
                // the battery is reported on the door opener: on the doorbell, Rebroadcast would treat
                // the (mains powered) camera as battery powered and stop prebuffering.

                devices.push({
                    nativeId,
                    name: intercom.name,
                    type: ScryptedDeviceType.Doorbell,
                    interfaces,
                    info,
                });

                devices.push({
                    nativeId: nativeId + LOCK_SUFFIX,
                    name: `${intercom.name} Türöffner`,
                    type: ScryptedDeviceType.Lock,
                    interfaces: intercom.batteryLevel != null
                        ? [ScryptedInterface.Lock, ScryptedInterface.Battery]
                        : [ScryptedInterface.Lock],
                    info,
                });
            }
        }

        if (!devices.length)
            this.log.a('Kein Ring Intercom im Ring-Konto gefunden.');
        this.console.log(`found ${devices.length / 2} Ring intercom(s)`);

        // intercom objects were recreated, recreate devices bound to them.
        for (const device of this.devices.values())
            device.release();
        this.devices.clear();

        await deviceManager.onDevicesChanged({
            devices,
        });

        for (const device of devices)
            await this.getDevice(device.nativeId);
    }

    async getDevice(nativeId: string) {
        let device = this.devices.get(nativeId);
        if (device)
            return device;

        if (!this.intercoms.size)
            await this.discovery;

        const isLock = nativeId.endsWith(LOCK_SUFFIX);
        const intercomId = isLock ? nativeId.slice(0, -LOCK_SUFFIX.length) : nativeId;
        const intercom = this.intercoms.get(intercomId);
        if (!intercom)
            throw new Error(`Ring Intercom ${intercomId} not found`);

        device = isLock
            ? new RingIntercomLock(nativeId, intercom)
            : new RingIntercomCamera(this, nativeId, intercom);
        this.devices.set(nativeId, device);
        return device;
    }

    async releaseDevice(id: string, nativeId: string) {
        this.devices.get(nativeId)?.release();
        this.devices.delete(nativeId);
    }

    getSettings(): Promise<Setting[]> {
        return this.settingsStorage.getSettings();
    }

    putSetting(key: string, value: SettingValue): Promise<void> {
        return this.settingsStorage.putSetting(key, value);
    }
}

export default RingIntercomCameraPlugin;
