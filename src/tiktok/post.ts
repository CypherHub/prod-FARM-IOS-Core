import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { remote, type Browser } from 'webdriverio';

import { loadRegisteredDevices, passcodeForDevice, resolveDeviceCoordinates, WdaRemoteControl } from '@git-agni/phone-farm-core';
import type { PostManifest } from './post-manifest.js';
import { type TikTokCoordinates } from './coordinates.js';
import { tiktokAppiumCapabilities, foregroundTikTok, backgroundTikTok } from './appium-session.js';
import { coordinateProfile, registeredAccounts } from './runtime-settings.js';
import { switchTikTokAccount, tapCoordinate } from './actions.js';
import { pointFromWord, recognizeWords } from './ocr.js';
import { SELECT_MULTIPLE_SELECTORS } from './checkbox.js';
import { newestPickerCell, pickerCircle, recentPickerTargets, type PickerLayout } from './post-layout.js';
import { splitComposerCopy } from './post-compose.js';
import { isCaptionComposer, isLiveCamera, isMediaPicker, isTextStoryComposer, isVideoEditorStoryBar, lowestExactWord } from './post-camera.js';
import { redCheckboxPixelCount } from './pixel.js';
import { deepSeekConfig } from './vision-guide.js';
import { annotateTap } from './vision-debug.js';
import { finishVideoVisionPost, runVideoVisionToCaption } from './vision-post.js';

const DEBUG_SHOT_DIR = process.env.DEBUG_SHOT_DIR
    ?? path.resolve('.wda', 'vision-shots', new Date().toISOString().replace(/[:.]/g, '-'));
let debugShotIndex = 0;
let debugRemote: WdaRemoteControl | undefined;
let debugUdid: string | undefined;

async function debugShot(
    label: string,
    options?: { image?: Buffer; tap?: { x: number; y: number }; scale?: number; label?: string },
): Promise<void> {
    if (!DEBUG_SHOT_DIR || !debugRemote || !debugUdid) return;
    try {
        await mkdir(DEBUG_SHOT_DIR, { recursive: true });
        debugShotIndex += 1;
        const safe = label.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
        const file = path.join(DEBUG_SHOT_DIR, `${String(debugShotIndex).padStart(2, '0')}-${safe}.png`);
        let png = options?.image ?? await debugRemote.getScreenshot(debugUdid);
        if (options?.tap) {
            png = await annotateTap(png, options.tap, {
                scale: options.scale,
                label: options.label ?? `${options.tap.x},${options.tap.y}`,
            });
        }
        await writeFile(file, png);
        console.log(`Debug screenshot ${path.basename(file)}${options?.tap ? ` tap=(${options.tap.x},${options.tap.y})` : ''}`);
    } catch (error) {
        console.log(`Debug screenshot skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function positiveInteger(name: string, fallback: number): number {
    const raw = process.env[name] ?? String(fallback);
    const value = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    return value;
}

function appiumFailedBecauseLocked(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return /could not be, unlocked|device was not, or could not be, unlocked|reason: Locked/i.test(message);
}

async function importMedia(manifest: PostManifest): Promise<number> {
    const wdaUrl = process.env.WDA_URL ?? 'http://127.0.0.1:8100';
    let assetCount = 0;
    // Photos Recents is newest-first. Reverse import makes cell 0 the user's first item.
    for (const [index, file] of [...manifest.files].reverse().entries()) {
        console.log(`Importing media ${manifest.files.length - index}/${manifest.files.length}: ${file.name}`);
        const data = await readFile(file.path);
        // WDA's /wda/import-media takes the whole file base64-encoded in a JSON
        // body. base64 is 4*ceil(n/3) chars and JSON.stringify allocates a
        // second copy; Node's max string length (~512 MiB) caps the input near
        // 384 MiB, so refuse well before that.
        if (data.length > 350 * 1024 * 1024) {
            throw new Error(`${file.name} is ${(data.length / 1_048_576).toFixed(0)} MB — the TikTok media import limit is 350 MB`);
        }
        const response = await fetch(`${wdaUrl}/wda/import-media`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: file.name, mimeType: file.mimeType, data: data.toString('base64') }),
        });
        const result = await response.json() as { value?: { error?: unknown; assetCount?: number } };
        if (!response.ok || (result.value && typeof result.value === 'object' && 'error' in result.value)) {
            throw new Error(`WDA could not import ${file.name}: ${JSON.stringify(result)}`);
        }
        assetCount = result.value?.assetCount ?? 0;
    }
    if (!assetCount) throw new Error('WDA did not return the Photos asset count');
    return assetCount;
}

async function firstDisplayed(driver: Browser, selectors: string[]) {
    for (const selector of selectors) {
        const candidate = await driver.$(selector);
        if (await candidate.isExisting() && await candidate.isDisplayed()) return candidate;
    }
    return undefined;
}

async function dismissIfPresent(driver: Browser, label: string, selectors: string[]): Promise<void> {
    const element = await firstDisplayed(driver, selectors);
    if (!element) return;
    await element.click();
    console.log(`Tapped ${label}`);
    await driver.pause(1000);
}

const DONT_ALLOW_SELECTORS = [
    '-ios predicate string:(label CONTAINS[c] "Don\'t allow") OR (name CONTAINS[c] "Don\'t allow") OR (label CONTAINS[c] "Don’t allow") OR (name CONTAINS[c] "Don’t allow")',
];
const SAVE_DRAFT_SELECTORS = [
    '-ios predicate string:(label == "Save draft") OR (name == "Save draft")',
];
const GOT_IT_SELECTORS = [
    '-ios predicate string:(label == "Got it") OR (name == "Got it")',
];
const USE_SOUND_SELECTORS = [
    '-ios predicate string:(label CONTAINS[c] "Use this sound") OR (name CONTAINS[c] "Use this sound") OR (label CONTAINS[c] "Use sound") OR (name CONTAINS[c] "Use sound")',
];
const PHOTOS_FILTER_SELECTORS = [
    '-ios predicate string:(label == "Photos") OR (name == "Photos")',
];
const VIDEOS_FILTER_SELECTORS = [
    '-ios predicate string:(label == "Videos") OR (name == "Videos")',
];

async function dismissComposerBlockers(driver: Browser): Promise<void> {
    await dismissIfPresent(driver, "Don't allow", DONT_ALLOW_SELECTORS);
    await dismissIfPresent(driver, 'Save draft', SAVE_DRAFT_SELECTORS);
    await dismissIfPresent(driver, 'Got it', GOT_IT_SELECTORS);
}

async function tapOcrWord(
    driver: Browser,
    words: Awaited<ReturnType<typeof recognizeWords>>,
    scale: number,
    needles: string[],
    label: string,
): Promise<boolean> {
    const normalizedNeedles = needles.map((needle) => needle.toLowerCase().replace(/[’]/g, "'"));
    const match = words.find((word) => {
        const text = word.text.toLowerCase().replace(/[’]/g, "'");
        return normalizedNeedles.some((needle) => text === needle || text.includes(needle));
    });
    if (!match) return false;
    const point = pointFromWord(match, scale);
    await tapCoordinate(driver, point.x, point.y, label);
    await driver.pause(800);
    return true;
}

async function waitUntilFeedReady(driver: Browser, remote: WdaRemoteControl, udid: string): Promise<void> {
    // Do not query TikTok's accessibility tree on the For You feed — predicate
    // finds snapshot the whole video UI and have hung WDA for minutes.
    for (let attempt = 1; attempt <= 12; attempt += 1) {
        let scale: number;
        let screenshot: Buffer;
        try {
            ({ scale } = await remote.getScreenInfo(udid));
            screenshot = await remote.getScreenshot(udid);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!/aborted|timeout|ETIMEDOUT|ECONNRESET/i.test(message)) throw error;
            console.log(`TikTok feed check timed out (${attempt}/12): ${message}`);
            await driver.pause(1_200);
            continue;
        }
        const words = await recognizeWords(screenshot);
        const text = words.map((word) => word.text.toLowerCase().replace(/[’]/g, "'")).join(' ');
        let dismissed = false;
        if (text.includes('find contacts') || text.includes("don't allow") || text.includes('dont allow')) {
            dismissed = await tapOcrWord(driver, words, scale, ["don't", 'dont'], "Don't allow")
                || (await tapCoordinate(driver, 110, 705, "Don't allow (fallback)"), true);
            await driver.pause(800);
        }
        if (text.includes('continue editing') || (text.includes('save') && text.includes('draft') && text.includes('edit'))) {
            dismissed = await tapOcrWord(driver, words, scale, ['save'], 'Save draft') || dismissed;
        }
        if (text.includes('got it')) {
            dismissed = await tapOcrWord(driver, words, scale, ['got'], 'Got it') || dismissed;
        }
        if (text.includes('cancel') && (text.includes('search') || text.includes('fearch') || text.includes('autofill') || text.includes('sounds'))) {
            dismissed = await tapOcrWord(driver, words, scale, ['cancel'], 'Cancel') || dismissed;
        }
        if (isMediaPicker(words) || (text.includes('recents') && (text.includes('select multiple') || text.includes('use layout')))) {
            dismissed = await tapOcrWord(driver, words, scale, ['x'], 'Close leftover picker')
                || (await tapCoordinate(driver, 22, 58, 'Close leftover picker'), true);
        }
        if (isCaptionComposer(words) || text.includes('everyone can view') || text.includes('descriptionideas') || (text.includes('add link') && text.includes('location'))
            || (text.includes('edit') && text.includes('cover') && text.includes('hashtags'))) {
            if (text.includes('hashtags') && (text.includes('space') || text.includes('123') || text.includes('mention'))) {
                await tapCoordinate(driver, 207, 480, 'Dismiss leftover caption keyboard');
                await driver.pause(800);
            }
            dismissed = await tapOcrWord(driver, words, scale, ['x'], 'Close leftover composer')
                || (await tapCoordinate(driver, 24, 56, 'Close leftover composer'), true);
            await driver.pause(800);
            const afterWords = await recognizeWords(await remote.getScreenshot(udid));
            const after = afterWords.map((word) => word.text.toLowerCase().replace(/[’']/g, "'")).join(' ');
            if (after.includes('continue editing') || (after.includes('save') && after.includes('draft'))) {
                await tapOcrWord(driver, afterWords, scale, ['save'], 'Save leftover draft')
                    || (await tapCoordinate(driver, 207, 520, 'Save leftover draft (fallback)'), true);
            }
        }
        if (text.includes('select all') && text.includes('cancel') && text.includes('draft')) {
            dismissed = await tapOcrWord(driver, words, scale, ['cancel'], 'Close leftover drafts list')
                || (await tapCoordinate(driver, 24, 56, 'Close leftover drafts list'), true);
        }
        if (isTextStoryComposer(words) || isLiveCamera(words) || isVideoEditorStoryBar(words)) {
            dismissed = (await tapCoordinate(driver, 24, 56, 'Close leftover TEXT/LIVE/editor'), true);
            await driver.pause(800);
        }
        if (['finding content', 'choose your', 'interests', 'swipe up', 'find contacts', 'continue editing'].some((token) => text.includes(token))) {
            console.log(`TikTok still blocked/onboarding (${attempt}/12)`);
            await debugShot(`blocked-${attempt}`);
            await driver.pause(1200);
            continue;
        }
        if (dismissed) {
            await driver.pause(800);
            continue;
        }
        console.log('TikTok is interactive');
        await debugShot('interactive');
        return;
    }
    console.log('TikTok feed did not look ready; continuing');
}

async function tapOcrMode(
    driver: Browser,
    remote: WdaRemoteControl,
    udid: string,
    needle: string,
    fallback: { x: number; y: number },
    label: string,
): Promise<void> {
    const { scale } = await remote.getScreenInfo(udid);
    const match = lowestExactWord(await recognizeWords(await remote.getScreenshot(udid)), needle);
    if (match) {
        const point = pointFromWord(match, scale);
        await tapCoordinate(driver, point.x, point.y, label);
        return;
    }
    await tapCoordinate(driver, fallback.x, fallback.y, `${label} (fallback)`);
}

async function ensurePostCamera(
    driver: Browser,
    remote: WdaRemoteControl,
    udid: string,
    postTab: { x: number; y: number },
): Promise<void> {
    const words = await recognizeWords(await remote.getScreenshot(udid));
    if (isTextStoryComposer(words)) {
        throw new Error('TikTok opened the TEXT/story composer instead of the post camera');
    }
    if (isLiveCamera(words) || lowestExactWord(words, 'post')) {
        await tapOcrMode(driver, remote, udid, 'post', postTab, 'POST camera tab');
        await driver.pause(600);
    }
}

async function ensurePhotoMode(
    driver: Browser,
    remote: WdaRemoteControl,
    udid: string,
    fallback: { x: number; y: number },
): Promise<void> {
    const before = await recognizeWords(await remote.getScreenshot(udid));
    if (isTextStoryComposer(before)) {
        throw new Error('TikTok opened the TEXT/story composer instead of PHOTO');
    }
    await tapOcrMode(driver, remote, udid, 'photo', fallback, 'PHOTO mode');
    await driver.pause(800);
    const after = await recognizeWords(await remote.getScreenshot(udid));
    if (isTextStoryComposer(after)) {
        throw new Error('PHOTO tap opened the TEXT/story composer');
    }
    await debugShot('photo-mode');
}

async function ensureVideoMode(
    driver: Browser,
    remote: WdaRemoteControl,
    udid: string,
): Promise<void> {
    const { scale } = await remote.getScreenInfo(udid);
    const words = await recognizeWords(await remote.getScreenshot(udid));
    if (isTextStoryComposer(words)) {
        throw new Error('TikTok opened the TEXT/story composer instead of the video camera');
    }
    const fifteen = words.find((word) => /15s/i.test(word.text.replace(/\s/g, '')) || word.text.replace(/\s/g, '') === '155');
    if (fifteen) {
        const point = pointFromWord(fifteen, scale);
        await tapCoordinate(driver, point.x, point.y, '15s video mode');
        await driver.pause(800);
    } else {
        const photo = lowestExactWord(words, 'photo');
        if (photo) {
            const point = pointFromWord(photo, scale);
            await tapCoordinate(driver, point.x - 67, point.y, '15s video mode (left of PHOTO)');
            await driver.pause(800);
        }
    }
    const after = await recognizeWords(await remote.getScreenshot(udid));
    if (isTextStoryComposer(after) || isVideoEditorStoryBar(after)) {
        throw new Error('Video mode tap left the TEXT/story composer');
    }
    await debugShot('video-mode');
}

async function openMusicIfRequested(driver: Browser, musicUrl: string | undefined): Promise<void> {
    if (!musicUrl) return;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        console.log(`Opening music URL: ${musicUrl}`);
        await driver.execute('mobile: deepLink', { url: musicUrl });
        await driver.pause(8000);
        await dismissComposerBlockers(driver);
        const sound = await firstDisplayed(driver, USE_SOUND_SELECTORS);
        if (sound) {
            await sound.click();
            console.log('Tapped Use this sound');
            await debugShot('use-this-sound');
            return;
        }
        await debugShot(`music-missing-${attempt}`);
        if (attempt === 3) throw new Error('TikTok control not found: Use this sound');
        console.log(`Use this sound not on screen (attempt ${attempt}/3); retrying deep link`);
    }
}

async function openComposer(
    driver: Browser,
    remote: WdaRemoteControl,
    udid: string,
    coordinates: TikTokCoordinates['tiktok'],
    musicUrl: string | undefined,
    slideshow: boolean,
): Promise<void> {
    if (musicUrl) {
        await openMusicIfRequested(driver, musicUrl);
    } else {
        await driver.activateApp(process.env.TIKTOK_BUNDLE_ID ?? 'com.zhiliaoapp.musically');
        await driver.pause(2500);
        await tapCoordinate(driver, coordinates.create.x, coordinates.create.y, 'Create');
    }
    await driver.pause(2500);
    await dismissComposerBlockers(driver);
    await debugShot('composer-open');
    // Camera remembers the last tab. LIVE/CREATE leftover, or a PHOTO tap that
    // actually hits TEXT (pill shifts left when PHOTO is already selected),
    // lands on the Your Story share sheet instead of Drafts.
    await ensurePostCamera(driver, remote, udid, coordinates.create);
    if (slideshow) {
        await ensurePhotoMode(driver, remote, udid, coordinates.photoMode);
    } else {
        await ensureVideoMode(driver, remote, udid);
    }
    await tapCoordinate(driver, coordinates.upload.x, coordinates.upload.y, 'Upload');
    await driver.pause(2500);
    await debugShot('upload-picker');
}

const CHECKBOX_RETRY_ATTEMPTS = 3;
const SELECT_MULTIPLE_RED_THRESHOLD = 15;
const CHECKBOX_TOGGLE_DELTA = 12;

async function checkboxSamplePoints(
    driver: Browser,
    fallback: { x: number; y: number },
    selectors?: string[],
): Promise<Array<{ x: number; y: number }>> {
    const points = [fallback];
    const element = selectors ? await firstDisplayed(driver, selectors) : undefined;
    if (!element) return points;
    const location = await element.getLocation();
    const size = await element.getSize();
    // The filled circle is on the leading edge; the control's center is the label.
    points.push({
        x: Math.round(location.x + Math.min(18, Math.max(8, size.width / 6))),
        y: Math.round(location.y + size.height / 2),
    });
    return points;
}

async function maxRedCount(
    screenshot: Buffer,
    points: Array<{ x: number; y: number }>,
    scale: number,
): Promise<{ count: number; at: { x: number; y: number } }> {
    let count = -1;
    let at = points[0]!;
    for (const point of points) {
        const next = await redCheckboxPixelCount(screenshot, point, scale);
        if (next > count) {
            count = next;
            at = point;
        }
    }
    return { count, at };
}

async function waitUntilDisplayed(driver: Browser, label: string, selectors: string[], timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const element = await firstDisplayed(driver, selectors);
        if (element) return element;
        await driver.pause(400);
    }
    throw new Error(`TikTok control not found: ${label}`);
}

async function toggleCheckbox(
    driver: Browser,
    point: { x: number; y: number },
    label: string,
    attempt: number,
    selectors?: string[],
): Promise<void> {
    const element = selectors ? await firstDisplayed(driver, selectors) : undefined;
    if (element) {
        await element.click();
        console.log(`Tapped ${label} (attempt ${attempt}, accessibility)`);
    } else {
        await tapCoordinate(driver, point.x, point.y, `${label} (attempt ${attempt})`);
    }
    await driver.pause(1000);
}

// Prefer color once the checkbox is on screen. Accessibility selected/value
// on TikTok's custom circles often stay "false" while the fill is red, which
// made the farm toggle Select multiple off again. Color without a visible
// control is the camera record button — that false "on" is what committed
// a one-image draft last time.
async function ensureCheckboxState(
    driver: Browser,
    remote: WdaRemoteControl,
    udid: string,
    point: { x: number; y: number },
    label: string,
    desired: boolean,
    selectors?: string[],
): Promise<void> {
    const { scale } = await remote.getScreenInfo(udid);
    const threshold = selectors ? SELECT_MULTIPLE_RED_THRESHOLD : 50;
    for (let attempt = 1; attempt <= CHECKBOX_RETRY_ATTEMPTS; attempt += 1) {
        const points = await checkboxSamplePoints(driver, point, selectors);
        const before = await maxRedCount(await remote.getScreenshot(udid), points, scale);
        const checked = before.count > threshold;
        console.log(`"${label}" red=${before.count} at (${before.at.x}, ${before.at.y})`);
        if (checked === desired) {
            console.log(`"${label}" confirmed ${desired ? 'on' : 'off'}`);
            return;
        }
        await toggleCheckbox(driver, point, label, attempt, selectors);
        const after = await maxRedCount(await remote.getScreenshot(udid), points, scale);
        console.log(`"${label}" red after tap=${after.count} at (${after.at.x}, ${after.at.y})`);
        if (desired && after.count >= before.count + CHECKBOX_TOGGLE_DELTA) {
            console.log(`"${label}" confirmed on (red increased)`);
            return;
        }
        if (desired && after.count <= before.count - CHECKBOX_TOGGLE_DELTA) {
            await toggleCheckbox(driver, point, label, attempt, selectors);
            console.log(`"${label}" was on; toggled back on`);
            return;
        }
        if (!desired && after.count <= before.count - CHECKBOX_TOGGLE_DELTA) {
            console.log(`"${label}" confirmed off (red decreased)`);
            return;
        }
        if (!desired && after.count >= before.count + CHECKBOX_TOGGLE_DELTA) {
            await toggleCheckbox(driver, point, label, attempt, selectors);
            console.log(`"${label}" was off; toggled back off`);
            return;
        }
        if (after.count > threshold === desired) {
            console.log(`"${label}" confirmed ${desired ? 'on' : 'off'} after tap`);
            return;
        }
    }
    throw new Error(`Could not get "${label}" into the ${desired ? 'on' : 'off'} state after ${CHECKBOX_RETRY_ATTEMPTS} attempts`);
}

async function ensureSelectMultipleOn(
    driver: Browser,
    remote: WdaRemoteControl,
    udid: string,
    point: { x: number; y: number },
): Promise<void> {
    try {
        await waitUntilDisplayed(driver, 'Select multiple', SELECT_MULTIPLE_SELECTORS);
    } catch (error) {
        console.log(`${error instanceof Error ? error.message : String(error)}; tapping the calibrated point`);
        await tapCoordinate(driver, point.x, point.y, 'Select multiple (reveal picker)');
        await driver.pause(1000);
        await waitUntilDisplayed(driver, 'Select multiple', SELECT_MULTIPLE_SELECTORS);
    }
    await ensureCheckboxState(driver, remote, udid, point, 'Select multiple', true, SELECT_MULTIPLE_SELECTORS);
    await debugShot('select-multiple-on');
}

async function showPhotosFilter(
    driver: Browser,
    remote: WdaRemoteControl,
    udid: string,
    fallback: { x: number; y: number },
): Promise<void> {
    const element = await firstDisplayed(driver, PHOTOS_FILTER_SELECTORS);
    if (element) {
        await element.click();
        console.log('Tapped Photos filter (accessibility)');
    } else {
        const { scale } = await remote.getScreenInfo(udid);
        const words = await recognizeWords(await remote.getScreenshot(udid));
        const photos = words
            .filter((word) => word.text.toLowerCase().replace(/[’]/g, "'") === 'photos')
            .sort((left, right) => left.x - right.x);
        if (photos[0]) {
            const point = pointFromWord(photos[0], scale);
            await tapCoordinate(driver, point.x, point.y, 'Photos filter');
        } else {
            await tapCoordinate(driver, fallback.x, fallback.y, 'Photos filter');
        }
    }
    await driver.pause(800);
    await debugShot('photos-filter');
}

async function assertPickerStillOpen(driver: Browser, selected: number, total: number): Promise<void> {
    const stillOpen = await firstDisplayed(driver, [
        ...SELECT_MULTIPLE_SELECTORS,
        '-ios predicate string:(label CONTAINS[c] "Recents") OR (name CONTAINS[c] "Recents")',
        '-ios predicate string:(label CONTAINS[c] "Use layout") OR (name CONTAINS[c] "Use layout")',
    ]);
    if (stillOpen) return;
    throw new Error(
        `Left the photo picker after image ${selected}/${total}. `
        + 'Slideshows need Select multiple on before the first thumbnail tap.',
    );
}

async function assertSelectedCount(
    driver: Browser,
    remote: WdaRemoteControl,
    udid: string,
    count: number,
): Promise<void> {
    const words = await recognizeWords(await remote.getScreenshot(udid));
    const text = words.map((word) => word.text.toLowerCase()).join(' ');
    const match = text.match(/next\s*\(?\s*(\d+)/) ?? text.match(/\((\d+)\)/);
    const selected = match ? Number.parseInt(match[1]!, 10) : undefined;
    console.log(`Picker selection OCR: ${selected ?? 'unknown'} (want ${count}); saw "${text.slice(0, 180)}"`);
    if (selected === count) return;
    if (count > 1 && new RegExp(`\\b${count}\\b`).test(text) && /autocut|use layout|next/.test(text)) {
        console.log('Picker selection OCR accepted via Next/AutoCut context');
        return;
    }
    const tray = await firstDisplayed(driver, [
        '-ios predicate string:(label CONTAINS[c] "Use layout") OR (name CONTAINS[c] "Use layout")',
        '-ios predicate string:(label CONTAINS[c] "AutoCut") OR (name CONTAINS[c] "AutoCut")',
    ]);
    if (tray) {
        console.log('Picker selection OCR missed the count; tray is visible, continuing to Next');
        return;
    }
    throw new Error(`Photo picker selected ${selected ?? 'an unknown number of'} items, expected ${count}`);
}

function pickerLayoutFrom(coordinates: TikTokCoordinates['tiktok']): PickerLayout {
    return {
        circleX: coordinates.picker.circleX,
        columnStep: coordinates.picker.columnStep,
        firstY: coordinates.picker.firstY,
        trayY: coordinates.picker.trayY,
        rowStep: coordinates.picker.rowStep,
    };
}

async function showVideosFilter(
    driver: Browser,
    remote: WdaRemoteControl,
    udid: string,
): Promise<void> {
    const element = await firstDisplayed(driver, VIDEOS_FILTER_SELECTORS);
    if (element) {
        await element.click();
        console.log('Tapped Videos filter (accessibility)');
    } else {
        const { scale } = await remote.getScreenInfo(udid);
        const match = lowestExactWord(await recognizeWords(await remote.getScreenshot(udid)), 'videos');
        if (match) {
            const point = pointFromWord(match, scale);
            await tapCoordinate(driver, point.x, point.y, 'Videos filter');
        }
    }
    await driver.pause(800);
    await debugShot('videos-filter');
}

async function ensureSelectMultipleOff(
    driver: Browser,
    remote: WdaRemoteControl,
    udid: string,
    point: { x: number; y: number },
): Promise<void> {
    const visible = await firstDisplayed(driver, SELECT_MULTIPLE_SELECTORS);
    if (!visible) return;
    await ensureCheckboxState(driver, remote, udid, point, 'Select multiple', false, SELECT_MULTIPLE_SELECTORS);
    await debugShot('select-multiple-off');
}

async function advanceVideoEditorToCaption(
    driver: Browser,
    remote: WdaRemoteControl,
    udid: string,
    coordinates: TikTokCoordinates['tiktok'],
): Promise<void> {
    // OCR on the dark Your Story | Next bar routinely misses those words
    // (and AutoCut). After the picker closes, tap the calibrated Next.
    for (let attempt = 1; attempt <= 8; attempt += 1) {
        const { scale } = await remote.getScreenInfo(udid);
        const words = await recognizeWords(await remote.getScreenshot(udid));
        if (isCaptionComposer(words)) {
            console.log('Reached the video caption screen');
            await debugShot('caption-screen');
            return;
        }
        if (isMediaPicker(words)) {
            console.log(`Still on the media picker after the video tap (${attempt}/8)`);
            await debugShot(`video-picker-wait-${attempt}`);
            await driver.pause(1500);
            continue;
        }
        const next = lowestExactWord(words, 'next')
            ?? words.find((word) => /^next/i.test(word.text.replace(/[^A-Za-z]/g, '')));
        if (next) {
            const point = pointFromWord(next, scale);
            await tapCoordinate(driver, point.x, point.y, 'editor Next');
        } else {
            await tapCoordinate(driver, coordinates.editorNext.x, coordinates.editorNext.y, 'editor Next (OCR-blind)');
        }
        await driver.pause(3000);
        await debugShot(`video-editor-next-${attempt}`);
    }
    throw new Error('Could not reach the TikTok caption screen from the video editor');
}

async function dismissComposerKeyboard(
    driver: Browser,
    remote: WdaRemoteControl,
    udid: string,
): Promise<void> {
    const words = await recognizeWords(await remote.getScreenshot(udid));
    const text = words.map((word) => word.text.toLowerCase()).join(' ');
    if (!text.includes('space') && !/[qwerty].*[asdf]/.test(text.replace(/\s/g, ''))) return;
    // (24, 56) is the caption-screen back chevron. Tapping it while the
    // keyboard is closed returns to the video editor, where Drafts coords
    // hit Your Story.
    await tapCoordinate(driver, 207, 510, 'dismiss keyboard');
    await driver.pause(800);
}

async function saveDraft(
    driver: Browser,
    remote: WdaRemoteControl,
    udid: string,
    coordinates: TikTokCoordinates['tiktok'],
): Promise<void> {
    const words = await recognizeWords(await remote.getScreenshot(udid));
    if (isVideoEditorStoryBar(words) || isTextStoryComposer(words)) {
        throw new Error('Refusing to save a draft on the Your Story bar');
    }
    if (!isCaptionComposer(words)) {
        throw new Error('Not on the caption screen; Drafts would miss');
    }
    await tapCoordinate(driver, coordinates.draft.x, coordinates.draft.y, 'Drafts');
    console.log('TikTok draft saved');
    await debugShot('draft-saved');
    await driver.pause(2500);
}

async function chooseRecentMedia(
    driver: Browser, remote: WdaRemoteControl, udid: string, count: number, assetCount: number,
    coordinates: TikTokCoordinates['tiktok'],
    slideshow: boolean,
): Promise<void> {
    if (slideshow) {
        if (count > 1) {
            await ensureSelectMultipleOn(driver, remote, udid, {
                x: coordinates.selectMultiple.x,
                y: coordinates.selectMultiple.y,
            });
        }
        // Gallery Upload opens Recents / All. Photos excludes videos. The
        // circled grid under that tab is still newest-first; Cover is the
        // top-left circled cell after reverse import. Do not tap the Recents
        // header (album list) or the uncircled strip above firstY.
        await showPhotosFilter(driver, remote, udid, coordinates.photosAlbum);
        const layout = pickerLayoutFrom(coordinates);
        const targets = count === 1
            ? [pickerCircle(0, 0, layout)]
            : recentPickerTargets(assetCount, count, layout);
        console.log(`Picker taps (newest first): ${targets.map((point, index) => `${index + 1}=(${point.x},${point.y})`).join(' ')}`);
        for (const [selection, { x, y }] of targets.entries()) {
            await tapCoordinate(driver, x, y, `media ${selection + 1}/${count}`);
            await driver.pause(selection === 0 ? 1400 : 800);
            await debugShot(`media-${selection + 1}-of-${count}`);
            if (selection < count - 1) await assertPickerStillOpen(driver, selection + 1, count);
        }
        if (count > 1) {
            await assertSelectedCount(driver, remote, udid, count);
            await ensureCheckboxState(driver, remote, udid, {
                x: coordinates.useLayout.x,
                y: coordinates.useLayout.y,
            }, 'Use layout', false);
        }
        await tapCoordinate(driver, coordinates.pickerNext.x, coordinates.pickerNext.y, 'picker Next');
        await driver.pause(3000);
        await debugShot('picker-next');
        await tapCoordinate(driver, coordinates.editorNext.x, coordinates.editorNext.y, 'editor Next');
        await driver.pause(3000);
        await debugShot('caption-screen');
        return;
    }

    await showVideosFilter(driver, remote, udid);
    await ensureSelectMultipleOff(driver, remote, udid, {
        x: coordinates.selectMultiple.x,
        y: coordinates.selectMultiple.y,
    });
    const cell = newestPickerCell(pickerLayoutFrom(coordinates));
    await tapCoordinate(driver, cell.x, cell.y, 'media 1/1');
    await driver.pause(2500);
    await debugShot('video-picked');
    await advanceVideoEditorToCaption(driver, remote, udid, coordinates);
}

async function typeKeys(driver: Browser, text: string): Promise<void> {
    const appiumHost = process.env.APPIUM_HOST ?? '127.0.0.1';
    const appiumPort = positiveInteger('APPIUM_PORT', 4725);
    const response = await fetch(`http://${appiumHost}:${appiumPort}/session/${driver.sessionId}/keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: [text] }),
    });
    if (!response.ok) throw new Error(`Appium could not type into the composer: ${await response.text()}`);
}

async function addCaption(
    driver: Browser,
    remote: WdaRemoteControl,
    udid: string,
    coordinates: TikTokCoordinates['tiktok'],
    raw?: string,
): Promise<void> {
    const { title, caption } = splitComposerCopy(raw);
    if (!title && !caption) return;
    const { scale } = await remote.getScreenInfo(udid);
    if (title) {
        const words = await recognizeWords(await remote.getScreenshot(udid));
        if (!await tapOcrWord(driver, words, scale, ['catchy'], 'title field')) {
            await tapCoordinate(driver, coordinates.title.x, coordinates.title.y, 'title field (fallback)');
        }
        await typeKeys(driver, title);
        await driver.pause(400);
        await debugShot('title-entered');
    }
    if (caption) {
        const words = await recognizeWords(await remote.getScreenshot(udid));
        const text = words.map((word) => word.text.toLowerCase()).join(' ');
        if (!await tapOcrWord(driver, words, scale, ['writing', 'description'], 'caption field')) {
            const videoLayout = text.includes('add description') || !text.includes('catchy');
            await tapCoordinate(
                driver,
                videoLayout ? 90 : coordinates.caption.x,
                videoLayout ? 125 : coordinates.caption.y,
                'caption field',
            );
        }
        await typeKeys(driver, caption);
        await driver.pause(400);
    }
    await dismissComposerKeyboard(driver, remote, udid);
    await debugShot('caption-filled');
    console.log(title && caption ? 'Title and caption added' : caption ? 'Caption added' : 'Title added');
}

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error('A post manifest path is required');
const manifest = JSON.parse(await readFile(path.resolve(manifestPath), 'utf8')) as PostManifest;

const switchAccountName = manifest.account?.trim() || undefined;
const registeredDevice = (await loadRegisteredDevices()).find((device) => device.udid === manifest.device.udid);
const coordinates = resolveDeviceCoordinates(coordinateProfile(registeredDevice), registeredDevice?.coordinates);
const tiktokCoordinates = coordinates.tiktok;
const accountSwitchCoords = {
    profileTabX: tiktokCoordinates.profileTab.x,
    profileTabY: tiktokCoordinates.profileTab.y,
    switcherTriggerX: tiktokCoordinates.accountSwitcher.x,
    switcherTriggerY: tiktokCoordinates.accountSwitcher.y,
};
// Fail fast, before unlocking or launching TikTok, if the requested account
// isn't one this device is registered for.
const allowedAccounts = switchAccountName
    ? registeredAccounts(registeredDevice)
    : [];
if (switchAccountName && !allowedAccounts.includes(switchAccountName)) {
    throw new Error(`TikTok account "${switchAccountName}" is not listed in devices.json for device ${manifest.device.udid}`);
}

const slideshow = manifest.files.every((file) => file.mimeType.startsWith('image/'));
if (!slideshow) deepSeekConfig();

const deviceRemote = new WdaRemoteControl({
    deviceUdid: manifest.device.udid,
    passcode: await passcodeForDevice(manifest.device.udid),
    passcodeKeypadLayout: coordinates.passcodeKeypad,
    // activateApp + first screenshot after unlock often exceeds the 10s WDA default.
    timeoutMs: 30_000,
});
debugRemote = deviceRemote;
debugUdid = manifest.device.udid;
console.log(`Debug screenshots: ${DEBUG_SHOT_DIR}`);
console.log('Checking device lock state');
await deviceRemote.unlock(manifest.device.udid);

let assetCount = manifest.files.length;
if (process.env.SKIP_MEDIA_IMPORT === '1') {
    console.log('Skipping Camera Roll import (images already uploaded)');
} else {
    assetCount = await importMedia(manifest);
}
await debugShot('after-import');

const bundleId = process.env.TIKTOK_BUNDLE_ID ?? 'com.zhiliaoapp.musically';
const capabilities: WebdriverIO.Capabilities & Record<string, unknown> = {
    ...tiktokAppiumCapabilities(manifest.device.udid, bundleId, { 'appium:newCommandTimeout': 180 }),
};
if (process.env.WDA_URL) {
    capabilities['appium:webDriverAgentUrl'] = process.env.WDA_URL;
    capabilities['appium:wdaRemotePort'] = positiveInteger('WDA_REMOTE_PORT', 8100);
}

// The composer/picker flow (up to the caption screen) is the fragile part —
// flaky picker checkboxes, transient tooltips, TikTok UI timing — so it gets
// retried. Retries Home + re-attach; they must not SIGKILL TikTok or the next
// launch is welcome / choose-your-interests. Caption entry and the final
// Post/Drafts tap are NOT retried: retrying after that risks a duplicate
// post or draft, which is worse than a single clean failure.
const REACH_CAPTION_SCREEN_ATTEMPTS = 3;
let driver: Browser | undefined;
let reachedCaptionScreen = false;
let lastAttemptError: unknown;

for (let attempt = 1; attempt <= REACH_CAPTION_SCREEN_ATTEMPTS && !reachedCaptionScreen; attempt += 1) {
    if (attempt > 1) {
        console.log(`Retrying up to the caption screen (attempt ${attempt}/${REACH_CAPTION_SCREEN_ATTEMPTS})`);
    }
    try {
        // Unlock is its own 3-try loop. Re-run it before every Appium session:
        // a lit lock screen looks "awake" so the first pass can return while
        // SpringBoard still refuses to launch TikTok.
        await deviceRemote.unlock(manifest.device.udid, {
            force: attempt > 1 && appiumFailedBecauseLocked(lastAttemptError),
        });
        driver = await remote({ hostname: process.env.APPIUM_HOST ?? '127.0.0.1', port: positiveInteger('APPIUM_PORT', 4725), path: '/', logLevel: 'info', connectionRetryCount: 0, connectionRetryTimeout: 180000, capabilities });
        await driver.updateSettings({ defaultActiveApplication: bundleId });
        await driver.setTimeout({ implicit: 0 });
        await foregroundTikTok(driver, bundleId);
        await driver.pause(2000);
        try {
            await waitUntilFeedReady(driver, deviceRemote, manifest.device.udid);
        } catch (error) {
            console.log(`Feed ready check failed, continuing: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (switchAccountName) {
            console.log(`Switching to TikTok account "${switchAccountName}"`);
            await driver.pause(1000);
            await switchTikTokAccount(driver, deviceRemote, manifest.device.udid, switchAccountName, accountSwitchCoords);
            await debugShot('account-switched');
        }
        if (slideshow) {
            await openComposer(driver, deviceRemote, manifest.device.udid, tiktokCoordinates, manifest.musicUrl, slideshow);
            await chooseRecentMedia(driver, deviceRemote, manifest.device.udid, manifest.files.length, assetCount, tiktokCoordinates, slideshow);
        } else {
            await openMusicIfRequested(driver, manifest.musicUrl);
            await runVideoVisionToCaption({
                driver,
                remote: deviceRemote,
                udid: manifest.device.udid,
                manifest,
                typeKeys,
                debugShot,
                finishPoint: manifest.destination === 'publish' ? tiktokCoordinates.finish : tiktokCoordinates.draft,
                videoPicker: {
                    cellX: tiktokCoordinates.picker.cellX,
                    cellStep: tiktokCoordinates.picker.cellStep,
                    firstY: tiktokCoordinates.picker.firstY,
                    rowStep: tiktokCoordinates.picker.rowStep,
                },
                scrollToNewestVideo: true,
            });
            // #endregion
        }
        reachedCaptionScreen = true;
    } catch (error) {
        lastAttemptError = error;
        console.error(`Attempt ${attempt}/${REACH_CAPTION_SCREEN_ATTEMPTS} failed before reaching the caption screen: ${error instanceof Error ? error.message : String(error)}`);
        await debugShot(`attempt-${attempt}-failed`);
        if (driver) {
            await backgroundTikTok(driver).catch(() => {});
            await driver.deleteSession().catch(() => {});
            driver = undefined;
        }
    }
}

if (!reachedCaptionScreen || !driver) {
    throw lastAttemptError instanceof Error
        ? lastAttemptError
        : new Error(`Could not reach the TikTok caption screen after ${REACH_CAPTION_SCREEN_ATTEMPTS} attempts`);
}

try {
    if (slideshow) {
        await addCaption(driver, deviceRemote, manifest.device.udid, tiktokCoordinates, manifest.caption);
        if (manifest.destination === 'publish') {
            await tapCoordinate(driver, tiktokCoordinates.finish.x, tiktokCoordinates.finish.y, 'Post');
            console.log('TikTok post submitted');
            // The upload to TikTok continues in the background after this tap —
            // tearing down the session too soon can interrupt it.
            await driver.pause(60_000);
        } else {
            await saveDraft(driver, deviceRemote, manifest.device.udid, tiktokCoordinates);
        }
    } else {
        await finishVideoVisionPost({
            driver,
            remote: deviceRemote,
            udid: manifest.device.udid,
            manifest,
            typeKeys,
            debugShot,
            finishPoint: manifest.destination === 'publish' ? tiktokCoordinates.finish : tiktokCoordinates.draft,
        });
    }
    await backgroundTikTok(driver).catch(() => {});
} finally {
    await driver.deleteSession();
}
