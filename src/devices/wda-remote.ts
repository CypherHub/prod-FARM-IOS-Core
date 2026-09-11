import sharp from 'sharp';

import { coordinatesForProfile } from './coordinates.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const SCREEN_ASLEEP_LUMA = 12;

export interface ScreenSize {
    width: number;
    height: number;
}

export interface ScreenInfo {
    screenSize: ScreenSize;
    scale: number;
    statusBarSize?: ScreenSize;
}

export type RemoteAction =
    | { type: 'tap'; x: number; y: number }
    | { type: 'home' }
    | { type: 'lock' }
    | { type: 'wake' }
    | { type: 'unlock' }
    | { type: 'volumeUp' }
    | { type: 'volumeDown' }
    | {
        type: 'swipe';
        startX: number;
        startY: number;
        endX: number;
        endY: number;
        durationMs: number;
    };

export interface PasscodeKeypadLayout {
    // x for columns [1,4,7/0], [2,5,8], [3,6,9]
    columnX: [number, number, number];
    // y for rows [1,2,3], [4,5,6], [7,8,9], [0]
    rowY: [number, number, number, number];
}

// Standard iOS numeric keypad: 1-9 in a 3x3 grid, 0 centered beneath it.
// Row spacing may vary by device profile, so rows are stored explicitly.
export function passcodeDigitPoint(digit: number, layout: PasscodeKeypadLayout): { x: number; y: number } {
    if (digit === 0) {
        return { x: layout.columnX[1], y: layout.rowY[3] };
    }
    const index = digit - 1;
    return {
        x: layout.columnX[index % 3],
        y: layout.rowY[Math.floor(index / 3)],
    };
}

/** True when a screenshot is essentially black — the display is off, which `/wda/locked` often misses. */
export async function screenshotLooksAsleep(png: Buffer): Promise<boolean> {
    const { data, info } = await sharp(png).resize(32, 32, { fit: 'fill' }).removeAlpha().raw()
        .toBuffer({ resolveWithObject: true });
    let sum = 0;
    const pixels = info.width * info.height;
    for (let i = 0; i < data.length; i += info.channels) {
        sum += (data[i]! * 299 + data[i + 1]! * 587 + data[i + 2]! * 114) / 1000;
    }
    return sum / pixels < SCREEN_ASLEEP_LUMA;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

interface WdaPayload<T> {
    value: T;
}

interface W3cActionItem {
    type: 'pointerMove' | 'pointerDown' | 'pointerUp' | 'pause';
    duration?: number;
    x?: number;
    y?: number;
    origin?: 'viewport';
    button?: number;
}

interface W3cPointerSource {
    type: 'pointer';
    id: string;
    parameters: { pointerType: 'touch' };
    actions: W3cActionItem[];
}

export interface RemoteControl {
    getScreenInfo(udid: string): Promise<ScreenInfo>;
    getScreenshot(udid: string): Promise<Buffer>;
    /** `signal` should be tied to the client request so the upstream device stream closes when the viewer leaves. */
    getMjpegStream(udid: string, signal?: AbortSignal): Promise<Response>;
    performAction(udid: string, action: RemoteAction): Promise<void>;
    isLocked(udid: string): Promise<boolean>;
    /** Drop any cached client for this device so its next use re-reads devices.json. */
    forget?(udid: string): void;
}

export class RemoteDeviceError extends Error {}

export class WdaRemoteControl {
    readonly wdaUrl: string;
    readonly mjpegUrl: string;
    readonly deviceUdid: string | undefined;
    readonly fetch: typeof fetch;
    readonly timeoutMs: number;
    readonly passcode: string | undefined;
    readonly passcodeKeypadLayout: PasscodeKeypadLayout;
    private cachedScreenInfo: ScreenInfo | undefined;

    constructor({
        wdaUrl = process.env.WDA_URL ?? 'http://127.0.0.1:8100',
        mjpegUrl = process.env.MJPEG_URL ?? 'http://127.0.0.1:9100',
        deviceUdid = process.env.IOS_UDID,
        fetchImpl = fetch,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        passcode = process.env.IOS_PASSCODE,
        passcodeKeypadLayout = coordinatesForProfile().passcodeKeypad,
    }: {
        wdaUrl?: string;
        mjpegUrl?: string;
        deviceUdid?: string;
        fetchImpl?: typeof fetch;
        timeoutMs?: number;
        passcode?: string;
        passcodeKeypadLayout?: PasscodeKeypadLayout;
    } = {}) {
        this.wdaUrl = wdaUrl.replace(/\/$/, '');
        this.mjpegUrl = mjpegUrl.replace(/\/$/, '');
        this.deviceUdid = deviceUdid;
        this.fetch = fetchImpl;
        this.timeoutMs = timeoutMs;
        this.passcode = passcode;
        this.passcodeKeypadLayout = passcodeKeypadLayout;
    }

    assertTarget(udid: string): void {
        if (!this.deviceUdid || udid !== this.deviceUdid) {
            throw new RemoteDeviceError('Remote control is not configured for this device');
        }
    }

    async request(pathname: string, options: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
        const { timeoutMs = this.timeoutMs, ...fetchOptions } = options;
        let response: Response;
        try {
            response = await this.fetch(`${this.wdaUrl}${pathname}`, {
                ...fetchOptions,
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (error) {
            throw new RemoteDeviceError(`WebDriverAgent is unavailable: ${errorMessage(error)}`);
        }
        if (!response.ok) {
            const detail = await response.text();
            throw new RemoteDeviceError(`WebDriverAgent returned ${response.status}${detail ? `: ${detail}` : ''}`);
        }
        return response;
    }

    async getScreenInfo(udid: string): Promise<ScreenInfo> {
        this.assertTarget(udid);
        const response = await this.request('/wda/screen');
        const payload = await response.json() as WdaPayload<ScreenInfo>;
        this.cachedScreenInfo = payload.value;
        return payload.value;
    }

    async getScreenshot(udid: string): Promise<Buffer> {
        this.assertTarget(udid);
        const response = await this.request('/screenshot');
        const payload = await response.json() as WdaPayload<unknown>;
        if (typeof payload.value !== 'string') {
            throw new RemoteDeviceError('WebDriverAgent returned an invalid screenshot');
        }
        return Buffer.from(payload.value, 'base64');
    }

    async getMjpegStream(udid: string, signal?: AbortSignal): Promise<Response> {
        this.assertTarget(udid);
        // A connect deadline for the handshake, then hand the stream over to the
        // caller's signal so it lives exactly as long as the client stays connected.
        const connect = new AbortController();
        const timer = setTimeout(() => connect.abort(new RemoteDeviceError('WDA video stream did not connect in time')), this.timeoutMs);
        const combined = signal ? AbortSignal.any([signal, connect.signal]) : connect.signal;
        let response: Response;
        try {
            response = await this.fetch(`${this.mjpegUrl}/`, { signal: combined });
        } catch (error) {
            throw new RemoteDeviceError(`WDA video stream is unavailable: ${errorMessage(error)}`);
        } finally {
            clearTimeout(timer);
        }
        if (!response.ok || !response.body) {
            throw new RemoteDeviceError(`WDA video stream returned ${response.status}`);
        }
        return response;
    }

    async isLocked(udid: string): Promise<boolean> {
        this.assertTarget(udid);
        const response = await this.request('/wda/locked');
        const payload = await response.json() as WdaPayload<boolean>;
        return payload.value;
    }

    async unlock(udid: string): Promise<void> {
        this.assertTarget(udid);
        const reportedLocked = await this.isLocked(udid);
        const wasAsleep = await screenshotLooksAsleep(await this.getScreenshot(udid));
        // `/wda/locked` is false on a sleeping Face ID phone, but SpringBoard
        // still refuses to launch apps. A black screenshot is the reliable signal.
        if (!reportedLocked && !wasAsleep) return;
        if (!this.passcode) {
            throw new RemoteDeviceError('IOS_PASSCODE is not configured; cannot unlock the device');
        }

        const screen = this.cachedScreenInfo ?? await this.getScreenInfo(udid);
        const { width, height } = screen.screenSize;
        await this.wakeDisplay(udid, width, height);
        if (height >= 800) {
            // Face ID: swipe up from the home indicator, then wait for Face ID
            // to fail so the passcode keypad appears.
            await this.sendPointer(swipeActions({
                type: 'swipe',
                startX: Math.round(width / 2),
                startY: height - 11,
                endX: Math.round(width / 2),
                endY: Math.round(height * 0.47),
                durationMs: 350,
            }));
            await delay(2200);
        }

        console.log('Entering device passcode');
        for (const character of this.passcode) {
            const digit = Number(character);
            if (!Number.isInteger(digit) || digit < 0 || digit > 9) {
                throw new RemoteDeviceError('IOS_PASSCODE must contain only digits');
            }
            const { x, y } = passcodeDigitPoint(digit, this.passcodeKeypadLayout);
            await this.sendPointer(tapActions({ type: 'tap', x, y }));
            await delay(250);
        }
        await delay(600);
        if (await screenshotLooksAsleep(await this.getScreenshot(udid))) {
            try {
                await this.request('/wda/pressButton', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ name: 'home' }),
                    timeoutMs: 2_000,
                });
            } catch {
                // ignore
            }
            await delay(400);
        }
        if (await screenshotLooksAsleep(await this.getScreenshot(udid))) {
            throw new RemoteDeviceError('Device is still locked after entering the passcode');
        }
    }

    private async wakeDisplay(udid: string, width: number, height: number): Promise<void> {
        console.log('Waking device');
        // Synthetic taps do not wake a sleeping Face ID phone. Home does (it
        // maps to the home-indicator gesture). `/wda/unlock` waits for
        // SpringBoard to report unlocked and times out on a passcode screen.
        try {
            await this.request('/wda/pressButton', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'home' }),
                timeoutMs: 2_000,
            });
        } catch {
            // fall through
        }
        await delay(400);
        if (!await screenshotLooksAsleep(await this.getScreenshot(udid))) return;
        try {
            await this.request('/wda/unlock', { method: 'POST', timeoutMs: 2_000 });
        } catch {
            // keypad still required
        }
        await delay(300);
        if (!await screenshotLooksAsleep(await this.getScreenshot(udid))) return;
        await this.sendPointer(tapActions({ type: 'tap', x: Math.round(width / 2), y: Math.round(height / 2) }));
        for (let i = 0; i < 8; i += 1) {
            if (!await screenshotLooksAsleep(await this.getScreenshot(udid))) return;
            await delay(200);
        }
    }

    private async sendPointer(actions: W3cPointerSource[]): Promise<void> {
        await this.request('/wda/absolute-actions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ actions }),
        });
    }

    async performAction(udid: string, action: RemoteAction): Promise<void> {
        this.assertTarget(udid);
        if (action.type === 'home') {
            await this.request('/wda/homescreen', { method: 'POST' });
            return;
        }
        if (action.type === 'unlock') {
            await this.unlock(udid);
            return;
        }
        if (action.type === 'lock' || action.type === 'wake') {
            await this.request(action.type === 'lock' ? '/wda/lock' : '/wda/unlock', { method: 'POST' });
            return;
        }
        if (action.type === 'volumeUp' || action.type === 'volumeDown') {
            await this.request('/wda/pressButton', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: action.type === 'volumeUp' ? 'volumeup' : 'volumedown' }),
            });
            return;
        }
        // Screen size is static hardware info — reuse the cached value from a
        // prior getScreenInfo() call instead of paying a full WDA round trip
        // just to validate coordinates on every single tap/swipe.
        const screen = this.cachedScreenInfo ?? await this.getScreenInfo(udid);
        validateAction(action, screen.screenSize);
        const actions = action.type === 'tap' ? tapActions(action) : swipeActions(action);
        await this.request('/wda/absolute-actions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ actions }),
        });
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function validatePoint(x: number, y: number, { width, height }: ScreenSize): boolean {
    return Number.isFinite(x) && Number.isFinite(y)
        && x >= 0 && x <= width && y >= 0 && y <= height;
}

function validateAction(action: RemoteAction, screenSize: ScreenSize): void {
    if (action.type !== 'tap' && action.type !== 'swipe') return;
    const valid = action.type === 'tap'
        ? validatePoint(action.x, action.y, screenSize)
        : validatePoint(action.startX, action.startY, screenSize)
            && validatePoint(action.endX, action.endY, screenSize);
    if (!valid) {
        throw new RemoteDeviceError('Touch coordinates are outside the device screen');
    }
}

function pointerSource(actions: W3cActionItem[]): W3cPointerSource[] {
    return [{
        type: 'pointer',
        id: 'finger1',
        parameters: { pointerType: 'touch' },
        actions,
    }];
}

function tapActions({ x, y }: Extract<RemoteAction, { type: 'tap' }>): W3cPointerSource[] {
    return pointerSource([
        { type: 'pointerMove', duration: 0, x, y, origin: 'viewport' },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 80 },
        { type: 'pointerUp', button: 0 },
    ]);
}

function swipeActions({
    startX, startY, endX, endY, durationMs,
}: Extract<RemoteAction, { type: 'swipe' }>): W3cPointerSource[] {
    return pointerSource([
        { type: 'pointerMove', duration: 0, x: startX, y: startY, origin: 'viewport' },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 100 },
        { type: 'pointerMove', duration: durationMs, x: endX, y: endY, origin: 'viewport' },
        { type: 'pointerUp', button: 0 },
    ]);
}
