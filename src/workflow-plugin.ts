import crypto from 'node:crypto';
import { eq, asc, and, desc, count } from 'drizzle-orm';
import { remote, type Browser } from 'webdriverio';

import { workflows, workflowSteps, generations, workflowRuns } from './database/schema.js';
import { screenshotToJpeg } from './tiktok/vision-guide.js';
import { tiktokAppiumCapabilities } from './tiktok/appium-session.js';
import type { PhoneFarmPlugin, PluginRouteContext } from './plugin.js';
import type { WorkflowStatus, WorkflowStepType, WorkflowStep } from './types.js';

// A lightweight Appium session that attaches to an already-running app without
// killing or relaunching it. Uses the existing WDA via webDriverAgentUrl to
// avoid port conflicts.
const APP = { host: process.env.APPIUM_HOST ?? '127.0.0.1', port: Number(process.env.APPIUM_PORT ?? 4725), path: '/' };
const WDA = process.env.WDA_URL ?? 'http://127.0.0.1:8100';

async function appiumSession(udid: string, bundleId: string): Promise<Browser> {
    return remote({
        ...APP,
        logLevel: 'error',
        connectionRetryCount: 0,
        capabilities: {
            ...tiktokAppiumCapabilities(udid, bundleId, {
                'appium:webDriverAgentUrl': WDA,
            }),
        },
    });
}

interface ActiveReplay {
    workflowId: string;
    workflowName: string;
    deviceUdid: string;
    startTime: Date;
    status: 'running' | 'succeeded' | 'failed' | 'stopped';
    currentStep: number;
    totalSteps: number;
    logs: Array<{ step: number; message: string; type: 'info' | 'error' | 'condition' }>;
    error?: string;
}

const activeReplays = new Map<string, ActiveReplay>();

function startReplayEntry(workflowId: string, workflowName: string, deviceUdid: string, totalSteps: number, db?: any): string {
    const runId = crypto.randomUUID();
    activeReplays.set(runId, {
        workflowId,
        workflowName,
        deviceUdid,
        startTime: new Date(),
        status: 'running',
        currentStep: 0,
        totalSteps,
        logs: [],
    });

    // Persist immediately so the run appears in the historical log page
    if (db) {
        db.insert(workflowRuns).values({
            id: runId,
            workflowId,
            deviceUdid,
            status: 'running',
            totalSteps,
            logs: [],
            startedAt: new Date(),
        }).catch(() => {});
    }

    return runId;
}

function updateReplayLog(runId: string, step: number, message: string, type: 'info' | 'error' | 'condition' = 'info'): void {
    const replay = activeReplays.get(runId);
    if (replay) {
        replay.logs.push({ step, message, type });
        replay.currentStep = step;
    }
}

function finishReplay(runId: string, status: 'succeeded' | 'failed' | 'stopped', error?: string, db?: any): void {
    const replay = activeReplays.get(runId);
    if (replay) {
        replay.status = status;
        replay.error = error;
    }

    // Persist final status to DB
    if (db && runId) {
        db.update(workflowRuns).set({
            status,
            logs: replay?.logs ?? [],
            error: error ?? null,
            finishedAt: new Date(),
        }).where(eq(workflowRuns.id, runId)).catch(() => {});
    }
}

async function evaluateCondition(
    question: string,
    screenshot: Buffer,
): Promise<{ answer: boolean; reason: string }> {
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is required for AI conditions');

    const model = process.env.DEEPSEEK_MODEL?.trim() || 'deepseek/deepseek-v4-flash-vision-exp';
    const baseUrl = (process.env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
    const jpeg = await screenshotToJpeg(screenshot);

    const payload = {
        model,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        messages: [
            {
                role: 'system',
                content: 'You answer YES or NO to a question based on the current screenshot of an iPhone. Return ONLY a JSON object with keys: answer ("yes" or "no"), reason (short explanation).',
            },
            {
                role: 'user',
                content: [
                    { type: 'text', text: `Answer YES or NO: ${question}` },
                    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}`, detail: 'high' } },
                ],
            },
        ],
    };

    const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            'HTTP-Referer': 'https://github.com/CypherHub/prod-FARM-IOS-Core',
            'X-Title': 'phone-farm-core',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) throw new Error(`AI vision API returned ${response.status}`);

    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error('AI vision returned empty response');

    // Extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const json = jsonMatch?.[0] ?? content;
    const parsed = JSON.parse(json) as { answer?: string; reason?: string };
    const answer = String(parsed.answer ?? '').trim().toLowerCase();

    if (answer !== 'yes' && answer !== 'no') {
        throw new Error(`AI returned unexpected answer: ${answer} (expected yes or no)`);
    }

    return { answer: answer === 'yes', reason: parsed.reason ?? 'No reason given' };
}

async function runSteps(
    remote: PluginRouteContext['remote'],
    deviceUdid: string,
    steps: any[],
    signal: AbortSignal,
    runId: string,
    db?: any,
): Promise<void> {
    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (signal.aborted) {
            updateReplayLog(runId, step.stepOrder, 'Replay stopped by user', 'info');
            return;
        }

        try {
            switch (step.stepType) {
                case 'tap': {
                    if (step.x === undefined || step.y === undefined) {
                        throw new Error('Tap step missing coordinates');
                    }
                    await remote.performAction(deviceUdid, { type: 'tap', x: step.x, y: step.y });
                    updateReplayLog(runId, step.stepOrder, `Tapped (${step.x}, ${step.y})${step.label ? ` — ${step.label}` : ''}`, 'info');
                    break;
                }
                case 'swipe': {
                    if (step.x === undefined || step.y === undefined || step.endX === undefined || step.endY === undefined || step.durationMs === undefined) {
                        throw new Error('Swipe step missing coordinates or duration');
                    }
                    await remote.performAction(deviceUdid, {
                        type: 'swipe',
                        startX: step.x,
                        startY: step.y,
                        endX: step.endX,
                        endY: step.endY,
                        durationMs: step.durationMs,
                    });
                    updateReplayLog(runId, step.stepOrder, `Swiped from (${step.x}, ${step.y}) to (${step.endX}, ${step.endY}) over ${step.durationMs}ms${step.label ? ` — ${step.label}` : ''}`, 'info');
                    break;
                }
                case 'wait': {
                    const ms = step.waitMs ?? 1000;
                    await new Promise<void>((resolve, reject) => {
                        const timer = setTimeout(resolve, ms);
                        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Aborted')); }, { once: true });
                    });
                    updateReplayLog(runId, step.stepOrder, `Waited ${ms}ms${step.label ? ` — ${step.label}` : ''}`, 'info');
                    break;
                }
                case 'home': {
                    await remote.performAction(deviceUdid, { type: 'home' });
                    updateReplayLog(runId, step.stepOrder, `Pressed Home${step.label ? ` — ${step.label}` : ''}`, 'info');
                    break;
                }
                case 'unlock': {
                    await remote.performAction(deviceUdid, { type: 'unlock' });
                    updateReplayLog(runId, step.stepOrder, `Unlocked device${step.label ? ` — ${step.label}` : ''}`, 'info');
                    break;
                }
                case 'open_url': {
                    if (!step.url) throw new Error('open_url step missing url');
                    await remote.performAction(deviceUdid, { type: 'home' });
                    await new Promise((r) => setTimeout(r, 1000));
                    // Use Appium mobile: deepLink to open the URL
                    const linkDriver = await appiumSession(deviceUdid, 'com.apple.mobilesafari');
                    try {
                        await linkDriver.execute('mobile: deepLink', { url: step.url });
                    } finally {
                        await linkDriver.deleteSession().catch(() => {});
                    }
                    await new Promise((r) => setTimeout(r, 3000));
                    updateReplayLog(runId, step.stepOrder, `Opened URL: ${step.url}${step.label ? ` — ${step.label}` : ''}`, 'info');
                    break;
                }
                case 'app_action': {
                    if (!step.appBundleId) throw new Error('app_action step missing appBundleId');
                    await remote.performAction(deviceUdid, { type: 'home' });
                    await new Promise((r) => setTimeout(r, 500));
                    const appDriver = await appiumSession(deviceUdid, step.appBundleId);
                    try {
                        if (step.appActionType === 'terminate') {
                            await appDriver.terminateApp(step.appBundleId);
                        } else {
                            await appDriver.activateApp(step.appBundleId);
                        }
                    } finally {
                        await appDriver.deleteSession().catch(() => {});
                    }
                    await new Promise((r) => setTimeout(r, 2000));
                    const actionLabel = step.appActionType === 'terminate' ? 'Terminated' : 'Launched';
                    updateReplayLog(runId, step.stepOrder, `${actionLabel} app ${step.appBundleId}${step.label ? ` — ${step.label}` : ''}`, 'info');
                    break;
                }
                case 'screenshot': {
                    const buf = await remote.getScreenshot(deviceUdid);
                    const { writeFile, mkdir } = await import('node:fs/promises');
                    const pathModule = (await import('node:path')).default;
                    const dataRoot = process.env.SCHEDULER_DATA_DIR ?? '.scheduler-data';
                    const screenshotDir = pathModule.join(dataRoot, 'workflow-screenshots', runId);
                    await mkdir(screenshotDir, { recursive: true });
                    await writeFile(pathModule.join(screenshotDir, `step-${step.stepOrder}.png`), buf);
                    updateReplayLog(runId, step.stepOrder, `Screenshot saved (step ${step.stepOrder})${step.label ? ` — ${step.label}` : ''}`, 'info');
                    break;
                }
                case 'if_condition': {
                    if (!step.aiQuestion) throw new Error('IF condition step missing aiQuestion');
                    const buf = await remote.getScreenshot(deviceUdid);
                    const { answer, reason } = await evaluateCondition(step.aiQuestion, buf);
                    updateReplayLog(runId, step.stepOrder, `AI condition: "${step.aiQuestion}" → ${answer ? 'YES' : 'NO'} (${reason})${step.label ? ` — ${step.label}` : ''}`, 'condition');
                    if (step.skipSteps) {
                        // Skip mode: YES = skip forward skipSteps steps; NO = continue (don't stop)
                        if (answer) {
                            i += step.skipSteps;
                            updateReplayLog(runId, step.stepOrder, `Condition met, skipping ${step.skipSteps} step(s)`, 'info');
                        } else {
                            updateReplayLog(runId, step.stepOrder, `Condition not met, continuing (skipping not triggered)`, 'info');
                        }
                    } else {
                        // Gate mode: YES = continue; NO = stop replay (legacy behavior)
                        if (!answer) {
                            updateReplayLog(runId, step.stepOrder, `Condition not met, stopping replay`, 'info');
                            finishReplay(runId, 'stopped', `AI condition "${step.aiQuestion}" evaluated as NO: ${reason}`, db);
                            return;
                        }
                    }
                    break;
                }
                case 'type_keys': {
                    if (!step.text) {
                        updateReplayLog(runId, step.stepOrder, `Skipping type_keys (no text)${step.label ? ` — ${step.label}` : ''}`, 'info');
                        break;
                    }
                    // Attach a lightweight Appium session to TikTok to type into its focused field
                    const bundleId = process.env.TIKTOK_BUNDLE_ID ?? 'com.zhiliaoapp.musically';
                    const keyDriver = await appiumSession(deviceUdid, bundleId);
                    try {
                        const appiumHost = process.env.APPIUM_HOST ?? '127.0.0.1';
                        const appiumPort = Number(process.env.APPIUM_PORT ?? 4725);
                        const response = await fetch(`http://${appiumHost}:${appiumPort}/session/${keyDriver.sessionId}/keys`, {
                            method: 'POST',
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({ value: [step.text] }),
                        });
                        if (!response.ok) throw new Error(`Appium type_keys failed: ${await response.text()}`);
                    } finally {
                        await keyDriver.deleteSession().catch(() => {});
                    }
                    updateReplayLog(runId, step.stepOrder, `Typed caption`, 'info');
                    break;
                }
                default: {
                    updateReplayLog(runId, step.stepOrder, `Unknown step type: ${step.stepType}`, 'error');
                }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            updateReplayLog(runId, step.stepOrder, `Error: ${message}`, 'error');
            finishReplay(runId, 'failed', message, db);
            return;
        }
    }

    finishReplay(runId, 'succeeded', undefined, db);
}

export function createWorkflowPlugin(): PhoneFarmPlugin {
    return {
        id: 'org.phone-farm.workflows',
        version: '0.1.0',
        displayName: 'Workflows',
        tasks: [],
        navLinks: [
            { label: 'Workflows', href: '/workflows', order: 2 },
            { label: 'Workflow Runs', href: '/workflow-runs', order: 3 },
        ],
        registerRoutes(context: PluginRouteContext) {
            const { app } = context;
            const db = context.scheduler.connection.db;

            // List workflows
            app.get('/api/workflows', async () => {
                const rows = await db.select().from(workflows)
                    .orderBy(asc(workflows.createdAt));
                return { workflows: rows };
            });

            // Create workflow
            app.post<{ Body: { name: string; description?: string; deviceUdid?: string } }>('/api/workflows', async (request, reply) => {
                const { name, description, deviceUdid } = request.body;
                if (!name?.trim()) return reply.code(400).send({ error: 'Workflow name is required' });
                const [row] = await db.insert(workflows).values({
                    name: name.trim(),
                    description: description?.trim() ?? null,
                    deviceUdid: deviceUdid?.trim() ?? null,
                    status: 'draft',
                }).returning();
                return reply.code(201).send(row);
            });

            // Get workflow with steps
            app.get<{ Params: { id: string } }>('/api/workflows/:id', async (request, reply) => {
                const [wf] = await db.select().from(workflows).where(eq(workflows.id, request.params.id));
                if (!wf) return reply.code(404).send({ error: 'Workflow not found' });
                const steps = await db.select().from(workflowSteps)
                    .where(eq(workflowSteps.workflowId, request.params.id))
                    .orderBy(asc(workflowSteps.stepOrder));
                return { ...wf, steps };
            });

            // Update workflow
            app.patch<{ Params: { id: string }; Body: { name?: string; description?: string; deviceUdid?: string; status?: WorkflowStatus } }>('/api/workflows/:id', async (request, reply) => {
                const updates: Record<string, unknown> = {};
                if (request.body.name !== undefined) updates.name = request.body.name.trim();
                if (request.body.description !== undefined) updates.description = request.body.description?.trim() ?? null;
                if (request.body.deviceUdid !== undefined) updates.deviceUdid = request.body.deviceUdid?.trim() ?? null;
                if (request.body.status !== undefined) updates.status = request.body.status;
                updates.updatedAt = new Date();
                const [row] = await db.update(workflows).set(updates)
                    .where(eq(workflows.id, request.params.id)).returning();
                if (!row) return reply.code(404).send({ error: 'Workflow not found' });
                return row;
            });

            // Delete workflow
            app.delete<{ Params: { id: string } }>('/api/workflows/:id', async (request, reply) => {
                const [deleted] = await db.delete(workflows).where(eq(workflows.id, request.params.id)).returning({ id: workflows.id });
                if (!deleted) return reply.code(404).send({ error: 'Workflow not found' });
                return reply.code(204).send();
            });

            // Add step to workflow
            app.post<{
                Params: { id: string };
                Body: {
                    stepType: WorkflowStepType;
                    label?: string;
                    x?: number; y?: number;
                    endX?: number; endY?: number;
                    durationMs?: number;
                    waitMs?: number;
                    aiQuestion?: string;
                    appBundleId?: string;
                    appActionType?: string;
                    url?: string;
                    text?: string;
                    skipSteps?: number;
                };
            }>('/api/workflows/:id/steps', async (request, reply) => {
                const { id } = request.params;
                const [wf] = await db.select({ id: workflows.id }).from(workflows).where(eq(workflows.id, id));
                if (!wf) return reply.code(404).send({ error: 'Workflow not found' });
                if (!request.body.stepType) return reply.code(400).send({ error: 'Step type is required' });

                const existing = await db.select({ stepOrder: workflowSteps.stepOrder }).from(workflowSteps)
                    .where(eq(workflowSteps.workflowId, id))
                    .orderBy(asc(workflowSteps.stepOrder));
                const nextOrder = existing.length > 0 ? existing[existing.length - 1]!.stepOrder + 1 : 1;

                const [row] = await db.insert(workflowSteps).values({
                    workflowId: id,
                    stepOrder: nextOrder,
                    stepType: request.body.stepType,
                    label: request.body.label?.trim() ?? null,
                    x: request.body.x ?? null,
                    y: request.body.y ?? null,
                    endX: request.body.endX ?? null,
                    endY: request.body.endY ?? null,
                    durationMs: request.body.durationMs ?? null,
                    waitMs: request.body.waitMs ?? null,
                    aiQuestion: request.body.aiQuestion?.trim() ?? null,
                    appBundleId: request.body.appBundleId?.trim() ?? null,
                    appActionType: request.body.appActionType?.trim() ?? null,
                    url: request.body.url?.trim() ?? null,
                    text: request.body.text?.trim() ?? null,
                    skipSteps: request.body.skipSteps ?? null,
                }).returning();
                return reply.code(201).send(row);
            });

            // Update step
            app.patch<{
                Params: { stepId: string };
                Body: {
                    stepType?: WorkflowStepType;
                    label?: string;
                    x?: number; y?: number;
                    endX?: number; endY?: number;
                    durationMs?: number;
                    waitMs?: number;
                    aiQuestion?: string;
                    appBundleId?: string;
                    appActionType?: string;
                    url?: string;
                    stepOrder?: number;
                    text?: string;
                    skipSteps?: number;
                };
            }>('/api/workflow-steps/:stepId', async (request, reply) => {
                const updates: Record<string, unknown> = {};
                if (request.body.stepType !== undefined) updates.stepType = request.body.stepType;
                if (request.body.label !== undefined) updates.label = request.body.label?.trim() ?? null;
                if (request.body.x !== undefined) updates.x = request.body.x;
                if (request.body.y !== undefined) updates.y = request.body.y;
                if (request.body.endX !== undefined) updates.endX = request.body.endX;
                if (request.body.endY !== undefined) updates.endY = request.body.endY;
                if (request.body.durationMs !== undefined) updates.durationMs = request.body.durationMs;
                if (request.body.waitMs !== undefined) updates.waitMs = request.body.waitMs;
                if (request.body.aiQuestion !== undefined) updates.aiQuestion = request.body.aiQuestion?.trim() ?? null;
                if (request.body.appBundleId !== undefined) updates.appBundleId = request.body.appBundleId?.trim() ?? null;
                if (request.body.appActionType !== undefined) updates.appActionType = request.body.appActionType?.trim() ?? null;
                if (request.body.url !== undefined) updates.url = request.body.url?.trim() ?? null;
                if (request.body.stepOrder !== undefined) updates.stepOrder = request.body.stepOrder;
                if (request.body.text !== undefined) updates.text = request.body.text?.trim() ?? null;
                if (request.body.skipSteps !== undefined) updates.skipSteps = request.body.skipSteps;

                const [row] = await db.update(workflowSteps).set(updates)
                    .where(eq(workflowSteps.id, request.params.stepId)).returning();
                if (!row) return reply.code(404).send({ error: 'Step not found' });
                return row;
            });

            // Delete step
            app.delete<{ Params: { stepId: string } }>('/api/workflow-steps/:stepId', async (request, reply) => {
                const [step] = await db.select({
                    workflowId: workflowSteps.workflowId,
                    stepOrder: workflowSteps.stepOrder,
                }).from(workflowSteps).where(eq(workflowSteps.id, request.params.stepId));
                if (!step) return reply.code(404).send({ error: 'Step not found' });

                await db.delete(workflowSteps)
                    .where(eq(workflowSteps.id, request.params.stepId));

                // Re-order remaining steps
                const remaining = await db.select({ id: workflowSteps.id, stepOrder: workflowSteps.stepOrder })
                    .from(workflowSteps)
                    .where(eq(workflowSteps.workflowId, step.workflowId))
                    .orderBy(asc(workflowSteps.stepOrder));
                let newOrder = 1;
                for (const s of remaining) {
                    if (s.stepOrder !== newOrder) {
                        await db.update(workflowSteps).set({ stepOrder: newOrder })
                            .where(eq(workflowSteps.id, s.id));
                    }
                    newOrder++;
                }

                return reply.code(204).send();
            });

            // Reorder steps
            app.put<{ Params: { id: string }; Body: { stepIds: string[] } }>('/api/workflows/:id/steps/reorder', async (request, reply) => {
                const { stepIds } = request.body;
                if (!Array.isArray(stepIds)) return reply.code(400).send({ error: 'stepIds must be an array' });
                for (let i = 0; i < stepIds.length; i++) {
                    await db.update(workflowSteps).set({ stepOrder: i + 1 })
                        .where(eq(workflowSteps.id, stepIds[i]!));
                }
                return reply.code(204).send();
            });

            // Replay workflow
            app.post<{ Params: { id: string } }>('/api/workflows/:id/replay', async (request, reply) => {
                const { id } = request.params;
                const [wf] = await db.select().from(workflows).where(eq(workflows.id, id));
                if (!wf) return reply.code(404).send({ error: 'Workflow not found' });
                if (!wf.deviceUdid) return reply.code(400).send({ error: 'Workflow has no device assigned' });

                const steps = await db.select().from(workflowSteps)
                    .where(eq(workflowSteps.workflowId, id))
                    .orderBy(asc(workflowSteps.stepOrder)) as unknown as WorkflowStep[];
                if (steps.length === 0) return reply.code(400).send({ error: 'Workflow has no steps' });

                const runId = startReplayEntry(id, wf.name, wf.deviceUdid, steps.length, db);

                // Run replay in background (no await)
                const abortController = new AbortController();
                runSteps(context.remote, wf.deviceUdid, steps, abortController.signal, runId, db).catch(() => {
                    finishReplay(runId, 'failed', 'Unexpected error during replay', db);
                });

                return reply.code(202).send({
                    runId,
                    status: 'running',
                    totalSteps: steps.length,
                    deviceUdid: wf.deviceUdid,
                    workflowId: id,
                });
            });

            // Stop replay
            app.post<{ Params: { runId: string } }>('/api/workflows/replay/:runId/stop', async (request, reply) => {
                const replay = activeReplays.get(request.params.runId);
                if (!replay) return reply.code(404).send({ error: 'Replay not found' });
                if (replay.status !== 'running') return reply.code(409).send({ error: 'Replay is not running' });
                finishReplay(request.params.runId, 'stopped', 'Stopped by user', db);
                return { ok: true };
            });

            // Get replay status
            app.get<{ Params: { runId: string } }>('/api/workflows/replay/:runId', async (request, reply) => {
                const replay = activeReplays.get(request.params.runId);
                if (!replay) {
                    return reply.code(404).send({ error: 'Replay not found' });
                }
                return {
                    ...replay,
                    startTime: replay.startTime.toISOString(),
                };
            });

            // List active replays
            app.get('/api/workflows/replays', async () => {
                const entries: Array<Record<string, unknown>> = [];
                for (const [runId, replay] of activeReplays) {
                    entries.push({
                        runId,
                        ...replay,
                        startTime: replay.startTime.toISOString(),
                    });
                }
                return { replays: entries };
            });

            // Clean up completed replays (older than 5 min)
            app.post('/api/workflows/replays/cleanup', async () => {
                const now = Date.now();
                for (const [runId, replay] of activeReplays) {
                    if (replay.status !== 'running' && now - replay.startTime.getTime() > 5 * 60_000) {
                        activeReplays.delete(runId);
                    }
                }
                return { ok: true };
            });

            // Queue generation via workflow: import media to device, patch caption, run workflow
            app.post<{
                Params: { generationId: string };
                Body: { workflowId: string; caption?: string };
            }>('/api/generations/:generationId/queue-via-workflow', async (request, reply) => {
                const { generationId } = request.params;
                const { workflowId, caption } = request.body;
                if (!workflowId) return reply.code(400).send({ error: 'workflowId is required' });

                // Fetch generation
                const [gen] = await db.select().from(generations).where(eq(generations.id, generationId));
                if (!gen) return reply.code(404).send({ error: 'Generation not found' });
                if (!gen.outputDir) return reply.code(409).send({ error: 'Generation has no output files' });

                // Fetch workflow
                const [wf] = await db.select().from(workflows).where(eq(workflows.id, workflowId));
                if (!wf) return reply.code(404).send({ error: 'Workflow not found' });

                // Determine device UDID
                const udid = gen.deviceUdid ?? wf.deviceUdid;
                if (!udid) return reply.code(400).send({ error: 'No device assigned to this generation or workflow' });

                // Find the video file
                const { readdir, readFile } = await import('node:fs/promises');
                const pathModule = await import('node:path');
                const VIDEO_OUTPUT = 'post.mp4';
                const produced = await readdir(gen.outputDir);
                const videoFile = produced.find((name) => name === VIDEO_OUTPUT);
                if (!videoFile) return reply.code(409).send({ error: 'Generation produced no video file' });
                const videoPath = pathModule.join(gen.outputDir, videoFile);

                // Import video to device via WDA
                const wdaUrl = process.env.WDA_URL ?? 'http://127.0.0.1:8100';
                const data = await readFile(videoPath);
                if (data.length > 350 * 1024 * 1024) {
                    return reply.code(413).send({ error: 'Video is too large for import (max 350MB)' });
                }
                const importResponse = await fetch(`${wdaUrl}/wda/import-media`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        name: `gen-${generationId.slice(0, 8)}.mp4`,
                        mimeType: 'video/mp4',
                        data: data.toString('base64'),
                    }),
                });
                const importResult = await importResponse.json() as { value?: { error?: unknown } };
                if (!importResponse.ok || (importResult.value && typeof importResult.value === 'object' && 'error' in importResult.value)) {
                    return reply.code(502).send({ error: `WDA media import failed: ${JSON.stringify(importResult)}` });
                }
                console.log(`Imported generation ${generationId} video to device ${udid}`);

                // If caption provided, patch the first type_keys step in the workflow
                // (the rest type_keys steps are for other purposes like hashtag spacing)
                if (caption?.trim()) {
                    const typeKeySteps = await db.select({ id: workflowSteps.id, label: workflowSteps.label, stepOrder: workflowSteps.stepOrder })
                        .from(workflowSteps)
                        .where(
                            and(
                                eq(workflowSteps.workflowId, workflowId),
                                eq(workflowSteps.stepType, 'type_keys'),
                            )
                        )
                        .orderBy(asc(workflowSteps.stepOrder));
                    // Only patch the FIRST type_keys step (the main caption entry)
                    // to avoid typing the caption into auxiliary type_keys steps
                    if (typeKeySteps.length > 0) {
                        await db.update(workflowSteps).set({ text: caption.trim() })
                            .where(eq(workflowSteps.id, typeKeySteps[0]!.id));
                    }
                }

                // Ensure workflow has the device UDID
                if (!wf.deviceUdid || wf.deviceUdid !== udid) {
                    await db.update(workflows).set({ deviceUdid: udid, updatedAt: new Date() })
                        .where(eq(workflows.id, workflowId));
                }

                // Get all steps
                const steps = await db.select().from(workflowSteps)
                    .where(eq(workflowSteps.workflowId, workflowId))
                    .orderBy(asc(workflowSteps.stepOrder));
                if (steps.length === 0) return reply.code(409).send({ error: 'Workflow has no steps' });

                // Update generation status
                await db.update(generations).set({ status: 'queued', deviceUdid: udid })
                    .where(eq(generations.id, generationId));

                // Start replay, then reset the type_keys text so captions don't accumulate
                const runId = startReplayEntry(workflowId, wf.name, udid, steps.length, db);
                const abortController = new AbortController();
                runSteps(context.remote, udid, steps, abortController.signal, runId, db)
                    .catch(() => {
                        finishReplay(runId, 'failed', 'Unexpected error during replay', db);
                    })
                    .finally(() => {
                        // Reset type_keys text so each queue starts fresh
                        db.update(workflowSteps).set({ text: null })
                            .where(and(
                                eq(workflowSteps.workflowId, workflowId),
                                eq(workflowSteps.stepType, 'type_keys'),
                            )).catch(() => {});
                    });

                return reply.code(202).send({
                    ok: true,
                    message: `Imported video to device and started workflow replay`,
                    runId,
                    status: 'running',
                    totalSteps: steps.length,
                });
            });

            // --- Historical workflow runs ---

            app.get('/api/workflow-runs', async (request) => {
                const query = request.query as { limit?: string; offset?: string; workflowId?: string };
                const limit = Math.min(Number(query.limit ?? 50), 200);
                const offset = Number(query.offset ?? 0);

                let rows;
                let total: number;

                if (query.workflowId) {
                    rows = await db.select().from(workflowRuns)
                        .where(eq(workflowRuns.workflowId, query.workflowId))
                        .orderBy(desc(workflowRuns.startedAt)).limit(limit).offset(offset);
                    const [tot] = await db.select({ count: count() }).from(workflowRuns)
                        .where(eq(workflowRuns.workflowId, query.workflowId));
                    total = Number(tot?.count ?? 0);
                } else {
                    rows = await db.select().from(workflowRuns)
                        .orderBy(desc(workflowRuns.startedAt)).limit(limit).offset(offset);
                    const [tot] = await db.select({ count: count() }).from(workflowRuns);
                    total = Number(tot?.count ?? 0);
                }

                // Enrich with workflow names
                const enriched = await Promise.all(rows.map(async (run) => {
                    const [wf] = await db.select({ name: workflows.name })
                        .from(workflows).where(eq(workflows.id, run.workflowId));
                    return {
                        ...run,
                        startedAt: run.startedAt?.toISOString?.() ?? run.startedAt,
                        finishedAt: run.finishedAt?.toISOString?.() ?? run.finishedAt,
                        workflowName: wf?.name ?? 'Unknown',
                    };
                }));

                return { runs: enriched, total };
            });

            // Get a single workflow run
            app.get<{ Params: { runId: string } }>('/api/workflow-runs/:runId', async (request, reply) => {
                const [run] = await db.select().from(workflowRuns)
                    .where(eq(workflowRuns.id, request.params.runId));
                if (!run) return reply.code(404).send({ error: 'Workflow run not found' });

                const [wf] = await db.select({ name: workflows.name })
                    .from(workflows).where(eq(workflows.id, run.workflowId));

                return {
                    ...run,
                    startedAt: run.startedAt?.toISOString?.() ?? run.startedAt,
                    finishedAt: run.finishedAt?.toISOString?.() ?? run.finishedAt,
                    workflowName: wf?.name ?? 'Unknown',
                };
            });

            // --- Page routes are registered in main app ---
        },
    };
}
