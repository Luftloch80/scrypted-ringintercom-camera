// Server side of the custom Homebridge UI (Plugins -> Ring Intercom + Reolink -> Settings):
// Ring login with 2FA directly in the UI, and a connection test for the Reolink camera.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import { RingApi } from 'ring-client-api';
import { RingRestClient } from 'ring-client-api/rest-client';
import { ReolinkClient } from '../dist/reolink.js';

const STATE_FILE = 'ringintercom-reolink.json';
const CONTROL_CENTER_NAME = 'homebridge-ringintercom-reolink';

const quietLog = {
    log: () => { },
    warn: () => { },
    error: () => { },
    debug: () => { },
};

class UiServer extends HomebridgePluginUiServer {
    constructor() {
        super();
        this.onRequest('/ring/login', payload => this.ringLogin(payload));
        this.onRequest('/reolink/test', payload => this.reolinkTest(payload));
        this.ready();
    }

    /**
     * The system id is shared with the plugin, so the login is bound to the same Ring "device".
     */
    getSystemId() {
        const file = path.join(this.homebridgeStoragePath || '.', STATE_FILE);
        let state = {};
        try {
            state = JSON.parse(fs.readFileSync(file, 'utf8'));
        }
        catch (e) {
        }
        if (!state.systemId) {
            state.systemId = crypto.randomBytes(32).toString('hex');
            try {
                fs.writeFileSync(file, JSON.stringify(state, null, 2));
            }
            catch (e) {
            }
        }
        return state.systemId;
    }

    async ringLogin({ email, password, code }) {
        if (!email || !password)
            throw new RequestError('Bitte E-Mail und Passwort eingeben.', { status: 400 });

        const systemId = this.getSystemId();
        const restClient = new RingRestClient({
            email,
            password,
            systemId,
            controlCenterDisplayName: CONTROL_CENTER_NAME,
        });

        let refreshToken;
        try {
            const auth = code
                ? await restClient.getAuth(String(code).trim())
                : await restClient.getCurrentAuth();
            refreshToken = auth.refresh_token;
        }
        catch (e) {
            if (restClient.promptFor2fa && !code) {
                return {
                    codePrompt: restClient.promptFor2fa
                        .replace('Please enter the code sent to your text/email', 'Bitte den Code eingeben, den Ring per SMS/E-Mail geschickt hat.')
                        .replace('Please enter the code from your authenticator app', 'Bitte den Code aus der Authenticator-App eingeben.')
                        .replace(/^Please enter the code sent to (.*) via (.*)$/, 'Bitte den Code eingeben, den Ring an $1 ($2) geschickt hat.'),
                };
            }
            if (restClient.promptFor2fa && code)
                throw new RequestError('Der Code ist falsch oder abgelaufen. Bitte erneut anmelden.', { status: 400 });
            throw new RequestError(`Ring-Anmeldung fehlgeschlagen: ${e?.message || e}`, { status: 401 });
        }
        restClient.clearTimeouts?.();

        // list the intercoms right away, Ring may rotate the token while doing so.
        let intercoms = [];
        const api = new RingApi({
            refreshToken,
            systemId,
            controlCenterDisplayName: CONTROL_CENTER_NAME,
        });
        try {
            api.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => refreshToken = newRefreshToken);
            const locations = await Promise.race([
                api.getLocations(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 20000)),
            ]);
            intercoms = locations.flatMap(location => location.intercoms.map(intercom => ({
                id: intercom.id,
                name: intercom.name,
                location: location.name,
                batteryLevel: intercom.batteryLevel,
            })));
        }
        catch (e) {
            // the token is valid anyway, the list is only a convenience.
        }
        finally {
            api.disconnect();
        }

        return { refreshToken, intercoms };
    }

    async reolinkTest({ host, username, password, https, channel, rtspPath }) {
        if (!host)
            throw new RequestError('Bitte die IP-Adresse der Reolink-Kamera eintragen.', { status: 400 });

        const client = new ReolinkClient({
            host,
            username: username || 'admin',
            password: password || '',
            channel: Number(channel) || 0,
            rtspPort: 554,
            rtspPath: rtspPath || 'h264Preview',
            protocol: 'rtsp',
            https: !!https,
        }, quietLog);

        let encoder;
        try {
            encoder = await client.getEncoderConfiguration();
        }
        catch (e) {
            const message = String(e?.message || e);
            if (/login failed|rspCode":-7/i.test(message))
                throw new RequestError('Anmeldung an der Kamera fehlgeschlagen: Benutzer oder Passwort falsch.', { status: 401 });
            if (/fetch failed|timeout|aborted/i.test(message))
                throw new RequestError(`Die Kamera ist unter ${host} nicht erreichbar (IP-Adresse prüfen, ggf. HTTPS-Einstellung).`, { status: 502 });
            throw new RequestError(`Keine Verbindung zur Reolink-API: ${message}`, { status: 502 });
        }

        let snapshot;
        try {
            snapshot = (await client.jpegSnapshot(8000)).toString('base64');
        }
        catch (e) {
        }

        const describe = stream => stream ? {
            width: stream.width,
            height: stream.height,
            codec: stream.vType,
            frameRate: stream.frameRate,
            bitRate: stream.bitRate,
            gop: stream.gop,
        } : undefined;

        return {
            main: describe(encoder.main),
            sub: describe(encoder.sub),
            snapshot,
        };
    }
}

// the UI may close the connection while the server starts (e.g. when the page is reloaded).
process.on('error', () => { });

(() => new UiServer())();
