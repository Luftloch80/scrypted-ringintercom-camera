import { Battery, Lock, LockState, ScryptedDeviceBase } from '@scrypted/sdk';
import type { RingIntercom } from 'ring-client-api';

const RELOCK_MS = 5000;

/**
 * Door opener of the Ring Intercom. The intercom buzzes the door for a few seconds,
 * so the lock reports "unlocked" briefly and then returns to "locked".
 */
export class RingIntercomLock extends ScryptedDeviceBase implements Lock, Battery {
    private relockTimeout?: NodeJS.Timeout;

    constructor(nativeId: string, public intercom: RingIntercom) {
        super(nativeId);
        this.lockState = LockState.Locked;
        intercom.onUnlocked.subscribe(() => this.showUnlocked());
        this.updateBattery();
        intercom.onBatteryLevel.subscribe(() => this.updateBattery());
    }

    private updateBattery() {
        const level = this.intercom.batteryLevel;
        if (level != null)
            this.batteryLevel = level;
    }

    private showUnlocked() {
        this.lockState = LockState.Unlocked;
        clearTimeout(this.relockTimeout);
        this.relockTimeout = setTimeout(() => this.lockState = LockState.Locked, RELOCK_MS);
    }

    async lock(): Promise<void> {
        // the door locks by itself after buzzing.
        this.lockState = LockState.Locked;
    }

    async unlock(): Promise<void> {
        this.console.log('opening door via Ring Intercom');
        await this.intercom.unlock();
        this.showUnlocked();
    }

    release() {
        clearTimeout(this.relockTimeout);
    }
}
