import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';

import { screenshotLooksAsleep, WdaRemoteControl } from '../src/devices/wda-remote.js';

function jsonResponse(value: unknown): Response {
    return new Response(JSON.stringify({ value }), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function solidPng(r: number, g: number, b: number): Promise<Buffer> {
    return sharp({ create: { width: 20, height: 20, channels: 3, background: { r, g, b } } }).png().toBuffer();
}

test('screenshotLooksAsleep is true only for a near-black frame', async () => {
    assert.equal(await screenshotLooksAsleep(await solidPng(0, 0, 0)), true);
    assert.equal(await screenshotLooksAsleep(await solidPng(40, 40, 50)), false);
});

function instantRemote(options: ConstructorParameters<typeof WdaRemoteControl>[0]) {
    return new WdaRemoteControl({ wait: async () => {}, ...options });
}

test('unlock is a no-op when WDA says unlocked and the screen is on', async () => {
    const light = await solidPng(180, 180, 190);
    const calls: string[] = [];
    const remote = instantRemote({
        deviceUdid: 'u1',
        passcode: '1234',
        fetchImpl: (async (url: string) => {
            const pathname = new URL(url).pathname;
            calls.push(pathname);
            if (pathname === '/wda/locked') return jsonResponse(false);
            if (pathname === '/screenshot') return jsonResponse(light.toString('base64'));
            throw new Error(`unexpected ${pathname}`);
        }) as typeof fetch,
    });
    await remote.unlock('u1');
    assert.deepEqual(calls, ['/wda/locked', '/screenshot']);
});

test('unlock wakes and types the passcode when the screen is off even if WDA says unlocked', async () => {
    const black = await solidPng(0, 0, 0);
    const light = await solidPng(180, 180, 190);
    let shots = 0;
    const calls: string[] = [];
    const remote = instantRemote({
        deviceUdid: 'u1',
        passcode: '12',
        passcodeKeypadLayout: { columnX: [100, 200, 300], rowY: [200, 300, 400, 500] },
        fetchImpl: (async (url: string, init?: RequestInit) => {
            const pathname = new URL(url).pathname;
            calls.push(`${init?.method ?? 'GET'} ${pathname}`);
            if (pathname === '/wda/locked') return jsonResponse(false);
            if (pathname === '/wda/screen') {
                return jsonResponse({ screenSize: { width: 414, height: 896 }, scale: 2 });
            }
            if (pathname === '/screenshot') {
                shots += 1;
                return jsonResponse((shots === 1 ? black : light).toString('base64'));
            }
            return jsonResponse(null);
        }) as typeof fetch,
    });
    await remote.unlock('u1');
    assert.ok(calls.includes('POST /wda/pressButton'), 'presses Home to wake a sleeping Face ID phone');
    assert.equal(calls.filter((call) => call === 'POST /wda/absolute-actions').length, 3, 'swipe + two digit taps');
});

test('unlock retries three times then throws while the phone stays locked', async () => {
    const light = await solidPng(180, 180, 190);
    let passcodeEntries = 0;
    const remote = instantRemote({
        deviceUdid: 'u1',
        passcode: '1',
        passcodeKeypadLayout: { columnX: [100, 200, 300], rowY: [200, 300, 400, 500] },
        fetchImpl: (async (url: string) => {
            const pathname = new URL(url).pathname;
            if (pathname === '/wda/locked') return jsonResponse(true);
            if (pathname === '/wda/screen') {
                return jsonResponse({ screenSize: { width: 414, height: 896 }, scale: 2 });
            }
            if (pathname === '/screenshot') return jsonResponse(light.toString('base64'));
            if (pathname === '/wda/absolute-actions' && passcodeEntries < 20) {
                // Each attempt: Face ID swipe + one digit.
                passcodeEntries += 1;
            }
            return jsonResponse(null);
        }) as typeof fetch,
    });
    await assert.rejects(
        () => remote.unlock('u1'),
        /still locked after 3 unlock attempts/,
    );
    assert.equal(passcodeEntries, 6, 'three wake+swipe+digit attempts');
});

test('unlock succeeds on a later attempt once SpringBoard reports unlocked', async () => {
    const light = await solidPng(180, 180, 190);
    let lockedChecks = 0;
    const remote = instantRemote({
        deviceUdid: 'u1',
        passcode: '1',
        passcodeKeypadLayout: { columnX: [100, 200, 300], rowY: [200, 300, 400, 500] },
        fetchImpl: (async (url: string) => {
            const pathname = new URL(url).pathname;
            if (pathname === '/wda/locked') {
                lockedChecks += 1;
                // Initial needsUnlock + after attempt 1 still locked; after attempt 2 unlocked.
                return jsonResponse(lockedChecks < 3);
            }
            if (pathname === '/wda/screen') {
                return jsonResponse({ screenSize: { width: 414, height: 896 }, scale: 2 });
            }
            if (pathname === '/screenshot') return jsonResponse(light.toString('base64'));
            return jsonResponse(null);
        }) as typeof fetch,
    });
    await remote.unlock('u1');
    assert.ok(lockedChecks >= 3);
});
