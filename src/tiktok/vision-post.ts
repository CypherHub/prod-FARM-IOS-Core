import type { Browser } from 'webdriverio';

import type { WdaRemoteControl } from '@git-agni/phone-farm-core';
import { swipeCoordinate, tapCoordinate } from './actions.js';
import { snapToVideoPickerCell, type VideoPickerLayout } from './post-layout.js';
import { splitComposerCopy } from './post-compose.js';
import type { PostManifest } from './post-manifest.js';
import {
    acceptGoalMet,
    askVisionGuide,
    forbiddenTapReason,
    pointFromNormalized,
    type VideoVisionGoal,
    type VisionDecision,
} from './vision-guide.js';

const ATTEMPTS_PER_GOAL = 6;
const AFTER_TAP_MS = 1_800;

export type VisionDebugShot = (
    label: string,
    options?: { image?: Buffer; tap?: { x: number; y: number }; scale?: number; label?: string },
) => Promise<void>;

export interface VideoVisionContext {
    driver: Browser;
    remote: WdaRemoteControl;
    udid: string;
    manifest: PostManifest;
    typeKeys: (driver: Browser, text: string) => Promise<void>;
    debugShot?: VisionDebugShot;
    ask?: typeof askVisionGuide;
    pause?: (ms: number) => Promise<void>;
    finishPoint?: { x: number; y: number };
    videoPicker?: VideoPickerLayout;
    scrollToNewestVideo?: boolean;
    /** @internal set by runGoal after scrolling to the bottom of the picker */
    _scrolledToNewest?: boolean;
}

export async function runVideoVisionToCaption(context: VideoVisionContext): Promise<void> {
    await runGoal(context, 'reach_post_camera');
    await runGoal(context, 'open_gallery');
    await runGoal(context, 'pick_newest_video');
    await runGoal(context, 'leave_editor');
}

export async function finishVideoVisionPost(context: VideoVisionContext): Promise<void> {
    await fillCaption(context);
    await runGoal(context, 'finish');
    if (context.manifest.destination === 'publish') {
        console.log('TikTok post submitted');
        await wait(context, 60_000);
    } else {
        console.log('TikTok draft saved');
        await wait(context, 2_500);
    }
}

export async function runVideoVisionPost(context: VideoVisionContext): Promise<void> {
    await runVideoVisionToCaption(context);
    await finishVideoVisionPost(context);
}

async function fillCaption(context: VideoVisionContext): Promise<void> {
    const { title, caption } = splitComposerCopy(context.manifest.caption);
    const copy = [title, caption].filter(Boolean).join('\n\n');
    const typedCopy = copy ? copy + ' ' : '';
    let typed = !copy;
    let dismissed = !copy;
    for (let attempt = 1; attempt <= ATTEMPTS_PER_GOAL + 2; attempt += 1) {
        const extra = typed
            ? 'Dismiss the keyboard by tapping empty body, not the back chevron. goalMet when Drafts and Post are visible and the keyboard is gone.'
            : 'Tap Add description so the field is focused. Do not tap Drafts or Post.';
        const { decision, point } = await decide(context, 'fill_caption', extra);
        if (!typed) {
            if (decision.action === 'tap' && point) {
                await tapCoordinate(context.driver, point.x, point.y, `vision fill_caption: ${decision.reason}`);
                await wait(context, 400);
            } else if (!decision.goalMet) {
                await applyDecision(context, 'fill_caption', decision, point, attempt);
                continue;
            }
            await context.typeKeys(context.driver, typedCopy);
            typed = true;
            console.log(`Caption added: ${typedCopy}`);
            await context.debugShot?.('caption-filled');
            await wait(context, 800);
            continue;
        }
        if (decision.action === 'tap' && decision.ny !== undefined && decision.ny > 0.3 && decision.ny < 0.75) {
            dismissed = true;
        }
        if (decision.goalMet && dismissed) {
            await context.debugShot?.('caption-ready');
            return;
        }
        if (decision.goalMet && !dismissed) {
            console.log('Vision fill_caption ignored goalMet until the keyboard is dismissed');
        }
        await applyDecision(context, 'fill_caption', decision, point, attempt);
    }
    throw new Error('Could not dismiss the caption keyboard');
}

async function runGoal(context: VideoVisionContext, goal: VideoVisionGoal): Promise<void> {
    // #region agent log
    const logEndpoint = 'http://127.0.0.1:7276/ingest/c84fa4ce-b9c8-4c6e-bbdf-21e53389e3ff';
    const logLine = (location: string, msg: string, data: Record<string, unknown>) => {
        fetch(logEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '00d9c7' }, body: JSON.stringify({ sessionId: '00d9c7', runId: '1', timestamp: Date.now(), location, message: msg, data }), }).catch(() => {});
    };
    // #endregion agent log
    let committed = false;
    let pickedNewest = false;
    let scrolledToNewest = false;
    for (let attempt = 1; attempt <= ATTEMPTS_PER_GOAL; attempt += 1) {
        const { decision, point } = await decide(context, goal);
        logLine('runGoal:ATTEMPT', `Attempt ${attempt} for ${goal}`, {
            goal, attempt,
            screen: decision.screen,
            action: decision.action,
            goalMet: decision.goalMet,
            nx: decision.nx, ny: decision.ny,
            reason: decision.reason,
            pickedNewest, scrolledToNewest, committed,
            hasPoint: !!point,
            pointX: point?.x, pointY: point?.y,
        });
        if (goal === 'finish' && committed && (decision.screen === 'feed' || decision.action === 'fail' || decision.goalMet)) {
            console.log(`Vision finish committed (${decision.screen}): ${decision.reason}`);
            await context.debugShot?.(`${goal}-met`);
            return;
        }
        if (goal === 'pick_newest_video' && (decision.screen === 'editor' || decision.screen === 'caption') && (pickedNewest || decision.goalMet || decision.action === 'fail')) {
            if (pickedNewest || decision.goalMet) {
                logLine('runGoal:PICK_MET', 'pick_newest_video met', { screen: decision.screen, pickedNewest, goalMet: decision.goalMet, action: decision.action, reason: decision.reason });
                console.log(`Vision pick_newest_video met (${decision.screen}): ${decision.reason}`);
   120|                await context.debugShot?.(`${goal}-met`);
                return;
            }
        }
        if (decision.goalMet && goal === 'pick_newest_video' && !pickedNewest) {
            logLine('runGoal:IGNORE_MET', 'Ignored goalMet until cell tapped', { screen: decision.screen });
            console.log('Vision pick_newest_video ignored goalMet until the last filled cell is tapped');
        } else if (decision.goalMet && !(goal === 'finish' && !committed && decision.screen === 'caption')) {
            console.log(`Vision ${goal} met (${decision.screen}): ${decision.reason}`);
            await context.debugShot?.(`${goal}-met`);
            return;
        }
        if (goal === 'finish' && decision.goalMet && !committed) {
            console.log('Vision finish ignored goalMet until Drafts/Post is tapped');
        }
        if (goal === 'pick_newest_video' && context.scrollToNewestVideo && !scrolledToNewest && isGridTap(decision.ny)) {
            logLine('runGoal:TRIGGER_SCROLL', 'Triggering scroll to newest', { attempt, ny: decision.ny });
            await scrollPickerToNewest(context);
            scrolledToNewest = true;
            context._scrolledToNewest = true;
            logLine('runGoal:AFTER_SCROLL', 'Scroll done', {});
            attempt -= 1;
            continue;
        }
        await applyDecision(context, goal, decision, point, attempt);
        if (goal === 'finish' && decision.action === 'tap' && point) committed = true;
        if (goal === 'pick_newest_video' && decision.action === 'tap' && point && isGridTap(decision.ny)) {
            logLine('runGoal:PICKED_TAP', 'Picked newest tap applied', { x: point.x, y: point.y, decisionNx: decision.nx, decisionNy: decision.ny });
            pickedNewest = true;
        }
    }
    if (goal === 'finish' && committed) {
        logLine('runGoal:FINISH_COMMITTED', 'Finish committed', {});
        console.log('Vision finish tapped Drafts/Post; treating the post as committed');
        return;
    }
    throw new Error(`Vision could not complete ${goal} after ${ATTEMPTS_PER_GOAL} attempts`);
}

async function decide(
    context: VideoVisionContext,
    goal: VideoVisionGoal,
    extra?: string,
): Promise<{ decision: VisionDecision; point?: { x: number; y: number } }> {
    // #region agent log
    const logEndpoint = 'http://127.0.0.1:7276/ingest/c84fa4ce-b9c8-4c6e-bbdf-21e53389e3ff';
    const logLine = (location: string, msg: string, data: Record<string, unknown>) => {
        fetch(logEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '00d9c7' }, body: JSON.stringify({ sessionId: '00d9c7', runId: '1', timestamp: Date.now(), location, message: msg, data }), }).catch(() => {});
    };
    // #endregion agent log
    const { image, screen } = await screenshotForVision(context);
    const ask = context.ask ?? askVisionGuide;
    let decision = await ask({
        image,
        goal,
        destination: context.manifest.destination,
        extra,
    });
    logLine('decide:AFTER_ASK', `Vision decision for ${goal}`, {
        goal,
        screen: decision.screen,
        action: decision.action,
        goalMet: decision.goalMet,
        nx: decision.nx,
        ny: decision.ny,
        reason: decision.reason,
        scrolledToNewest: context._scrolledToNewest,
        screenW: screen.screenSize.width,
        screenH: screen.screenSize.height,
    });
    if (acceptGoalMet(goal, decision.screen) && goal !== 'fill_caption' && goal !== 'finish' && goal !== 'pick_newest_video') {
        decision = { ...decision, goalMet: true };
    } else if (decision.goalMet && !acceptGoalMet(goal, decision.screen)) {
        decision = { ...decision, goalMet: false, reason: `ignored goalMet on ${decision.screen}` };
    }
    let point: { x: number; y: number } | undefined;
    if (decision.action === 'tap' && decision.nx !== undefined && decision.ny !== undefined) {
        const forbidden = forbiddenTapReason(goal, decision.nx, decision.ny, context.manifest.destination);
        if (forbidden) {
            logLine('decide:FORBIDDEN', `Vision ${goal} refused ${forbidden}`, { nx: decision.nx, ny: decision.ny, forbidden });
            console.log(`Vision ${goal} refused ${forbidden} at (${decision.nx.toFixed(2)}, ${decision.ny.toFixed(2)})`);
            return { decision: { ...decision, action: 'wait', reason: `refused ${forbidden}` } };
        }
        const raw = pointFromNormalized(decision.nx, decision.ny, screen.screenSize);
        const gridTap = isGridTap(decision.ny);
        logLine('decide:RAW_POINT', `Raw point for ${goal}`, { rawX: raw.x, rawY: raw.y, gridTap, decisionNx: decision.nx, decisionNy: decision.ny });
        if (goal === 'finish' && context.finishPoint) {
            point = context.finishPoint;
            logLine('decide:FINISH_POINT', 'Using finishPoint', { x: point.x, y: point.y });
        } else if (goal === 'pick_newest_video' && context.videoPicker && gridTap) {
            const snapped = snapToVideoPickerCell(raw, context.videoPicker);
            logLine('decide:SNAP_BEFORE_FORCE', 'Snapped cell', { snappedX: snapped.x, snappedY: snapped.y, videoPickerFirstY: context.videoPicker.firstY, videoPickerRowStep: context.videoPicker.rowStep, videoPickerCellX: context.videoPicker.cellX, videoPickerCellStep: context.videoPicker.cellStep });
            point = snapped;
            // After scroll, the model sees the last visible row but the
            // coordinate often lands between row centers. Force to the
            // last row that fits above the toolbar (~0.91 ny).
            if (context._scrolledToNewest) {
                const top = context.videoPicker.firstY - 40;
                const step = context.videoPicker.rowStep;
                const maxRow = Math.floor((screen.screenSize.height * 0.91 - top) / step);
                const snappedRow = Math.round((raw.y - top) / step);
                logLine('decide:FORCE_LAST_ROW', 'Force last row check', { top, step, maxRow, snappedRow, rawY: raw.y, screenH: screen.screenSize.height, forcedY: top + maxRow * step });
                if (snappedRow < maxRow) {
                    point = {
                        ...point,
                        y: top + maxRow * step,
                    };
                    logLine('decide:FORCE_LAST_ROW_APPLIED', 'Forced to last row', { maxRow, snappedRow, newY: point.y });
                    console.log(`Vision pick_newest_video forced to last row ${maxRow} (snapped ${snappedRow})`);
                } else {
                    logLine('decide:FORCE_LAST_ROW_SKIPPED', 'Snapped row already at max', { maxRow, snappedRow });
                }
            }
            logLine('decide:FINAL_TAP', 'Final tap point', { x: point.x, y: point.y, scrolledToNewest: context._scrolledToNewest });
            console.log(`Vision pick_newest_video snapped (${decision.nx.toFixed(2)}, ${decision.ny.toFixed(2)}) to cell (${point.x}, ${point.y})`);
        } else {
            point = raw;
            logLine('decide:NO_SNAP', 'Used raw point (no snap)', { x: point.x, y: point.y, goal, hasVideoPicker: !!context.videoPicker, gridTap });
        }
    }
    await context.debugShot?.(point ? `${goal}-tap` : goal, {
        image,
        tap: point,
        scale: screen.scale,
        label: point ? `${goal} ${point.x},${point.y}` : goal,
    });
    return { decision, point };
}

async function applyDecision(
    context: VideoVisionContext,
    goal: VideoVisionGoal,
    decision: VisionDecision,
    point: { x: number; y: number } | undefined,
    attempt: number,
): Promise<void> {
    if (decision.action === 'fail') {
        if (goal === 'pick_newest_video') {
            console.log(`Vision pick_newest_video wait (${attempt}/${ATTEMPTS_PER_GOAL}) ${decision.reason}`);
            await wait(context, 1_200);
            return;
        }
        throw new Error(`Vision ${goal} failed: ${decision.reason}`);
    }
    if (decision.action === 'tap' && point) {
        console.log(`Vision ${goal} ${decision.screen} tap (${point.x}, ${point.y}) ${decision.reason}`);
        await tapCoordinate(context.driver, point.x, point.y, `vision ${goal}: ${decision.reason}`);
        await wait(context, AFTER_TAP_MS);
        return;
    }
    console.log(`Vision ${goal} wait (${attempt}/${ATTEMPTS_PER_GOAL}) ${decision.reason}`);
    await wait(context, 1_200);
}

function isGridTap(ny?: number): boolean {
    // Last filled cell sits on the bottom row (~0.85–0.90). Keep the toolbar
    // (upload / Select multiple, ~0.93) out of the grid.
    return ny !== undefined && ny > 0.18 && ny < 0.91;
}

async function scrollPickerToNewest(context: VideoVisionContext): Promise<void> {
    const screen = await context.remote.getScreenInfo(context.udid);
    const x = Math.round(screen.screenSize.width * 0.5);
    const startY = Math.round(screen.screenSize.height * 0.72);
    const endY = Math.round(screen.screenSize.height * 0.28);
    // #region agent log
    const logEndpoint = 'http://127.0.0.1:7276/ingest/c84fa4ce-b9c8-4c6e-bbdf-21e53389e3ff';
    const logLine = (location: string, msg: string, data: Record<string, unknown>) => {
        fetch(logEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '00d9c7' }, body: JSON.stringify({ sessionId: '00d9c7', runId: '1', timestamp: Date.now(), location, message: msg, data }), }).catch(() => {});
    };
    logLine('scrollPickerToNewest:ENTRY', 'Scroll picker to newest called', { screenWidth: screen.screenSize.width, screenHeight: screen.screenSize.height, startY, endY, x });
    // #endregion agent log
    for (let index = 1; index <= 3; index += 1) {
        await swipeCoordinate(context.driver, x, startY, x, endY, 400, `picker toward newest (${index}/3)`);
        await wait(context, 500);
    }
}

function wait(context: VideoVisionContext, ms: number): Promise<void> {
    return context.pause ? context.pause(ms) : context.driver.pause(ms);
}

function isTransientWdaError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /aborted|timeout|ETIMEDOUT|ECONNRESET/i.test(message);
}

async function screenshotForVision(
    context: VideoVisionContext,
): Promise<{ image: Buffer; screen: Awaited<ReturnType<WdaRemoteControl['getScreenInfo']>> }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            const image = await context.remote.getScreenshot(context.udid);
            const screen = await context.remote.getScreenInfo(context.udid);
            return { image, screen };
        } catch (error) {
            lastError = error;
            if (!isTransientWdaError(error) || attempt === 3) throw error;
            console.log(`Vision screenshot timed out (${attempt}/3): ${error instanceof Error ? error.message : String(error)}`);
            await wait(context, 1_000);
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
