import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { dataRoot } from '../content/paths.js';
import {
    DEFAULT_TIMEZONE, POSTER_HANDLES, POSTER_WINDOW_IDS, coercePosterWindowId, isPosterHandle, normalizeHandle,
    type PosterHandle, type PosterWindowId,
} from './windows.js';

export interface PosterAccountConfig {
    enabled: boolean;
    windows: PosterWindowId[];
}

export interface PosterConfig {
    enabled: boolean;
    timezone: string;
    accounts: Record<PosterHandle, PosterAccountConfig>;
}

export type PosterSlotStatus = 'pending' | 'succeeded' | 'failed';

export interface PosterSlotState {
    plannedAt?: string;
    status: PosterSlotStatus;
    attempts: number;
    retryAfter?: string;
    switchRunId?: string;
    postRunId?: string;
    error?: string;
    finishedAt?: string;
}

export interface PosterCurrentAction {
    handle: PosterHandle;
    windowId: PosterWindowId | 'now';
    key: string;
    step: 'switch' | 'post';
    runId?: string;
    startedAt: string;
}

export interface PosterHistoryEntry {
    key: string;
    handle: string;
    windowId: string;
    status: string;
    switchRunId?: string;
    postRunId?: string;
    error?: string;
    finishedAt: string;
}

export interface PosterState {
    heartbeatAt?: string;
    currentAction?: PosterCurrentAction | null;
    slots: Record<string, PosterSlotState>;
    history: PosterHistoryEntry[];
}

export interface PosterRunNowRequest {
    handle: PosterHandle;
    requestedAt: string;
}

const DEFAULT_WINDOWS: PosterWindowId[] = ['9am-noon', '6pm-9pm'];

export const defaultPosterConfig = (): PosterConfig => ({
    enabled: false,
    timezone: DEFAULT_TIMEZONE,
    accounts: {
        '@pixl.robotics': { enabled: true, windows: [...DEFAULT_WINDOWS] },
        '@my_sane_tea': { enabled: true, windows: [...DEFAULT_WINDOWS] },
    },
});

export const emptyPosterState = (): PosterState => ({
    currentAction: null,
    slots: {},
    history: [],
});

export class PosterConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PosterConfigError';
    }
}

export function validatePosterConfig(input: unknown, fallback: PosterConfig = defaultPosterConfig()): PosterConfig {
    if (input === null || input === undefined) return fallback;
    if (typeof input !== 'object' || Array.isArray(input)) {
        throw new PosterConfigError('Poster config must be an object');
    }
    const body = input as Record<string, unknown>;
    const enabled = body.enabled === undefined ? fallback.enabled : Boolean(body.enabled);
    const timezone = DEFAULT_TIMEZONE;

    // Top-level `windows` is the old shared-slot shape. Keep reading it so
    // existing poster-config.json files and patches still apply, then copy
    // onto any account that does not set its own list.
    const sharedWindows = body.windows === undefined
        ? undefined : parseWindowList(body.windows, 'windows');

    const accounts: Record<PosterHandle, PosterAccountConfig> = {
        '@pixl.robotics': { ...fallback.accounts['@pixl.robotics'], windows: [...fallback.accounts['@pixl.robotics'].windows] },
        '@my_sane_tea': { ...fallback.accounts['@my_sane_tea'], windows: [...fallback.accounts['@my_sane_tea'].windows] },
    };
    if (sharedWindows) {
        for (const handle of POSTER_HANDLES) accounts[handle].windows = [...sharedWindows];
    }
    if (body.accounts !== undefined) {
        if (typeof body.accounts !== 'object' || body.accounts === null || Array.isArray(body.accounts)) {
            throw new PosterConfigError('accounts must be an object');
        }
        for (const [rawHandle, rawAccount] of Object.entries(body.accounts as Record<string, unknown>)) {
            const handle = normalizeHandle(rawHandle);
            if (!isPosterHandle(handle)) {
                throw new PosterConfigError(`Unknown account: ${rawHandle}`);
            }
            if (typeof rawAccount !== 'object' || rawAccount === null || Array.isArray(rawAccount)) {
                throw new PosterConfigError(`Account ${handle} must be an object`);
            }
            const account = rawAccount as Record<string, unknown>;
            accounts[handle] = {
                enabled: account.enabled === undefined ? accounts[handle].enabled : Boolean(account.enabled),
                windows: account.windows === undefined
                    ? accounts[handle].windows
                    : parseWindowList(account.windows, `${handle} windows`),
            };
        }
    }

    return { enabled, timezone, accounts };
}

export function parseWindowList(value: unknown, label: string): PosterWindowId[] {
    if (!Array.isArray(value)) throw new PosterConfigError(`${label} must be an array`);
    const next: PosterWindowId[] = [];
    for (const entry of value) {
        const id = typeof entry === 'string' ? coercePosterWindowId(entry) : undefined;
        if (!id) {
            throw new PosterConfigError(`Unknown time window: ${String(entry)}. Use ${POSTER_WINDOW_IDS.join(', ')}`);
        }
        if (!next.includes(id)) next.push(id);
    }
    return next;
}

export function accountWindows(config: PosterConfig, handle: PosterHandle): PosterWindowId[] {
    return config.accounts[handle]?.windows ?? [];
}

export function parsePosterState(input: unknown): PosterState {
    const empty = emptyPosterState();
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return empty;
    const body = input as Record<string, unknown>;
    const slots = typeof body.slots === 'object' && body.slots && !Array.isArray(body.slots)
        ? body.slots as Record<string, PosterSlotState> : {};
    const history = Array.isArray(body.history) ? body.history as PosterHistoryEntry[] : [];
    const currentAction = body.currentAction && typeof body.currentAction === 'object'
        ? body.currentAction as PosterCurrentAction : null;
    return {
        heartbeatAt: typeof body.heartbeatAt === 'string' ? body.heartbeatAt : undefined,
        currentAction,
        slots,
        history,
    };
}

function configPath(): string {
    return path.join(dataRoot(), 'poster-config.json');
}

function statePath(): string {
    return path.join(dataRoot(), 'poster-state.json');
}

function requestsDir(): string {
    return path.join(dataRoot(), 'poster-requests');
}

async function readJson(file: string): Promise<unknown> {
    const text = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
    });
    if (!text.trim()) return null;
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return null;
    }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
}

export async function loadPosterConfig(): Promise<PosterConfig> {
    const parsed = await readJson(configPath());
    if (parsed === null) return defaultPosterConfig();
    try {
        return validatePosterConfig(parsed);
    } catch {
        return defaultPosterConfig();
    }
}

export async function savePosterConfig(config: PosterConfig): Promise<void> {
    await writeJsonAtomic(configPath(), config);
}

export async function loadPosterState(): Promise<PosterState> {
    return parsePosterState(await readJson(statePath()));
}

export async function savePosterState(state: PosterState): Promise<void> {
    await writeJsonAtomic(statePath(), state);
}

export async function enqueueRunNow(handle: PosterHandle): Promise<PosterRunNowRequest> {
    const request: PosterRunNowRequest = { handle, requestedAt: new Date().toISOString() };
    const dir = requestsDir();
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${handle.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
    await writeFile(file, `${JSON.stringify(request)}\n`, 'utf8');
    return request;
}

export async function takeRunNowRequests(): Promise<Array<PosterRunNowRequest & { file: string }>> {
    const dir = requestsDir();
    const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [] as string[];
        throw error;
    });
    const requests: Array<PosterRunNowRequest & { file: string }> = [];
    for (const name of names.sort()) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(dir, name);
        const parsed = await readJson(file);
        if (typeof parsed !== 'object' || parsed === null) {
            await rm(file, { force: true }).catch(() => {});
            continue;
        }
        const handle = normalizeHandle(String((parsed as { handle?: unknown }).handle ?? ''));
        if (!isPosterHandle(handle)) {
            await rm(file, { force: true }).catch(() => {});
            continue;
        }
        const requestedAt = typeof (parsed as { requestedAt?: unknown }).requestedAt === 'string'
            ? (parsed as { requestedAt: string }).requestedAt : new Date().toISOString();
        requests.push({ handle, requestedAt, file });
    }
    return requests;
}

export async function ackRunNow(file: string): Promise<void> {
    await rm(file, { force: true }).catch(() => {});
}

export function withHeartbeat(state: PosterState, now = new Date()): PosterState {
    return { ...state, heartbeatAt: now.toISOString() };
}

export function appendHistory(state: PosterState, entry: PosterHistoryEntry, limit = 50): PosterState {
    return { ...state, history: [entry, ...state.history].slice(0, limit) };
}

export { POSTER_HANDLES };
