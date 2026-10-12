import { ChildProcess, spawn } from 'child_process';
import { createRequire } from 'module';
import type { Log } from './log.js';

let resolvedPath: string | undefined;

/**
 * The ffmpeg binary: the configured one, the one of ffmpeg-for-homebridge (has libopus, srtp
 * and libfdk_aac builds for the Raspberry Pi), or ffmpeg from the PATH.
 */
export function getFFmpegPath(configured?: string): string {
    if (configured)
        return configured;
    if (resolvedPath)
        return resolvedPath;
    try {
        const require = createRequire(import.meta.url);
        const path = require('ffmpeg-for-homebridge');
        if (typeof path === 'string')
            return resolvedPath = path;
    }
    catch (e) {
    }
    return resolvedPath = 'ffmpeg';
}

export function killQuiet(cp?: ChildProcess) {
    try {
        cp?.kill('SIGKILL');
    }
    catch (e) {
    }
}

/**
 * Hides passwords in urls for logging.
 */
export function redact(text: string) {
    return text
        .replace(/(\/\/[^:/@\s]+:)[^@\s]+@/g, '$1***@')
        .replace(/((?:password|user)=)[^&\s]+/gi, '$1***');
}

export interface SpawnOptions {
    name: string;
    log: Log;
    stdio?: ('pipe' | 'ignore')[];
    /** receives every stderr line (before rate limiting). */
    onLine?: (line: string) => void;
}

// a broken stream can make ffmpeg print thousands of lines per second,
// which would flood the log and slow down Homebridge.
const LOG_LINES_PER_WINDOW = 20;
const LOG_WINDOW_MS = 10000;

/**
 * Spawns ffmpeg and forwards stderr to the log (debug level, warnings and errors are logged as such).
 */
export function spawnFFmpeg(ffmpegPath: string, args: string[], options: SpawnOptions): ChildProcess {
    const { name, log } = options;
    log.debug(`[${name}] ${redact(`${ffmpegPath} ${args.join(' ')}`)}`);
    const cp = spawn(ffmpegPath, args, {
        stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    });
    let pending = '';
    let windowStart = Date.now();
    let windowLines = 0;
    let suppressed = 0;
    cp.stderr?.on('data', (data: Buffer) => {
        pending += data.toString();
        const lines = pending.split(/\r?\n|\r/);
        pending = lines.pop() || '';
        for (const line of lines) {
            if (!line.trim())
                continue;
            options.onLine?.(line);
            const now = Date.now();
            if (now - windowStart > LOG_WINDOW_MS) {
                if (suppressed)
                    log.debug(`[${name}] ... ${suppressed} more ffmpeg messages suppressed`);
                windowStart = now;
                windowLines = 0;
                suppressed = 0;
            }
            if (++windowLines > LOG_LINES_PER_WINDOW) {
                suppressed++;
                continue;
            }
            log.debug(`[${name}] ${redact(line)}`);
        }
    });
    cp.on('error', e => log.error(`[${name}] ffmpeg could not be started (${ffmpegPath}):`, e.message));
    return cp;
}
