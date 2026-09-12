import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';

import type { Browser } from 'webdriverio';

import { loadRegisteredDevices, type WdaRemoteControl } from '@git-agni/phone-farm-core';
import { compositeVideo } from '../src/content/composite.js';
import type { PostManifest } from '../src/tiktok/post-manifest.js';
import { registeredAccounts } from '../src/tiktok/runtime-settings.js';
import { annotateTap } from '../src/tiktok/vision-debug.js';
import { parseVisionDecision, pointFromNormalized, type VideoVisionGoal, type VisionDecision } from '../src/tiktok/vision-guide.js';
import { runVideoVisionPost } from '../src/tiktok/vision-post.js';

const REPO = path.resolve(import.meta.dirname, '..');
const DASHBOARD = process.env.PHONE_FARM_URL ?? 'http://127.0.0.1:3000';
const SOURCE_CLIP = path.join(REPO, 'gallery/nub-lifestyle/IMG_0431.mov');
const HOOK_PREFIX = 'my own hand-written hook';

const SCREEN = { width: 414, height: 896, scale: 2 };
const XR_PICKER = { cellX: 68, cellStep: 168, firstY: 270, rowStep: 139 };

type Phase = 'feed' | 'camera' | 'picker' | 'editor' | 'caption' | 'keyboard' | 'ready' | 'drafted';

const TAPS = {
    create: { nx: 0.50, ny: 0.92 },
    gallery: { nx: 0.10, ny: 0.93 },
    videos: { nx: 0.22, ny: 0.14 },
    newest: { nx: 80 / 414, ny: 760 / 896 },
    newestTwo: { nx: 240 / 414, ny: 760 / 896 },
    newestThree: { nx: 390 / 414, ny: 700 / 896 },
    next: { nx: 0.74, ny: 0.93 },
    description: { nx: 0.22, ny: 0.14 },
    dismissKeyboard: { nx: 0.50, ny: 0.48 },
    drafts: { nx: 0.26, ny: 0.94 },
    yourStory: { nx: 0.22, ny: 0.94 },
    post: { nx: 0.75, ny: 0.94 },
} as const;

function manifest(caption = 'vision pipeline draft test'): PostManifest {
    return {
        device: { udid: 'u1', name: 'test' },
        files: [{ path: '/tmp/post.mp4', name: 'post.mp4', mimeType: 'video/mp4' }],
        caption,
        account: '@my_sane_tea',
        destination: 'draft',
    };
}

function decision(raw: VisionDecision): VisionDecision {
    return parseVisionDecision(JSON.stringify(raw));
}

function point(tap: { nx: number; ny: number }): { x: number; y: number } {
    return pointFromNormalized(tap.nx, tap.ny, SCREEN);
}

function tapped(taps: Array<{ x: number; y: number }>, tap: { nx: number; ny: number }): boolean {
    const expected = point(tap);
    return taps.some((item) => item.x === expected.x && item.y === expected.y);
}

async function loadLocalEnv(): Promise<void> {
    for (const file of ['.env', '.env.devices']) {
        const text = await readFile(path.join(REPO, file), 'utf8').catch(() => '');
        for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eq = trimmed.indexOf('=');
            if (eq < 1) continue;
            const key = trimmed.slice(0, eq);
            let value = trimmed.slice(eq + 1);
            if (
                (value.startsWith('"') && value.endsWith('"'))
                || (value.startsWith("'") && value.endsWith("'"))
            ) {
                value = value.slice(1, -1);
            }
            if (process.env[key] === undefined) process.env[key] = value;
        }
    }
}

async function reachable(url: string): Promise<boolean> {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        return response.ok;
    } catch {
        return false;
    }
}

async function makeDebugShotWriter(dir: string) {
    await mkdir(dir, { recursive: true });
    let index = 0;
    const files: string[] = [];
    return {
        files,
        async debugShot(
            label: string,
            options?: { image?: Buffer; tap?: { x: number; y: number }; scale?: number; label?: string },
        ) {
            index += 1;
            const safe = label.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
            const file = path.join(dir, `${String(index).padStart(2, '0')}-${safe}.png`);
            let png = options?.image ?? await sharp({
                create: { width: SCREEN.width, height: SCREEN.height, channels: 3, background: '#222' },
            }).png().toBuffer();
            if (options?.tap) {
                png = await annotateTap(png, options.tap, {
                    scale: options.scale ?? 1,
                    label: options.label ?? `${options.tap.x},${options.tap.y}`,
                });
            }
            await writeFile(file, png);
            files.push(file);
        },
    };
}

test('posts a draft video on the connected phone using the vision guide', { timeout: 12 * 60_000 }, async (t) => {
    await loadLocalEnv();
    const devices = (await loadRegisteredDevices()).filter((device) => !device.disabled);
    const device = devices.find((entry) => entry.udid === process.env.IOS_UDID) ?? devices[0];
    if (!device) {
        t.skip('No registered iPhone');
        return;
    }
    if (!process.env.OPENROUTER_API_KEY) {
        t.skip('OPENROUTER_API_KEY is not set');
        return;
    }
    if (!await reachable(process.env.WDA_URL ?? 'http://127.0.0.1:8100/status')) {
        t.skip('WebDriverAgent is not reachable');
        return;
    }
    if (!await reachable(`${DASHBOARD}/health`)) {
        t.skip('Farm dashboard is not running');
        return;
    }

    const accounts = registeredAccounts(device);
    const account = accounts.find((entry) => entry === '@my_sane_tea') ?? accounts[0];
    if (!account) {
        t.skip('No TikTok account is registered on this device');
        return;
    }

    const sourceExists = await readFile(SOURCE_CLIP).then(() => true).catch(() => false);
    if (!sourceExists) {
        t.skip(`Missing source clip ${SOURCE_CLIP}`);
        return;
    }

    const stamp = new Date().toISOString();
    const hook = `${HOOK_PREFIX}\n${stamp}`;
    const caption = `${HOOK_PREFIX} ${stamp}`;
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'vision-draft-video-'));
    const stampedVideo = path.join(workDir, 'post.mp4');
    await compositeVideo({
        clipPath: SOURCE_CLIP,
        trimStartSeconds: 14.5,
        durationSeconds: 5,
        hook,
        outputPath: stampedVideo,
    });
    const video = await readFile(stampedVideo);
    console.log(`Burned hook onto test video: ${hook.replace('\n', ' / ')}`);
    const before = await fetch(`${DASHBOARD}/api/devices/${encodeURIComponent(device.udid)}/posts/current`)
        .then((response) => response.json()) as { id?: string };

    const form = new FormData();
    form.set('destination', 'draft');
    form.set('account', account);
    form.set('caption', caption);
    form.set('media', new Blob([video], { type: 'video/mp4' }), 'post.mp4');

    const created = await fetch(`${DASHBOARD}/api/devices/${encodeURIComponent(device.udid)}/posts`, {
        method: 'POST',
        headers: { Origin: DASHBOARD },
        body: form,
    });
    assert.equal(created.status, 202, await created.text());

    const deadline = Date.now() + 11 * 60_000;
    let current: { id?: string; status?: string; logs?: string[]; error?: string } = {};
    while (Date.now() < deadline) {
        current = await fetch(`${DASHBOARD}/api/devices/${encodeURIComponent(device.udid)}/posts/current`)
            .then((response) => response.json()) as typeof current;
        if (current.id && current.id !== before.id && ['succeeded', 'failed', 'cancelled', 'stopped'].includes(current.status ?? '')) {
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 3_000));
    }

    const logs = (current.logs ?? []).join('\n');
    assert.equal(current.status, 'succeeded', current.error ?? logs.slice(-2_000));
    assert.match(logs, /TikTok draft saved/);
    assert.match(logs, /Vision /);
    assert.match(logs, new RegExp(`Caption added: ${HOOK_PREFIX} ${stamp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(logs, /Debug screenshot .*tap/);
    assert.match(logs, /Vision pick_newest_video snapped |Tapped vision pick_newest_video/);
    assert.doesNotMatch(logs, /Tapped vision [^\n]*: Your Story at /);
    assert.doesNotMatch(logs, /Tapped vision [^\n]*: Go Live at /);
    const shotDir = logs.match(/Debug screenshots: (.+)$/m)?.[1];
    if (shotDir) console.log(`Live draft annotated shots: ${shotDir}`);
    console.log(`Verify on-video hook+timestamp in Photos/TikTok draft: ${hook.replace('\n', ' / ')}`);
});

test('scripted vision guide draws taps on screenshots and keeps a timestamp caption', async () => {
    let phase: Phase = 'feed';
    let videosFilter = false;
    const taps: Array<{ x: number; y: number; label?: string }> = [];
    const typed: string[] = [];
    const stamp = '2026-09-12T03:40:00.000Z';
    const caption = `${HOOK_PREFIX} ${stamp}`;
    const screenshot = await sharp({
        create: { width: SCREEN.width, height: SCREEN.height, channels: 3, background: '#111111' },
    }).png().toBuffer();
    const shotDir = await mkdtemp(path.join(os.tmpdir(), 'vision-tap-shots-'));
    const { files, debugShot } = await makeDebugShotWriter(shotDir);

    const ask = async (options: { goal: VideoVisionGoal }): Promise<VisionDecision> => {
        const { goal } = options;
        if (goal === 'reach_post_camera') {
            if (phase === 'camera') return decision({ screen: 'camera', goalMet: true, action: 'wait', reason: 'POST camera' });
            return decision({ screen: 'feed', goalMet: false, action: 'tap', ...TAPS.create, reason: 'Create' });
        }
        if (goal === 'open_gallery') {
            if (phase === 'picker') return decision({ screen: 'picker', goalMet: true, action: 'wait', reason: 'gallery open' });
            return decision({ screen: 'camera', goalMet: false, action: 'tap', ...TAPS.gallery, reason: 'album thumbnail' });
        }
        if (goal === 'pick_newest_video') {
            if (phase === 'editor') return decision({ screen: 'editor', goalMet: true, action: 'wait', reason: 'video opened' });
            if (!videosFilter) return decision({ screen: 'picker', goalMet: false, action: 'tap', ...TAPS.videos, reason: 'Videos filter' });
            return decision({ screen: 'picker', goalMet: false, action: 'tap', ...TAPS.newest, reason: 'last filled cell' });
        }
        if (goal === 'leave_editor') {
            if (phase === 'caption' || phase === 'keyboard' || phase === 'ready') {
                return decision({ screen: 'caption', goalMet: true, action: 'wait', reason: 'caption composer' });
            }
            return decision({ screen: 'editor', goalMet: false, action: 'tap', ...TAPS.next, reason: 'editor Next' });
        }
        if (goal === 'fill_caption') {
            if (phase === 'ready') return decision({ screen: 'caption', goalMet: true, action: 'wait', reason: 'keyboard dismissed' });
            if (phase === 'keyboard') return decision({ screen: 'keyboard', goalMet: false, action: 'tap', ...TAPS.dismissKeyboard, reason: 'dismiss keyboard' });
            return decision({ screen: 'caption', goalMet: false, action: 'tap', ...TAPS.description, reason: 'Add description' });
        }
        if (phase === 'drafted') return decision({ screen: 'caption', goalMet: true, action: 'wait', reason: 'draft saved' });
        return decision({ screen: 'caption', goalMet: false, action: 'tap', ...TAPS.drafts, reason: 'Drafts' });
    };

    const driver = {
        async performActions(sources: Array<{ actions: Array<{ type: string; x?: number; y?: number }> }>) {
            const move = sources[0]?.actions.find((action) => action.type === 'pointerMove');
            const x = move?.x ?? 0;
            const y = move?.y ?? 0;
            taps.push({ x, y });
            const nx = x / SCREEN.width;
            const ny = y / SCREEN.height;
            if (phase === 'feed' && ny > 0.85) phase = 'camera';
            else if (phase === 'camera' && nx < 0.2 && ny > 0.85) phase = 'picker';
            else if (phase === 'picker' && ny < 0.2 && nx < 0.3) videosFilter = true;
            else if (phase === 'picker' && ny > 0.65) phase = 'editor';
            else if (phase === 'editor' && nx > 0.55 && ny > 0.85) phase = 'caption';
            else if (phase === 'caption' && ny < 0.25) phase = 'keyboard';
            else if (phase === 'keyboard' && ny > 0.35 && ny < 0.7) phase = 'ready';
            else if ((phase === 'ready' || phase === 'caption') && nx < 0.45 && ny > 0.85) phase = 'drafted';
        },
        async releaseActions() {},
        async pause() {},
    } as unknown as Browser;

    const remote = {
        async getScreenshot() { return screenshot; },
        async getScreenInfo() { return { screenSize: { width: SCREEN.width, height: SCREEN.height }, scale: 1 }; },
    } as unknown as WdaRemoteControl;

    await runVideoVisionPost({
        driver,
        remote,
        udid: 'u1',
        manifest: manifest(caption),
        typeKeys: async (_driver, text) => { typed.push(text); },
        ask,
        pause: async () => {},
        debugShot,
        finishPoint: { x: 108, y: 846 },
        videoPicker: XR_PICKER,
    });

    assert.equal(phase, 'drafted');
    assert.deepEqual(typed, [caption]);
    assert.match(typed[0] ?? '', /my own hand-written hook 2026-09-12T03:40:00\.000Z/);
    assert.equal(tapped(taps, TAPS.create), true);
    assert.equal(tapped(taps, TAPS.gallery), true);
    assert.equal(tapped(taps, TAPS.videos), true);
    assert.equal(taps.some((tap) => tap.x === 68 && tap.y === 786), true);
    assert.equal(tapped(taps, TAPS.next), true);
    assert.equal(tapped(taps, TAPS.description), true);
    assert.equal(tapped(taps, TAPS.dismissKeyboard), true);
    assert.equal(taps.some((tap) => tap.x === 108 && tap.y === 846), true);
    assert.equal(tapped(taps, TAPS.yourStory), false);
    assert.equal(tapped(taps, TAPS.post), false);

    const tapShots = files.filter((file) => path.basename(file).includes('-tap'));
    assert.ok(tapShots.length >= 4, `expected annotated tap shots, got ${files.map((f) => path.basename(f)).join(', ')}`);
    const pickCellShots = tapShots.filter((file) => path.basename(file).includes('pick-newest-video-tap'));
    assert.ok(pickCellShots.length >= 2, 'expected Videos filter and cell tap shots');
    const cellShot = pickCellShots[pickCellShots.length - 1]!;
    const { data, info } = await sharp(cellShot).raw().toBuffer({ resolveWithObject: true });
    const index = (x: number, y: number) => (y * info.width + x) * info.channels;
    const center = index(68, 786);
    assert.ok(data[center] > 200 && data[center + 1] > 200, 'pick shot should mark the snapped cell center');
});

test('vision guide refuses Your Story then still reaches Drafts', async () => {
    let phase: Phase = 'editor';
    let nextAsked = 0;
    const taps: Array<{ x: number; y: number }> = [];
    const screenshot = await sharp({ create: { width: 20, height: 40, channels: 3, background: '#111' } }).png().toBuffer();

    let picked = false;
    const ask = async (options: { goal: VideoVisionGoal }): Promise<VisionDecision> => {
        if (options.goal === 'reach_post_camera') return decision({ screen: 'camera', goalMet: true, action: 'wait', reason: 'already camera' });
        if (options.goal === 'open_gallery') return decision({ screen: 'picker', goalMet: true, action: 'wait', reason: 'already picker' });
        if (options.goal === 'pick_newest_video') {
            if (picked) return decision({ screen: 'editor', goalMet: true, action: 'wait', reason: 'already editor' });
            picked = true;
            return decision({ screen: 'picker', goalMet: false, action: 'tap', ...TAPS.newest, reason: 'newest cell' });
        }
        if (options.goal === 'leave_editor') {
            if (phase === 'caption' || phase === 'ready') return decision({ screen: 'caption', goalMet: true, action: 'wait', reason: 'caption' });
            nextAsked += 1;
            if (nextAsked === 1) return decision({ screen: 'editor', goalMet: false, action: 'tap', ...TAPS.yourStory, reason: 'Your Story' });
            return decision({ screen: 'editor', goalMet: false, action: 'tap', ...TAPS.next, reason: 'Next' });
        }
        if (options.goal === 'fill_caption') {
            if (phase === 'caption') {
                phase = 'ready';
                return decision({ screen: 'caption', goalMet: true, action: 'wait', reason: 'no keyboard' });
            }
            return decision({ screen: 'caption', goalMet: true, action: 'wait', reason: 'ready' });
        }
        if (phase === 'drafted') return decision({ screen: 'caption', goalMet: true, action: 'wait', reason: 'saved' });
        return decision({ screen: 'caption', goalMet: false, action: 'tap', ...TAPS.drafts, reason: 'Drafts' });
    };

    const driver = {
        async performActions(sources: Array<{ actions: Array<{ type: string; x?: number; y?: number }> }>) {
            const move = sources[0]?.actions.find((action) => action.type === 'pointerMove');
            taps.push({ x: move?.x ?? 0, y: move?.y ?? 0 });
            const nx = (move?.x ?? 0) / SCREEN.width;
            const ny = (move?.y ?? 0) / SCREEN.height;
            if (phase === 'editor' && nx > 0.55 && ny > 0.85) phase = 'caption';
            if ((phase === 'caption' || phase === 'ready') && nx < 0.45 && ny > 0.85) phase = 'drafted';
        },
        async releaseActions() {},
        async pause() {},
    } as unknown as Browser;

    const remote = {
        async getScreenshot() { return screenshot; },
        async getScreenInfo() { return { screenSize: { width: SCREEN.width, height: SCREEN.height }, scale: SCREEN.scale }; },
    } as unknown as WdaRemoteControl;

    await runVideoVisionPost({
        driver,
        remote,
        udid: 'u1',
        manifest: { ...manifest(), caption: undefined },
        typeKeys: async () => {},
        ask,
        pause: async () => {},
        videoPicker: XR_PICKER,
    });

    assert.equal(phase, 'drafted');
    assert.equal(tapped(taps, TAPS.yourStory), false);
    assert.equal(tapped(taps, TAPS.post), false);
    assert.equal(tapped(taps, TAPS.next), true);
    assert.equal(tapped(taps, TAPS.drafts), true);
});

test('vision guide snaps the last filled cell for a 1-cell or 3-cell bottom row', async () => {
    const screenshot = await sharp({ create: { width: 20, height: 40, channels: 3, background: '#111' } }).png().toBuffer();

    async function pick(tap: { nx: number; ny: number }, expected: { x: number; y: number }) {
        let phase: Phase = 'picker';
        const taps: Array<{ x: number; y: number }> = [];
        const ask = async (options: { goal: VideoVisionGoal }): Promise<VisionDecision> => {
            if (options.goal === 'reach_post_camera') return decision({ screen: 'camera', goalMet: true, action: 'wait', reason: 'camera' });
            if (options.goal === 'open_gallery') return decision({ screen: 'picker', goalMet: true, action: 'wait', reason: 'picker' });
            if (options.goal === 'pick_newest_video') {
                if (phase === 'editor') return decision({ screen: 'editor', goalMet: true, action: 'wait', reason: 'opened' });
                return decision({ screen: 'picker', goalMet: false, action: 'tap', ...tap, reason: 'last filled' });
            }
            if (options.goal === 'leave_editor') return decision({ screen: 'caption', goalMet: true, action: 'wait', reason: 'caption' });
            if (options.goal === 'fill_caption') return decision({ screen: 'caption', goalMet: true, action: 'wait', reason: 'ready' });
            if (phase === 'drafted') return decision({ screen: 'caption', goalMet: true, action: 'wait', reason: 'saved' });
            return decision({ screen: 'caption', goalMet: false, action: 'tap', ...TAPS.drafts, reason: 'Drafts' });
        };
        const driver = {
            async performActions(sources: Array<{ actions: Array<{ type: string; x?: number; y?: number }> }>) {
                const move = sources[0]?.actions.find((action) => action.type === 'pointerMove');
                taps.push({ x: move?.x ?? 0, y: move?.y ?? 0 });
                if (move?.x === expected.x && move?.y === expected.y) phase = 'editor';
                if (move?.x === 108 && (move?.y === 842 || move?.y === 846)) phase = 'drafted';
            },
            async releaseActions() {},
            async pause() {},
        } as unknown as Browser;
        const remote = {
            async getScreenshot() { return screenshot; },
            async getScreenInfo() { return { screenSize: { width: SCREEN.width, height: SCREEN.height }, scale: SCREEN.scale }; },
        } as unknown as WdaRemoteControl;
        await runVideoVisionPost({
            driver,
            remote,
            udid: 'u1',
            manifest: { ...manifest(), caption: undefined },
            typeKeys: async () => {},
            ask,
            pause: async () => {},
            videoPicker: XR_PICKER,
            finishPoint: { x: 108, y: 846 },
        });
        assert.equal(taps.some((item) => item.x === expected.x && item.y === expected.y), true);
    }

    await pick(TAPS.newest, { x: 68, y: 786 });
    await pick(TAPS.newestTwo, { x: 236, y: 786 });
    await pick(TAPS.newestThree, { x: 404, y: 647 });
});

test('vision guide keeps a last-row pick even if the model tries the editor back chevron', async () => {
    let phase: Phase = 'picker';
    const taps: Array<{ x: number; y: number }> = [];
    const screenshot = await sharp({ create: { width: 20, height: 40, channels: 3, background: '#111' } }).png().toBuffer();
    const lastRow = { nx: 339 / 414, ny: 762 / 896 };
    const backChevron = { nx: 23 / 414, ny: 44 / 896 };

    const ask = async (options: { goal: VideoVisionGoal }): Promise<VisionDecision> => {
        if (options.goal === 'reach_post_camera') return decision({ screen: 'camera', goalMet: true, action: 'wait', reason: 'camera' });
        if (options.goal === 'open_gallery') return decision({ screen: 'picker', goalMet: true, action: 'wait', reason: 'picker' });
        if (options.goal === 'pick_newest_video') {
            if (phase === 'editor') {
                return decision({ screen: 'editor', goalMet: false, action: 'tap', ...backChevron, reason: 'back to re-pick' });
            }
            return decision({ screen: 'picker', goalMet: false, action: 'tap', ...lastRow, reason: 'rightmost filled last row' });
        }
        if (options.goal === 'leave_editor') return decision({ screen: 'caption', goalMet: true, action: 'wait', reason: 'caption' });
        if (options.goal === 'fill_caption') return decision({ screen: 'caption', goalMet: true, action: 'wait', reason: 'ready' });
        if (phase === 'drafted') return decision({ screen: 'caption', goalMet: true, action: 'wait', reason: 'saved' });
        return decision({ screen: 'caption', goalMet: false, action: 'tap', ...TAPS.drafts, reason: 'Drafts' });
    };

    const driver = {
        async performActions(sources: Array<{ actions: Array<{ type: string; x?: number; y?: number }> }>) {
            const move = sources[0]?.actions.find((action) => action.type === 'pointerMove');
            taps.push({ x: move?.x ?? 0, y: move?.y ?? 0 });
            if (phase === 'picker' && (move?.y ?? 0) > 600) phase = 'editor';
            if (move?.x === 108 && (move?.y === 842 || move?.y === 846)) phase = 'drafted';
        },
        async releaseActions() {},
        async pause() {},
    } as unknown as Browser;

    const remote = {
        async getScreenshot() { return screenshot; },
        async getScreenInfo() { return { screenSize: { width: SCREEN.width, height: SCREEN.height }, scale: SCREEN.scale }; },
    } as unknown as WdaRemoteControl;

    await runVideoVisionPost({
        driver,
        remote,
        udid: 'u1',
        manifest: { ...manifest(), caption: undefined },
        typeKeys: async () => {},
        ask,
        pause: async () => {},
        videoPicker: XR_PICKER,
        finishPoint: { x: 108, y: 846 },
    });

    assert.equal(phase, 'drafted');
    assert.equal(taps.some((tap) => tap.x <= 30 && tap.y <= 60), false);
    assert.equal(taps.some((tap) => tap.y > 600 && tap.y < 830), true);
});

test('vision guide retries a timed-out WDA screenshot then finishes the draft', async () => {
    let phase: Phase = 'ready';
    let shots = 0;
    const taps: Array<{ x: number; y: number }> = [];
    const screenshot = await sharp({ create: { width: 20, height: 40, channels: 3, background: '#111' } }).png().toBuffer();

    let picked = false;
    const ask = async (options: { goal: VideoVisionGoal }): Promise<VisionDecision> => {
        if (options.goal === 'pick_newest_video') {
            if (picked) return decision({ screen: 'editor', goalMet: true, action: 'wait', reason: 'already there' });
            picked = true;
            return decision({ screen: 'picker', goalMet: false, action: 'tap', ...TAPS.newest, reason: 'newest cell' });
        }
        if (options.goal !== 'finish') {
            const screens = {
                reach_post_camera: 'camera',
                open_gallery: 'picker',
                leave_editor: 'caption',
                fill_caption: 'caption',
            } as const;
            return decision({ screen: screens[options.goal], goalMet: true, action: 'wait', reason: 'already there' });
        }
        if (phase === 'drafted') return decision({ screen: 'caption', goalMet: true, action: 'wait', reason: 'saved' });
        return decision({ screen: 'caption', goalMet: false, action: 'tap', ...TAPS.drafts, reason: 'Drafts' });
    };

    const driver = {
        async performActions(sources: Array<{ actions: Array<{ type: string; x?: number; y?: number }> }>) {
            const move = sources[0]?.actions.find((action) => action.type === 'pointerMove');
            taps.push({ x: move?.x ?? 0, y: move?.y ?? 0 });
            if (move?.x === Math.round(TAPS.drafts.nx * SCREEN.width) || (move?.x === 108 && (move?.y === 842 || move?.y === 846))) {
                phase = 'drafted';
            }
        },
        async releaseActions() {},
        async pause() {},
    } as unknown as Browser;

    const remote = {
        async getScreenshot() {
            shots += 1;
            if (shots === 1) throw new Error('The operation was aborted due to timeout');
            return screenshot;
        },
        async getScreenInfo() { return { screenSize: { width: SCREEN.width, height: SCREEN.height }, scale: SCREEN.scale }; },
    } as unknown as WdaRemoteControl;

    await runVideoVisionPost({
        driver,
        remote,
        udid: 'u1',
        manifest: { ...manifest(), caption: undefined },
        typeKeys: async () => {},
        ask,
        pause: async () => {},
        videoPicker: XR_PICKER,
    });

    assert.equal(phase, 'drafted');
    assert.ok(shots >= 2);
    assert.equal(tapped(taps, TAPS.drafts), true);
});
