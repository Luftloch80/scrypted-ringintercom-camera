import type { Logging } from 'homebridge';
import { format } from 'util';

/**
 * Small console-like logger, prefixed with the device name.
 */
export interface Log {
    log(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
    debug(...args: any[]): void;
}

export function createLog(log: Logging, prefix: string, debugToInfo = false): Log {
    const f = (args: any[]) => `[${prefix}] ${format(...args)}`;
    return {
        log: (...args) => log.info(f(args)),
        warn: (...args) => log.warn(f(args)),
        error: (...args) => log.error(f(args)),
        debug: (...args) => debugToInfo ? log.info(f(args)) : log.debug(f(args)),
    };
}
