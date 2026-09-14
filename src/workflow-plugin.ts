import crypto from 'node:crypto';
import { eq, asc, and, desc, count } from 'drizzle-orm';
import { remote, type Browser } from 'webdriverio';

import { workflows, workflowSteps, generations, workflowRuns, localDrafts, bookmarks } from './database/schema.js';
import { screenshotToJpeg } from './tiktok/vision-guide.js';
import { tiktokAppiumCapabilities } from './tiktok/appium-session.js';
import type { PhoneFarmPlugin, PluginRouteContext } from './plugin.js';
import type { WorkflowStatus, WorkflowStepType, WorkflowStep } from './types.js';
import { switchTikTokAccount, type AccountSwitchCoords } from './tiktok/actions.js';
import { foregroundTikTok } from './tiktok/appium-session.js';
import { resolveDeviceCoordinates } from './devices/coordinates.js';
import { coordinateProfile } from './tiktok/runtime-settings.js';

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

/**
 * Per-device FIFO queue that processes one async task at a time.
 * Each device gets its own queue so workflows on different devices run
 * concurrently, but workflows targeting the same device are serialized.
 */
class PerDeviceWorkflowQueue {
    private readonly queues = new Map<string, Array<{ task: () => Promise<void>; resolve: () => void; reject: (err: unknown) => void }>>();
    private readonly running = new Set<string>();

    enqueue(deviceUdid: string, task: () => Promise<void>): Promise<void> {
        return new Promise((resolve, reject) => {
            let q = this.queues.get(deviceUdid);
            if (!q) {
                q = [];
                this.queues.set(deviceUdid, q);
            }
            q.push({ task, resolve, reject });
            this.processNext(deviceUdid);
        });
    }

    private async processNext(deviceUdid: string): Promise<void> {
        const q = this.queues.get(deviceUdid);
        if (!q || this.running.has(deviceUdid) || q.length === 0) return;
        this.running.add(deviceUdid);

        const entry = q.shift()!;
        try {
            await entry.task();
            entry.resolve();
        } catch (error) {
            entry.reject(error);
        } finally {
            this.running.delete(deviceUdid);
            // Clean up empty queues
            if (q.length === 0) {
                this.queues.delete(deviceUdid);
            }
            this.processNext(deviceUdid);
        }
    }
}

const workflowQueue = new PerDeviceWorkflowQueue();

function startReplayEntry(workflowId: string, workflowName: string, deviceUdid: string, totalSteps: number, db?: any, metadata?: Record<string, unknown>): string {
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
            metadata: metadata ?? {},
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

    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const payload = {
                model,
                thinking: { type: 'disabled' },
                response_format: { type: 'json_object' },
                messages: [
                    {
                        role: 'system',
                        content: 'You answer YES or NO to a question based on the current screenshot of an iPhone. Respond with ONLY a valid JSON object — no markdown, no backticks, no extra text: {"answer": "yes"|"no", "reason": "short explanation"}. NEVER include trailing commas, and always double-quote all keys and string values.',
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

            let parsed: { answer?: string; reason?: string };
            try {
                parsed = JSON.parse(json) as { answer?: string; reason?: string };
            } catch {
                // Attempt to fix common JSON issues: trailing commas, single quotes, unquoted keys
                const cleaned = json
                    .replace(/,(\s*[}\]])/g, '$1')     // remove trailing commas before } or ]
                    .replace(/'/g, '"')                 // single quotes → double quotes
                    .replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3'); // unquoted keys → quoted keys
                parsed = JSON.parse(cleaned) as { answer?: string; reason?: string };
            }

            const answer = String(parsed.answer ?? '').trim().toLowerCase();
            if (answer !== 'yes' && answer !== 'no') {
                throw new Error(`AI returned unexpected answer: ${answer} (expected yes or no)`);
            }

            return { answer: answer === 'yes', reason: parsed.reason ?? 'No reason given' };
        } catch (error) {
            if (attempt < MAX_ATTEMPTS) {
                await new Promise((r) => setTimeout(r, 1000));
            } else {
                throw error;
            }
        }
    }

    throw new Error('AI condition evaluation failed after all attempts');
}

async function runSteps(
    remote: PluginRouteContext['remote'],
    deviceUdid: string,
    steps: any[],
    signal: AbortSignal,
    runId: string,
    db?: any,
): Promise<void> {
    // Per-step timeout — no single operation should hang for longer than this
    const STEP_TIMEOUT_MS = 20_000; // 20 seconds
    // Global timeout — entire replay must finish within this window
    const GLOBAL_TIMEOUT_MS = 300_000; // 5 minutes

    // Track whether the run has already been finished (prevents double-finish)
    let finished = false;
    function finishOnce(status: 'succeeded' | 'failed' | 'stopped', error?: string) {
        if (finished) return;
        finished = true;
        finishReplay(runId, status, error, db);
    }

    // Global timeout guard
    const globalTimer = setTimeout(() => {
        const msg = 'Global timeout after 15 minutes';
        updateReplayLog(runId, 0, msg, 'error');
        finishOnce('failed', msg);
    }, GLOBAL_TIMEOUT_MS);

    try {
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            if (signal.aborted) {
                updateReplayLog(runId, step.stepOrder, 'Replay stopped by user', 'info');
                finishOnce('stopped', 'Stopped by user');
                return;
            }
            // Bail early if another step already triggered a global timeout
            if (finished) return;

            try {
                // Race the step execution against a per-step timeout
                await Promise.race([
                    (async () => {
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
                            case 'import_video': {
                                if (!step.text) throw new Error('import_video step missing video path (text field)');
                                const wdaUrl = process.env.WDA_URL ?? 'http://127.0.0.1:8100';
                                const { readFile } = await import('node:fs/promises');
                                const pathModule = await import('node:path');
                                const videoPath = pathModule.resolve(step.text);
                                const data = await readFile(videoPath);
                                if (data.length > 350 * 1024 * 1024) {
                                    throw new Error(`Video is too large for import (max 350MB)`);
                                }
                                const importResponse = await fetch(`${wdaUrl}/wda/import-media`, {
                                    method: 'POST',
                                    headers: { 'content-type': 'application/json' },
                                    body: JSON.stringify({
                                        name: `import-${Date.now()}.mp4`,
                                        mimeType: 'video/mp4',
                                        data: data.toString('base64'),
                                    }),
                                });
                                const importResult = await importResponse.json() as { value?: { error?: unknown } };
                                if (!importResponse.ok || (importResult.value && typeof importResult.value === 'object' && 'error' in importResult.value)) {
                                    throw new Error(`WDA media import failed: ${JSON.stringify(importResult)}`);
                                }
                                updateReplayLog(runId, step.stepOrder, `Imported video to device${step.label ? ` — ${step.label}` : ''}`, 'info');
                                break;
                            }
                            case 'open_url': {
                                if (!step.url) throw new Error('open_url step missing url');
                                await remote.performAction(deviceUdid, { type: 'home' });
                                await new Promise((r) => setTimeout(r, 1000));
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
                                    if (answer) {
                                        i += step.skipSteps;
                                        updateReplayLog(runId, step.stepOrder, `Condition met, skipping ${step.skipSteps} step(s)`, 'info');
                                    } else {
                                        updateReplayLog(runId, step.stepOrder, `Condition not met, continuing (skipping not triggered)`, 'info');
                                    }
                                } else {
                                    if (!answer) {
                                        updateReplayLog(runId, step.stepOrder, `Condition not met, stopping replay`, 'info');
                                        finishOnce('stopped', `AI condition "${step.aiQuestion}" evaluated as NO: ${reason}`);
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
                            case 'switch_account': {
                                if (!step.text) {
                                    updateReplayLog(runId, step.stepOrder, `Skipping switch_account (no account handle)${step.label ? ` — ${step.label}` : ''}`, 'info');
                                    break;
                                }
                                const targetAccount = step.text;
                                const tiktokBundleId = process.env.TIKTOK_BUNDLE_ID ?? 'com.zhiliaoapp.musically';
                                // Unlock device first
                                await remote.performAction(deviceUdid, { type: 'unlock' });
                                await new Promise((r) => setTimeout(r, 2000));
                                const switchDriver = await appiumSession(deviceUdid, tiktokBundleId);
                                try {
                                    await foregroundTikTok(switchDriver, tiktokBundleId);
                                    await new Promise((r) => setTimeout(r, 3000));
                                    const accountCoords: AccountSwitchCoords = {
                                        profileTabX: step.endX ?? 190,
                                        profileTabY: step.endY ?? 120,
                                        switcherTriggerX: step.x ?? 210,
                                        switcherTriggerY: step.y ?? 121,
                                    };
                                    await switchTikTokAccount(switchDriver, remote as any, deviceUdid, targetAccount, accountCoords);
                                } finally {
                                    await switchDriver.deleteSession().catch(() => {});
                                }
                                updateReplayLog(runId, step.stepOrder, `Switched to TikTok account "${targetAccount}"`, 'info');
                                break;
                            }
                            default: {
                                updateReplayLog(runId, step.stepOrder, `Unknown step type: ${step.stepType}`, 'error');
                            }
                        }
                    })(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error(`Step ${step.stepOrder} timed out after ${STEP_TIMEOUT_MS / 1000}s`)), STEP_TIMEOUT_MS)
                    ),
                ]);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                updateReplayLog(runId, step.stepOrder, `Error: ${message}`, 'error');
                finishOnce('failed', message);
                return;
            }
        }

        if (!finished) {
            finishOnce('succeeded');
        }
    } finally {
        clearTimeout(globalTimer);
    }
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

                // Enqueue via per-device queue so multiple replays don't run simultaneously on the same device
                workflowQueue.enqueue(wf.deviceUdid, async () => {
                    const abortController = new AbortController();
                    await runSteps(context.remote, wf.deviceUdid, steps, abortController.signal, runId, db);
                }).catch((error) => {
                    console.error(`[replay ${runId}] Unexpected error:`, error);
                    finishReplay(runId, 'failed', error instanceof Error ? error.message : 'Unexpected error during replay', db);
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
                const { readdir } = await import('node:fs/promises');
                const pathModule = await import('node:path');
                const VIDEO_OUTPUT = 'post.mp4';
                const produced = await readdir(gen.outputDir);
                const videoFile = produced.find((name) => name === VIDEO_OUTPUT);
                if (!videoFile) return reply.code(409).send({ error: 'Generation produced no video file' });
                const videoPath = pathModule.resolve(pathModule.join(gen.outputDir, videoFile));

                // Update generation status
                await db.update(generations).set({ status: 'queued', deviceUdid: udid })
                    .where(eq(generations.id, generationId));

                // Enqueue via WorkflowQueue for sequential execution.
                // Step patching + fetching happens inside the task so concurrent
                // requests don't overwrite each other's patches.
                const runId = startReplayEntry(workflowId, wf.name, udid, 0, db, {
                    sourceId: generationId,
                    sourceType: 'generation',
                });

                workflowQueue.enqueue(udid, async () => {
                    // 1. Patch import_video step with this generation's video path
                    const importVideoSteps = await db.select({ id: workflowSteps.id, stepOrder: workflowSteps.stepOrder })
                        .from(workflowSteps)
                        .where(and(
                            eq(workflowSteps.workflowId, workflowId),
                            eq(workflowSteps.stepType, 'import_video'),
                        ))
                        .orderBy(asc(workflowSteps.stepOrder));
                    if (importVideoSteps.length > 0) {
                        await db.update(workflowSteps).set({ text: videoPath })
                            .where(eq(workflowSteps.id, importVideoSteps[0]!.id));
                    }

                    // 2. Patch first type_keys step with caption
                    if (caption?.trim()) {
                        const typeKeySteps = await db.select({ id: workflowSteps.id, label: workflowSteps.label, stepOrder: workflowSteps.stepOrder })
                            .from(workflowSteps)
                            .where(and(
                                eq(workflowSteps.workflowId, workflowId),
                                eq(workflowSteps.stepType, 'type_keys'),
                            ))
                            .orderBy(asc(workflowSteps.stepOrder));
                        if (typeKeySteps.length > 0) {
                            let captionText = caption.trim();
                            const words = captionText.split(/\s+/);
                            const lastWord = words[words.length - 1];
                            if (lastWord && lastWord.startsWith('#')) captionText += ' fyp';
                            await db.update(workflowSteps).set({ text: captionText })
                                .where(eq(workflowSteps.id, typeKeySteps[0]!.id));
                        }
                    }

                    // 3. Read steps (now patched)
                    const steps = await db.select().from(workflowSteps)
                        .where(eq(workflowSteps.workflowId, workflowId))
                        .orderBy(asc(workflowSteps.stepOrder));
                    if (steps.length === 0) throw new Error('Workflow has no steps');
                    const totalSteps = steps.length;

                    // 4. Update replay entry with actual step count
                    const replay = activeReplays.get(runId);
                    if (replay) replay.totalSteps = totalSteps;
                    if (db) {
                        db.update(workflowRuns).set({ totalSteps })
                            .where(eq(workflowRuns.id, runId)).catch(() => {});
                    }

                    // 5. Run the workflow
                    const abortController = new AbortController();
                    await runSteps(context.remote, udid, steps, abortController.signal, runId, db);
                }).catch(() => {
                    finishReplay(runId, 'failed', 'Unexpected error during replay', db);
                }).finally(() => {
                    // Reset type_keys and import_video text so each queue starts fresh
                    const resetText = () => db.update(workflowSteps).set({ text: null })
                        .where(and(
                            eq(workflowSteps.workflowId, workflowId),
                            eq(workflowSteps.stepType, 'type_keys'),
                        )).catch(() => {});
                    const resetImport = () => db.update(workflowSteps).set({ text: null })
                        .where(and(
                            eq(workflowSteps.workflowId, workflowId),
                            eq(workflowSteps.stepType, 'import_video'),
                        )).catch(() => {});
                    void Promise.all([resetText(), resetImport()]);
                });

                return reply.code(202).send({
                    ok: true,
                    message: 'Patched workflow with video path and started replay (import_video step will import during execution)',
                    runId,
                    status: 'running',
                    totalSteps: 0,
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

            // --- Local Drafts (lightweight video drafts, no ffmpeg until download/queue) ---

            app.post<{
                Params: { id: string };
                Body: {
                    hooks: Array<{ text: string; align?: string; caption?: string; galleryVideo?: string; trimStartSeconds?: number; trimEndSeconds?: number | null }>;
                    galleryName: string;
                    deviceUdid?: string;
                    account?: string;
                    hookRunId?: string;
                    targetSeconds?: number | null;
                };
            }>('/api/bookmarks/:id/local-drafts', async (request, reply) => {
                const { id } = request.params;
                const { hooks, galleryName, deviceUdid, account, hookRunId, targetSeconds } = request.body;
                if (!hooks?.length) return reply.code(400).send({ error: 'At least one hook is required' });
                if (!galleryName) return reply.code(400).send({ error: 'galleryName is required' });

                const [bookmark] = await db.select({ id: bookmarks.id }).from(bookmarks).where(eq(bookmarks.id, id));
                if (!bookmark) return reply.code(404).send({ error: 'Bookmark not found' });

                // Get gallery clips and their durations for auto-assignment
                const { listGalleryItems } = await import('./content/gallery.js');
                const allItems = await listGalleryItems(galleryName);
                const clips = allItems
                    .filter((item) => item.kind === 'video' && typeof item.durationSeconds === 'number' && item.durationSeconds >= 2)
                    .map((item) => ({ name: item.name, durationSeconds: item.durationSeconds as number }));

                if (clips.length === 0) {
                    return reply.code(400).send({ error: 'Gallery has no usable video clips (each must be at least 2 seconds)' });
                }

                const created = [];
                const usedRanges: Array<{ start: number; end: number }> = [];

                for (const hook of hooks) {
                    // 1. Pick a clip — use the one the user chose, or a random one that's not overly reused
                    let clip: { name: string; durationSeconds: number };
                    if (hook.galleryVideo && clips.find((c) => c.name === hook.galleryVideo)) {
                        clip = clips.find((c) => c.name === hook.galleryVideo)!;
                    } else {
                        clip = clips[Math.floor(Math.random() * clips.length)];
                    }

                    // 2. Auto-assign unique trim times for this draft
                    let trimStart = 0;
                    let trimEnd: number | null = null;

                    const fixedDuration = targetSeconds ?? null;

                    if (fixedDuration != null && fixedDuration > 0) {
                        // Use the template's target duration as the exact clip length.
                        // Find a random start such that the full duration fits within the clip.
                        const maxStart = Math.max(0, clip.durationSeconds - fixedDuration);
                        if (maxStart > 0) {
                            // Try to find a non-overlapping window
                            let attempts = 0;
                            while (attempts < 30) {
                                const startCandidate = Math.round(Math.random() * maxStart * 10) / 10;
                                const endCandidate = Math.round((startCandidate + fixedDuration) * 10) / 10;
                                const overlaps = usedRanges.some((r) =>
                                    !(endCandidate <= r.start + 0.5 || startCandidate >= r.end - 0.5)
                                );
                                if (!overlaps || attempts >= 20) {
                                    trimStart = startCandidate;
                                    trimEnd = endCandidate;
                                    usedRanges.push({ start: trimStart, end: trimEnd });
                                    break;
                                }
                                attempts++;
                            }
                        } else {
                            // Clip is too short for the full target duration — just use the whole clip
                            trimStart = 0;
                            trimEnd = clip.durationSeconds;
                        }
                    } else {
                        // No target duration — fall back to random 5-15s window
                        const minDuration = Math.min(5, clip.durationSeconds - 1);
                        const maxDuration = Math.min(15, clip.durationSeconds);
                        let attempts = 0;
                        while (attempts < 30) {
                            const startCandidate = Math.max(0, Math.floor(Math.random() * (clip.durationSeconds - minDuration)));
                            const maxEnd = Math.min(clip.durationSeconds, startCandidate + maxDuration);
                            const duration = minDuration + Math.random() * (maxEnd - startCandidate - minDuration);
                            const endCandidate = Math.min(clip.durationSeconds, startCandidate + duration);
                            const overlaps = usedRanges.some((r) =>
                                !(endCandidate <= r.start + 0.5 || startCandidate >= r.end - 0.5)
                            );
                            if (!overlaps || attempts >= 20) {
                                trimStart = startCandidate;
                                trimEnd = Math.round(endCandidate * 10) / 10;
                                usedRanges.push({ start: trimStart, end: trimEnd });
                                break;
                            }
                            attempts++;
                        }
                    }

                    const durationSeconds = fixedDuration != null ? fixedDuration
                        : (trimEnd != null ? Math.round((trimEnd - trimStart) * 10) / 10 : null);

                    const [row] = await db.insert(localDrafts).values({
                        bookmarkId: id,
                        hookRunId: hookRunId ?? null,
                        galleryName,
                        galleryVideo: clip.name,
                        trimStartSeconds: trimStart,
                        trimEndSeconds: trimEnd,
                        durationSeconds: durationSeconds != null && durationSeconds > 0 ? durationSeconds : null,
                        hook: hook.text,
                        hookAlign: (hook.align as 'left' | 'center' | 'right') ?? 'left',
                        caption: hook.caption ?? '',
                        deviceUdid: deviceUdid ?? null,
                        account: account ?? null,
                    }).returning();
                    if (row) created.push(row);
                }
                return reply.code(201).send({ drafts: created });
            });

            app.get<{ Params: { id: string } }>('/api/bookmarks/:id/local-drafts', async (request, reply) => {
                const rows = await db.select().from(localDrafts)
                    .where(eq(localDrafts.bookmarkId, request.params.id))
                    .orderBy(desc(localDrafts.createdAt));
                return { drafts: rows };
            });

            app.get<{ Params: { id: string } }>('/api/local-drafts/:id', async (request, reply) => {
                const [row] = await db.select().from(localDrafts).where(eq(localDrafts.id, request.params.id));
                if (!row) return reply.code(404).send({ error: 'Local draft not found' });
                return row;
            });

            app.patch<{
                Params: { id: string };
                Body: {
                    hook?: string;
                    hookAlign?: string;
                    caption?: string;
                    galleryVideo?: string;
                    trimStartSeconds?: number;
                    trimEndSeconds?: number | null;
                    deviceUdid?: string;
                    account?: string;
                    status?: string;
                };
            }>('/api/local-drafts/:id', async (request, reply) => {
                const updates: Record<string, unknown> = {};
                if (request.body.hook !== undefined) updates.hook = request.body.hook;
                if (request.body.hookAlign !== undefined) updates.hookAlign = request.body.hookAlign;
                if (request.body.caption !== undefined) updates.caption = request.body.caption;
                if (request.body.galleryVideo !== undefined) updates.galleryVideo = request.body.galleryVideo;
                if (request.body.trimStartSeconds !== undefined) updates.trimStartSeconds = request.body.trimStartSeconds;
                if (request.body.trimEndSeconds !== undefined) updates.trimEndSeconds = request.body.trimEndSeconds ?? null;
                if (request.body.deviceUdid !== undefined) updates.deviceUdid = request.body.deviceUdid ?? null;
                if (request.body.account !== undefined) updates.account = request.body.account ?? null;
                if (request.body.status !== undefined) updates.status = request.body.status;
                updates.updatedAt = new Date();

                // Recalculate duration if trim changed
                if (request.body.trimStartSeconds !== undefined || request.body.trimEndSeconds !== undefined) {
                    const [current] = await db.select({
                        trimStartSeconds: localDrafts.trimStartSeconds,
                        trimEndSeconds: localDrafts.trimEndSeconds,
                    }).from(localDrafts).where(eq(localDrafts.id, request.params.id));
                    if (current) {
                        const start = request.body.trimStartSeconds ?? current.trimStartSeconds;
                        const end = request.body.trimEndSeconds !== undefined ? request.body.trimEndSeconds : current.trimEndSeconds;
                        if (end != null) {
                            const duration = end - start;
                            updates.durationSeconds = duration > 0 ? duration : null;
                        } else {
                            updates.durationSeconds = null;
                        }
                    }
                }

                const [row] = await db.update(localDrafts).set(updates)
                    .where(eq(localDrafts.id, request.params.id)).returning();
                if (!row) return reply.code(404).send({ error: 'Local draft not found' });
                return row;
            });

            app.delete<{ Params: { id: string } }>('/api/local-drafts/:id', async (request, reply) => {
                await db.delete(localDrafts).where(eq(localDrafts.id, request.params.id));
                return reply.code(204).send();
            });

            // Download a local draft — renders the actual video via ffmpeg
            app.post<{ Params: { id: string } }>('/api/local-drafts/:id/download', async (request, reply) => {
                const [draft] = await db.select().from(localDrafts).where(eq(localDrafts.id, request.params.id));
                if (!draft) return reply.code(404).send({ error: 'Local draft not found' });
                if (!draft.galleryVideo) return reply.code(400).send({ error: 'Draft has no gallery video assigned' });

                try {
                    const { resolveGalleryFile } = await import('./content/gallery.js');
                    const { compositeVideo } = await import('./content/composite.js');
                    const { mkdtemp, readFile } = await import('node:fs/promises');
                    const pathModule = await import('node:path');
                    const os = await import('node:os');

                    const clipPath = resolveGalleryFile(draft.galleryName, draft.galleryVideo);
                    const outputDir = await mkdtemp(pathModule.join(os.tmpdir(), 'draft-render-'));
                    const outputPath = pathModule.join(outputDir, 'post.mp4');

                    const trimEnd = draft.trimEndSeconds ?? undefined;
                    const duration = trimEnd != null
                        ? trimEnd - draft.trimStartSeconds
                        : undefined;

                    await compositeVideo({
                        clipPath,
                        trimStartSeconds: draft.trimStartSeconds,
                        durationSeconds: duration ?? 5, // default 5s if no duration set
                        hook: draft.hook,
                        hookAlign: draft.hookAlign as 'left' | 'center' | 'right',
                        outputPath,
                    });

                    const videoBuffer = await readFile(outputPath);
                    await import('node:fs/promises').then((f) => f.rm(outputDir, { recursive: true, force: true }));

                    return reply
                        .type('video/mp4')
                        .header('content-disposition', `attachment; filename="draft-${draft.id.slice(0, 8)}.mp4"`)
                        .send(videoBuffer);
                } catch (error) {
                    return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
                }
            });

            // Queue a local draft via workflow
            app.post<{ Params: { id: string }; Body: { workflowId: string } }>('/api/local-drafts/:id/queue-via-workflow', async (request, reply) => {
                const [draft] = await db.select().from(localDrafts).where(eq(localDrafts.id, request.params.id));
                if (!draft) return reply.code(404).send({ error: 'Local draft not found' });
                const { workflowId } = request.body;
                if (!workflowId) return reply.code(400).send({ error: 'workflowId is required' });

                const [wf] = await db.select().from(workflows).where(eq(workflows.id, workflowId));
                if (!wf) return reply.code(404).send({ error: 'Workflow not found' });

                const udid = draft.deviceUdid ?? wf.deviceUdid;
                if (!udid) return reply.code(400).send({ error: 'No device assigned to this draft or workflow' });

                // Render the trimmed video with hook overlay first
                const { compositeVideo } = await import('./content/composite.js');
                const { resolveGalleryFile } = await import('./content/gallery.js');
                const { mkdtemp } = await import('node:fs/promises');
                const pathModule = await import('node:path');
                const os = await import('node:os');
                const outputDir = await mkdtemp(pathModule.join(os.tmpdir(), 'draft-queue-'));
                const renderedPath = pathModule.join(outputDir, 'post.mp4');
                const clipPath = resolveGalleryFile(draft.galleryName, draft.galleryVideo);
                await compositeVideo({
                    clipPath,
                    trimStartSeconds: draft.trimStartSeconds,
                    durationSeconds: draft.durationSeconds ?? 5,
                    hook: draft.hook,
                    hookAlign: draft.hookAlign as 'left' | 'center' | 'right',
                    outputPath: renderedPath,
                });

                // Update draft status
                await db.update(localDrafts).set({ status: 'queued', updatedAt: new Date() })
                    .where(eq(localDrafts.id, draft.id));

                // Enqueue via WorkflowQueue for sequential execution.
                // Step patching + fetching happens inside the task so concurrent
                // requests don't overwrite each other's patches.
                const runId = startReplayEntry(workflowId, wf.name, udid, 0, db, {
                    sourceId: draft.id,
                    sourceType: 'draft',
                });

                workflowQueue.enqueue(udid, async () => {
                    // 1. Patch the import_video step with the rendered video path
                    const importVideoSteps = await db.select({ id: workflowSteps.id, stepOrder: workflowSteps.stepOrder })
                        .from(workflowSteps)
                        .where(and(
                            eq(workflowSteps.workflowId, workflowId),
                            eq(workflowSteps.stepType, 'import_video'),
                        ))
                        .orderBy(asc(workflowSteps.stepOrder));
                    if (importVideoSteps.length > 0) {
                        await db.update(workflowSteps).set({ text: renderedPath })
                            .where(eq(workflowSteps.id, importVideoSteps[0]!.id));
                    } else {
                        console.error(`[draft-queue ${runId}] No import_video step found`);
                    }

                    // 2. Patch first type_keys step with caption
                    if (draft.caption?.trim()) {
                        const typeKeySteps = await db.select({ id: workflowSteps.id, stepOrder: workflowSteps.stepOrder })
                            .from(workflowSteps)
                            .where(and(
                                eq(workflowSteps.workflowId, workflowId),
                                eq(workflowSteps.stepType, 'type_keys'),
                            ))
                            .orderBy(asc(workflowSteps.stepOrder));
                        if (typeKeySteps.length > 0) {
                            let captionText = draft.caption.trim();
                            const words = captionText.split(/\s+/);
                            const lastWord = words[words.length - 1];
                            if (lastWord && lastWord.startsWith('#')) captionText += ' fyp';
                            await db.update(workflowSteps).set({ text: captionText })
                                .where(eq(workflowSteps.id, typeKeySteps[0]!.id));
                        }
                    }

                    // 3. Ensure workflow has the device UDID
                    if (!wf.deviceUdid || wf.deviceUdid !== udid) {
                        await db.update(workflows).set({ deviceUdid: udid, updatedAt: new Date() })
                            .where(eq(workflows.id, workflowId));
                    }

                    // 4. Read steps (now patched with this task's values)
                    const steps = await db.select().from(workflowSteps)
                        .where(eq(workflowSteps.workflowId, workflowId))
                        .orderBy(asc(workflowSteps.stepOrder));
                    if (steps.length === 0) throw new Error('Workflow has no steps');
                    const totalSteps = steps.length;

                    // 5. Update replay entry with actual step count
                    const replay = activeReplays.get(runId);
                    if (replay) replay.totalSteps = totalSteps;
                    if (db) {
                        db.update(workflowRuns).set({ totalSteps })
                            .where(eq(workflowRuns.id, runId)).catch(() => {});
                    }

                    // 6. Run the workflow
                    const abortController = new AbortController();
                    await runSteps(context.remote, udid, steps, abortController.signal, runId, db);
                }).catch((error) => {
                    console.error(`[draft-queue ${runId}] Task error:`, error);
                    finishReplay(runId, 'failed', error instanceof Error ? error.message : 'Unexpected error during replay', db);
                }).finally(() => {
                    // Clean up rendered temp video after workflow completes
                    void import('node:fs/promises').then((f) => f.rm(outputDir, { recursive: true, force: true }).catch(() => {}));
                });

                return reply.code(202).send({
                    ok: true,
                    message: 'Local draft queued via workflow',
                    runId,
                    status: 'running',
                    totalSteps: 0,
                });
            });

            // Save a local draft — render the trimmed video with hook overlay and store it
            app.post<{ Params: { id: string } }>('/api/local-drafts/:id/save', async (request, reply) => {
                const [draft] = await db.select().from(localDrafts).where(eq(localDrafts.id, request.params.id));
                if (!draft) return reply.code(404).send({ error: 'Local draft not found' });

                // Render trimmed video with hook overlay
                try {
                    const { compositeVideo } = await import('./content/composite.js');
                    const { resolveGalleryFile } = await import('./content/gallery.js');
                    const { mkdir } = await import('node:fs/promises');
                    const pathModule = await import('node:path');
                    const dataRoot = process.env.SCHEDULER_DATA_DIR ?? '.scheduler-data';
                    const draftDir = pathModule.join(dataRoot, 'drafts', draft.id);
                    await mkdir(draftDir, { recursive: true });
                    const outputPath = pathModule.join(draftDir, 'post.mp4');
                    const clipPath = resolveGalleryFile(draft.galleryName, draft.galleryVideo);
                    await compositeVideo({
                        clipPath,
                        trimStartSeconds: draft.trimStartSeconds,
                        durationSeconds: draft.durationSeconds ?? 5,
                        hook: draft.hook,
                        hookAlign: draft.hookAlign as 'left' | 'center' | 'right',
                        outputPath,
                    });
                } catch (error) {
                    // Render failed — still mark as saved but include the error
                    console.error(`Failed to render video for draft ${draft.id}:`, error);
                }

                // Mark as saved regardless of render success
                const [row] = await db.update(localDrafts).set({ status: 'saved', updatedAt: new Date() })
                    .where(eq(localDrafts.id, request.params.id)).returning();
                if (!row) return reply.code(404).send({ error: 'Local draft not found' });
                return row;
            });

            // --- Page routes are registered in main app ---
        },
    };
}
