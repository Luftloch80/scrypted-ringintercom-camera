// Minimal Reolink HTTP/RTSP client.
// Based on the stream and snapshot handling of the official Scrypted Reolink plugin
// (https://github.com/koush/scrypted/tree/main/plugins/reolink), reduced to what is
// needed to use a Reolink camera as the picture source of a Ring Intercom.

export type ReolinkRtspPath = 'h264Preview' | 'h265Preview' | 'Preview';

export interface ReolinkOptions {
    host: string;
    username: string;
    password: string;
    channel: number;
    rtspPort: number;
    rtspPath: ReolinkRtspPath;
    https: boolean;
}

export interface ReolinkStream {
    id: 'main' | 'sub';
    name: string;
    url: string;
}

export class ReolinkClient {
    private token?: string;
    private tokenExpires = 0;

    constructor(public options: ReolinkOptions, public console: Console) {
    }

    private get httpBase() {
        return `${this.options.https ? 'https' : 'http'}://${this.options.host}`;
    }

    private get rtspHost() {
        // strip an optional http port from the host setting.
        const host = this.options.host.replace(/:\d+$/, '');
        return `${host}:${this.options.rtspPort || 554}`;
    }

    getStreams(): ReolinkStream[] {
        const channel = ((this.options.channel || 0) + 1).toString().padStart(2, '0');
        const auth = `${encodeURIComponent(this.options.username)}:${encodeURIComponent(this.options.password || '')}`;
        const prefix = this.options.rtspPath || 'h264Preview';
        return [
            {
                id: 'main',
                name: 'Reolink Main',
                url: `rtsp://${auth}@${this.rtspHost}/${prefix}_${channel}_main`,
            },
            {
                id: 'sub',
                name: 'Reolink Sub',
                url: `rtsp://${auth}@${this.rtspHost}/${prefix}_${channel}_sub`,
            },
        ];
    }

    private async login() {
        if (this.token && this.tokenExpires > Date.now())
            return this.token;

        const url = `${this.httpBase}/api.cgi?cmd=Login`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify([
                {
                    cmd: 'Login',
                    action: 0,
                    param: {
                        User: {
                            Version: '0',
                            userName: this.options.username,
                            password: this.options.password || '',
                        },
                    },
                },
            ]),
            signal: AbortSignal.timeout(10000),
        });
        const json = await response.json();
        const token = json?.[0]?.value?.Token;
        if (!token?.name)
            throw new Error(`Reolink login failed: ${JSON.stringify(json?.[0]?.error || json)}`);

        this.token = token.name;
        // renew one minute before the lease runs out.
        this.tokenExpires = Date.now() + Math.max(60, (token.leaseTime || 3600) - 60) * 1000;
        return this.token;
    }

    async jpegSnapshot(timeout = 10000): Promise<Buffer> {
        const snap = async (auth: Record<string, string>) => {
            const url = new URL(`${this.httpBase}/cgi-bin/api.cgi`);
            url.searchParams.set('cmd', 'Snap');
            url.searchParams.set('channel', (this.options.channel || 0).toString());
            url.searchParams.set('rs', Date.now().toString());
            for (const [k, v] of Object.entries(auth))
                url.searchParams.set(k, v);
            const response = await fetch(url, {
                signal: AbortSignal.timeout(timeout),
            });
            const buffer = Buffer.from(await response.arrayBuffer());
            // a failed request returns a json error body instead of a jpeg.
            if (!response.ok || buffer[0] !== 0xFF || buffer[1] !== 0xD8)
                throw new Error(`Reolink snapshot failed: ${response.status} ${buffer.subarray(0, 200).toString()}`);
            return buffer;
        };

        try {
            const token = await this.login();
            return await snap({ token });
        }
        catch (e) {
            // token may have been invalidated (camera reboot), or the
            // camera does not support token login. retry once with plain credentials.
            this.token = undefined;
            this.console.warn('Reolink snapshot with token failed, retrying with credentials.', (e as Error).message);
            return snap({
                user: this.options.username,
                password: this.options.password || '',
            });
        }
    }
}
