import { workflows } from '../database/schema.js';
import type { PluginRouteContext } from '../plugin.js';
import {
    PosterConfigError, accountWindows, enqueueRunNow, loadPosterConfig, loadPosterState, savePosterConfig,
    validatePosterConfig,
} from './config.js';
import { findWorkflowByName } from './client.js';
import {
    POSTER_HANDLES, POSTER_SLOTS, POSTER_WINDOW_IDS, isPosterHandle, normalizeHandle, openWindows, postWorkflowName, slotKey,
    switchWorkflowName, zonedClock,
} from './windows.js';

export function registerPosterRoutes(context: PluginRouteContext): void {
    const { app } = context;
    const db = context.scheduler.connection.db;

    app.get('/api/poster', async () => {
        const config = await loadPosterConfig();
        const state = await loadPosterState();
        const rows = await db.select({
            id: workflows.id, name: workflows.name, deviceUdid: workflows.deviceUdid,
        }).from(workflows);
        const now = new Date();
        const clock = zonedClock(now, config.timezone);
        const openWindowsByAccount = Object.fromEntries(POSTER_HANDLES.map((handle) => [
            handle,
            openWindows(now, config.timezone, accountWindows(config, handle)).map((window) => window.id),
        ]));
        return {
            config,
            state,
            slots: POSTER_SLOTS,
            handles: POSTER_HANDLES,
            now: now.toISOString(),
            localDate: clock.date,
            openWindows: openWindowsByAccount,
            workflows: Object.fromEntries(POSTER_HANDLES.map((handle) => {
                const switchWf = findWorkflowByName(rows, switchWorkflowName(handle));
                const postWf = findWorkflowByName(rows, postWorkflowName(handle));
                return [handle, {
                    switch: switchWf ? { id: switchWf.id, name: switchWf.name } : null,
                    post: postWf ? { id: postWf.id, name: postWf.name } : null,
                }];
            })),
            today: Object.fromEntries(POSTER_HANDLES.map((handle) => [handle, Object.fromEntries(
                POSTER_WINDOW_IDS.map((windowId) => {
                    const key = slotKey(clock.date, windowId, handle);
                    return [windowId, state.slots[key] ?? null];
                }),
            )])),
        };
    });

    app.put('/api/poster', async (request, reply) => {
        try {
            const current = await loadPosterConfig();
            const config = validatePosterConfig(request.body ?? {}, current);
            await savePosterConfig(config);
            return { config };
        } catch (error) {
            if (error instanceof PosterConfigError) return reply.code(400).send({ error: error.message });
            throw error;
        }
    });

    app.post<{ Params: { handle: string } }>('/api/poster/accounts/:handle/run-now', async (request, reply) => {
        const handle = normalizeHandle(decodeURIComponent(request.params.handle));
        if (!isPosterHandle(handle)) {
            return reply.code(400).send({ error: `Unknown account: ${handle}` });
        }
        const config = await loadPosterConfig();
        if (!config.accounts[handle]?.enabled) {
            return reply.code(409).send({ error: `${handle} is disabled` });
        }
        const queued = await enqueueRunNow(handle);
        return { ok: true, queued };
    });
}
