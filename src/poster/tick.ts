import { accountWindows, type PosterConfig, type PosterRunNowRequest, type PosterSlotState, type PosterState } from './config.js';
import {
    POSTER_HANDLES, nextRetryAt, openWindows, planTime, slotKey, zonedClock,
    type OpenWindow, type PosterHandle, type PosterWindowId,
} from './windows.js';

export type PosterAction =
    | { type: 'idle'; reason: string }
    | { type: 'discard'; handle: PosterHandle; reason: string }
    | { type: 'plan'; key: string; plannedAt: string; handle: PosterHandle; windowId: PosterWindowId }
    | { type: 'run'; key: string; handle: PosterHandle; windowId: PosterWindowId | 'now' };

export function slotSucceeded(slot: PosterSlotState | undefined): boolean {
    return slot?.status === 'succeeded';
}

export function slotWaiting(slot: PosterSlotState | undefined, now: Date): boolean {
    if (!slot?.retryAfter) return false;
    return now.getTime() < Date.parse(slot.retryAfter);
}

export function openWindowsFor(
    config: PosterConfig, handle: PosterHandle, now: Date,
): OpenWindow[] {
    return openWindows(now, config.timezone, accountWindows(config, handle));
}

export function nextPosterAction(
    config: PosterConfig,
    state: PosterState,
    now: Date,
    runNow: readonly PosterRunNowRequest[] = [],
    random: () => number = Math.random,
): PosterAction {
    if (state.currentAction) return { type: 'idle', reason: 'a post is already in flight' };

    if (runNow.length > 0) {
        const request = runNow[0]!;
        if (!config.accounts[request.handle]?.enabled) {
            return { type: 'discard', handle: request.handle, reason: `${request.handle} is disabled` };
        }
        const open = config.enabled
            ? openWindowsFor(config, request.handle, now).find((window) => {
                const key = slotKey(window.date, window.id, request.handle);
                return !slotSucceeded(state.slots[key]);
            })
            : undefined;
        if (open) {
            return { type: 'run', key: slotKey(open.date, open.id, request.handle), handle: request.handle, windowId: open.id };
        }
        const date = zonedClock(now, config.timezone).date;
        return { type: 'run', key: slotKey(date, 'now', request.handle), handle: request.handle, windowId: 'now' };
    }

    if (!config.enabled) return { type: 'idle', reason: 'poster is paused' };

    const due = findDueRun(config, state, now);
    if (due) return due;

    const plan = findNeededPlan(config, state, now, random);
    if (plan) return plan;

    if (hasFuturePlan(config, state, now)) return { type: 'idle', reason: 'waiting for planned post time' };
    if (!enabledHandles(config).some((handle) => openWindowsFor(config, handle, now).length > 0)) {
        return { type: 'idle', reason: 'outside selected time windows' };
    }
    return { type: 'idle', reason: 'nothing due in the current window' };
}

function enabledHandles(config: PosterConfig): PosterHandle[] {
    return POSTER_HANDLES.filter((handle) => config.accounts[handle]?.enabled);
}

function findDueRun(
    config: PosterConfig, state: PosterState, now: Date,
): Extract<PosterAction, { type: 'run' }> | null {
    for (const handle of enabledHandles(config)) {
        for (const window of openWindowsFor(config, handle, now)) {
            const key = slotKey(window.date, window.id, handle);
            const slot = state.slots[key];
            if (slotSucceeded(slot) || slotWaiting(slot, now) || !slot?.plannedAt) continue;
            if (now.getTime() < Date.parse(slot.plannedAt)) continue;
            return { type: 'run', key, handle, windowId: window.id };
        }
    }
    return null;
}

function findNeededPlan(
    config: PosterConfig, state: PosterState, now: Date, random: () => number,
): Extract<PosterAction, { type: 'plan' }> | null {
    for (const handle of enabledHandles(config)) {
        for (const window of openWindowsFor(config, handle, now)) {
            const key = slotKey(window.date, window.id, handle);
            const slot = state.slots[key];
            if (slotSucceeded(slot) || slotWaiting(slot, now) || slot?.plannedAt) continue;
            const planned = planTime(now, window.end, random);
            if (!planned) continue;
            return { type: 'plan', key, plannedAt: planned.toISOString(), handle, windowId: window.id };
        }
    }
    return null;
}

function hasFuturePlan(config: PosterConfig, state: PosterState, now: Date): boolean {
    for (const handle of enabledHandles(config)) {
        for (const window of openWindowsFor(config, handle, now)) {
            const slot = state.slots[slotKey(window.date, window.id, handle)];
            if (slot?.plannedAt && now.getTime() < Date.parse(slot.plannedAt) && !slotSucceeded(slot)) return true;
        }
    }
    return false;
}

export function applyPlan(state: PosterState, key: string, plannedAt: string): PosterState {
    const current = state.slots[key] ?? { status: 'pending' as const, attempts: 0 };
    return {
        ...state,
        slots: {
            ...state.slots,
            [key]: { ...current, plannedAt, status: current.status === 'succeeded' ? current.status : 'pending' },
        },
    };
}

export function applyRunStart(
    state: PosterState, action: Extract<PosterAction, { type: 'run' }>, now = new Date(),
): PosterState {
    return {
        ...state,
        currentAction: {
            handle: action.handle,
            windowId: action.windowId,
            key: action.key,
            step: 'switch',
            startedAt: now.toISOString(),
        },
    };
}

export function applyRunFinish(
    state: PosterState,
    action: Extract<PosterAction, { type: 'run' }>,
    result: { status: 'succeeded' | 'failed' | 'stopped' | 'error'; switchRunId?: string; postRunId?: string; error?: string },
    now = new Date(),
): PosterState {
    const current = state.slots[action.key] ?? { status: 'pending' as const, attempts: 0 };
    const attempts = current.attempts + 1;
    const succeeded = result.status === 'succeeded';
    const slot: PosterSlotState = {
        ...current,
        attempts,
        status: succeeded ? 'succeeded' : 'failed',
        switchRunId: result.switchRunId ?? current.switchRunId,
        postRunId: result.postRunId ?? current.postRunId,
        error: succeeded ? undefined : result.error,
        finishedAt: now.toISOString(),
        retryAfter: succeeded ? undefined : nextRetryAt(now, attempts).toISOString(),
    };
    return {
        ...state,
        currentAction: null,
        slots: { ...state.slots, [action.key]: slot },
        history: [{
            key: action.key,
            handle: action.handle,
            windowId: action.windowId,
            status: result.status,
            switchRunId: result.switchRunId,
            postRunId: result.postRunId,
            error: result.error,
            finishedAt: now.toISOString(),
        }, ...state.history].slice(0, 50),
    };
}
