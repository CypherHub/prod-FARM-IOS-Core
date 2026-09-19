import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    ackRunNow, loadPosterConfig, loadPosterState, savePosterState, takeRunNowRequests, withHeartbeat,
} from './config.js';
import {
    createPosterHttpClient, farmBaseUrl, findWorkflowByName, waitForRun, type PosterHttpClient, type WorkflowSummary,
} from './client.js';
import { applyPlan, applyRunFinish, applyRunStart, nextPosterAction } from './tick.js';
import { postWorkflowName, switchWorkflowName, type PosterHandle } from './windows.js';

const TICK_MS = 30_000;

export interface PosterRuntime {
    stop(): void;
}

export async function runPosterTick(
    client: PosterHttpClient,
    now = new Date(),
    random: () => number = Math.random,
): Promise<'ran' | 'planned' | 'idle'> {
    const config = await loadPosterConfig();
    let state = withHeartbeat(await loadPosterState(), now);
    const runNow = await takeRunNowRequests();

    const action = nextPosterAction(config, state, now, runNow, random);
    if (action.type === 'idle') {
        await savePosterState(state);
        return 'idle';
    }
    if (action.type === 'discard') {
        for (const request of runNow) {
            if (request.handle === action.handle) await ackRunNow(request.file);
        }
        await savePosterState(state);
        console.log(`[poster] dropped run-now for ${action.handle}: ${action.reason}`);
        return 'idle';
    }
    if (action.type === 'plan') {
        state = applyPlan(state, action.key, action.plannedAt);
        await savePosterState(state);
        console.log(`[poster] planned ${action.handle} ${action.windowId} at ${action.plannedAt}`);
        return 'planned';
    }

    const request = runNow.find((item) => item.handle === action.handle);
    state = applyRunStart(state, action, now);
    await savePosterState(state);

    const result = await replayAccount(client, action.handle);
    state = applyRunFinish(await loadPosterState(), action, result, new Date());
    await savePosterState(withHeartbeat(state));
    if (request) await ackRunNow(request.file);

    console.log(`[poster] ${action.handle} ${action.windowId} -> ${result.status}${result.error ? `: ${result.error}` : ''}`);
    return 'ran';
}

async function replayAccount(
    client: PosterHttpClient,
    handle: PosterHandle,
): Promise<{ status: 'succeeded' | 'failed' | 'stopped' | 'error'; switchRunId?: string; postRunId?: string; error?: string }> {
    try {
        const { workflows } = await client.get<{ workflows: WorkflowSummary[] }>('/api/workflows', 10_000);
        const switchWf = findWorkflowByName(workflows, switchWorkflowName(handle));
        const postWf = findWorkflowByName(workflows, postWorkflowName(handle));
        if (!switchWf) return { status: 'error', error: `Missing workflow: ${switchWorkflowName(handle)}` };
        if (!postWf) return { status: 'error', error: `Missing workflow: ${postWorkflowName(handle)}` };

        const switched = await client.post<{ runId: string }>(`/api/workflows/${switchWf.id}/replay`);
        const switchStatus = await waitForRun(client, switched.runId);
        if (switchStatus.status !== 'succeeded') {
            return {
                status: switchStatus.status === 'stopped' ? 'stopped' : switchStatus.status === 'failed' ? 'failed' : 'error',
                switchRunId: switched.runId,
                error: switchStatus.error ?? `Switch workflow ${switchStatus.status}`,
            };
        }

        const posted = await client.post<{ runId: string }>(`/api/workflows/${postWf.id}/replay`);
        const postStatus = await waitForRun(client, posted.runId);
        if (postStatus.status !== 'succeeded') {
            return {
                status: postStatus.status === 'stopped' ? 'stopped' : postStatus.status === 'failed' ? 'failed' : 'error',
                switchRunId: switched.runId,
                postRunId: posted.runId,
                error: postStatus.error ?? `Post workflow ${postStatus.status}`,
            };
        }
        return { status: 'succeeded', switchRunId: switched.runId, postRunId: posted.runId };
    } catch (error) {
        return { status: 'error', error: error instanceof Error ? error.message : String(error) };
    }
}

export function startPosterLoop(client: PosterHttpClient = createPosterHttpClient()): PosterRuntime {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const wait = (ms: number) => new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
    });

    const tick = async (): Promise<void> => {
        if (stopped) return;
        try {
            const outcome = await runPosterTick(client);
            if (stopped) return;
            await wait(outcome === 'idle' ? TICK_MS : 250);
            void tick();
        } catch (error) {
            console.error(`[poster] tick failed: ${error instanceof Error ? error.message : error}`);
            if (!stopped) {
                await wait(TICK_MS);
                void tick();
            }
        }
    };

    void (async () => {
        console.log(`[poster] starting; farm ${farmBaseUrl()}`);
        while (!stopped) {
            try {
                await client.get('/api/workflows', 5_000);
                break;
            } catch (error) {
                console.log(`[poster] waiting for farm: ${error instanceof Error ? error.message : error}`);
                await wait(2_000);
            }
        }
        if (stopped) return;
        console.log('[poster] farm is up; watching time windows');
        await tick();
    })();

    return {
        stop() {
            stopped = true;
            if (timer) clearTimeout(timer);
        },
    };
}

async function main(): Promise<void> {
    process.on('uncaughtException', (error) => {
        console.error('[poster] uncaughtException (handled):', error instanceof Error ? error.message : error);
    });
    process.on('unhandledRejection', (error) => {
        console.error('[poster] unhandledRejection (handled):', error instanceof Error ? error.message : error);
    });
    const runtime = startPosterLoop();
    const stop = (signal: string) => {
        console.log(`[poster] stopping after ${signal}`);
        runtime.stop();
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    await main();
}
