import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory } from 'homebridge';
import { RingApi, RingIntercom } from 'ring-client-api';
import { useLogger } from 'ring-client-api/util';
import { IntercomDoorbell } from './accessory.js';
import { getFFmpegPath } from './ffmpeg.js';
import { createLog } from './log.js';
import { PLATFORM_NAME, PLUGIN_NAME, type CameraConfig, type PlatformConfig } from './settings.js';

interface StoredState {
    systemId?: string;
    /** the refresh token from config.json the stored token was derived from. */
    configRefreshToken?: string;
    /** the latest refresh token (Ring rotates it). */
    refreshToken?: string;
}

export class RingIntercomReolinkPlatform implements DynamicPlatformPlugin {
    private ringApi?: RingApi;
    private doorbells: IntercomDoorbell[] = [];
    private readonly statePath: string;
    private readonly config: PlatformConfig;

    constructor(private log: Logging, config: Record<string, any>, private api: API) {
        this.config = config as PlatformConfig;
        this.statePath = path.join(api.user.storagePath(), 'ringintercom-reolink.json');

        api.on('didFinishLaunching', () => {
            this.start().catch(e => this.log.error('Start failed:', e?.message || e));
        });
        api.on('shutdown', () => this.shutdown());
    }

    // cameras are published as external accessories, nothing is cached.
    configureAccessory(accessory: PlatformAccessory): void {
    }

    private readState(): StoredState {
        try {
            return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
        }
        catch (e) {
            return {};
        }
    }

    private writeState(state: StoredState) {
        try {
            fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2));
        }
        catch (e) {
            this.log.error('Could not save the Ring refresh token:', (e as Error).message);
        }
    }

    private async start() {
        const cameras = this.config.cameras || [];
        if (!cameras.length) {
            this.log.warn('No camera configured.');
            return;
        }

        const state = this.readState();
        if (!state.systemId)
            state.systemId = crypto.randomBytes(32).toString('hex');

        // Ring rotates the refresh token, the latest one is kept in the storage directory.
        // A new token in config.json takes precedence.
        let refreshToken = state.refreshToken;
        if (this.config.refreshToken && this.config.refreshToken !== state.configRefreshToken) {
            refreshToken = this.config.refreshToken;
            state.configRefreshToken = this.config.refreshToken;
            state.refreshToken = refreshToken;
        }
        this.writeState(state);

        if (!refreshToken) {
            this.log.error('Ring refresh token missing. Create one with: npx -p ring-client-api ring-auth-cli');
            return;
        }

        useLogger({
            logInfo: (...message: any[]) => this.log.debug('[Ring]', ...message),
            logError: (message: any) => this.log.error('[Ring]', message),
        });

        const ffmpegPath = getFFmpegPath(this.config.ffmpegPath);
        this.log.info(`Using ffmpeg: ${ffmpegPath}`);

        this.ringApi = new RingApi({
            refreshToken,
            systemId: state.systemId,
            controlCenterDisplayName: 'homebridge-ringintercom-reolink',
            ffmpegPath,
            cameraStatusPollingSeconds: 60,
        });
        this.ringApi.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => {
            const current = this.readState();
            current.refreshToken = newRefreshToken;
            this.writeState(current);
        });

        const locations = await this.ringApi.getLocations();
        const intercoms: RingIntercom[] = locations.flatMap(location => location.intercoms);
        this.log.info(`Ring: ${intercoms.length} intercom(s) found${intercoms.length ? ': ' + intercoms.map(i => i.name).join(', ') : ''}`);
        if (!intercoms.length) {
            this.log.error('No Ring Intercom found in the Ring account.');
            return;
        }

        const accessories: PlatformAccessory[] = [];
        for (const camera of cameras) {
            const intercom = this.findIntercom(intercoms, camera);
            if (!intercom) {
                this.log.error(`Ring Intercom "${camera.intercom}" not found.`);
                continue;
            }
            if (!camera.reolinkHost) {
                this.log.error(`${camera.name || intercom.name}: reolinkHost is missing.`);
                continue;
            }

            const name = camera.name || intercom.name;
            const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${intercom.id}`);
            const accessory = new this.api.platformAccessory(name, uuid, this.api.hap.Categories.VIDEO_DOORBELL);
            const log = createLog(this.log, name, !!this.config.debug);
            this.doorbells.push(new IntercomDoorbell(this.api, log, accessory, camera, intercom, () => this.ringApi!, ffmpegPath));
            accessories.push(accessory);
            this.log.info(`${name}: Ring Intercom "${intercom.name}" with Reolink ${camera.reolinkHost}`);
        }

        // video doorbells must be published on their own (not behind the bridge).
        this.api.publishExternalAccessories(PLUGIN_NAME, accessories);
    }

    private findIntercom(intercoms: RingIntercom[], camera: CameraConfig) {
        const wanted = camera.intercom?.trim();
        if (!wanted)
            return intercoms[0];
        return intercoms.find(i => i.id.toString() === wanted || i.name.toLowerCase() === wanted.toLowerCase());
    }

    private shutdown() {
        for (const doorbell of this.doorbells)
            doorbell.shutdown();
        this.ringApi?.disconnect();
    }
}

export { PLATFORM_NAME };
