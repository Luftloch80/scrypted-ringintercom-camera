export const PLUGIN_NAME = 'homebridge-ringintercom-reolink';
export const PLATFORM_NAME = 'RingIntercomReolink';

export type ReolinkProtocol = 'rtsp' | 'flv' | 'rtmp';
export type StreamChoice = 'main' | 'sub';

export interface CameraConfig {
    name?: string;
    /** name or id of the Ring Intercom. empty: the first intercom of the account. */
    intercom?: string;

    reolinkHost: string;
    reolinkUsername?: string;
    reolinkPassword?: string;
    reolinkChannel?: number;
    reolinkProtocol?: ReolinkProtocol;
    reolinkRtspPort?: number;
    reolinkRtspPath?: 'h264Preview' | 'h265Preview' | 'Preview';
    reolinkHttps?: boolean;

    liveStream?: StreamChoice;
    recordingStream?: StreamChoice;

    intercomAudio?: boolean;
    twoWayAudio?: boolean;

    motion?: boolean;
    motionPollSeconds?: number;
    dingTriggersMotion?: boolean;
    motionResetSeconds?: number;

    lock?: boolean;
    unlockSeconds?: number;
}

export interface PlatformConfig {
    platform: string;
    name?: string;
    refreshToken?: string;
    ffmpegPath?: string;
    debug?: boolean;
    cameras?: CameraConfig[];
}
