import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { loadRegisteredDevices } from '../src/devices/registry.js';

const REPO = path.resolve(import.meta.dirname, '..');
const DASHBOARD = process.env.PHONE_FARM_URL ?? 'http://127.0.0.1:3000';
const REMOTE_ACTION = (udid: string) => `${DASHBOARD}/api/devices/${encodeURIComponent(udid)}/remote/action`;
const REMOTE_INFO = (udid: string) => `${DASHBOARD}/api/devices/${encodeURIComponent(udid)}/remote/info`;
const WF_API = `${DASHBOARD}/api/workflows`;
const WF_REPLAY_API = `${DASHBOARD}/api/workflows/replay`;

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
            if ((value.startsWith('"') && value.endsWith('"'))
                || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            if (process.env[key] === undefined) process.env[key] = value;
        }
    }
}

async function reachable(url: string): Promise<boolean> {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
        return response.ok;
    } catch {
        return false;
    }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
    const response = await fetch(url, { ...options, headers: { origin: DASHBOARD, ...options?.headers } });
    const body = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
    return body;
}

interface WorkflowEntry {
    id: string;
    name: string;
    status: string;
    deviceUdid: string | null;
}

interface WorkflowWithSteps extends WorkflowEntry {
    steps: Array<{
        id: string;
        stepOrder: number;
        stepType: string;
        x: number | null;
        y: number | null;
        waitMs: number | null;
        aiQuestion: string | null;
        label: string | null;
    }>;
}

interface ActiveReplay {
    workflowId: string;
    workflowName: string;
    deviceUdid: string;
    status: 'running' | 'succeeded' | 'failed' | 'stopped';
    currentStep: number;
    totalSteps: number;
    logs: Array<{ step: number; message: string; type: 'info' | 'error' | 'condition' }>;
    error?: string;
}

test('creates a workflow, replays on the real phone, and verifies end-to-end pipeline', { timeout: 120_000 }, async (t) => {
    await loadLocalEnv();

    // ---- Prerequisite: phone and infrastructure ----
    const devices = (await loadRegisteredDevices()).filter((d) => !d.disabled);
    const device = devices.find((entry) => entry.udid === process.env.IOS_UDID) ?? devices[0];
    if (!device) {
        t.skip('No registered iPhone');
        return;
    }
    const udid = device.udid;

    if (!await reachable(`${DASHBOARD}/health`)) {
        t.skip('Farm dashboard is not running at ' + DASHBOARD);
        return;
    }

    const wdaUrl = `http://127.0.0.1:${device.wdaLocalPort ?? 8100}/status`;
    if (!await reachable(wdaUrl)) {
        t.skip('WebDriverAgent is not reachable for this device');
        return;
    }

    console.log(`Testing with device: ${device.name ?? udid}`);
    console.log(`  Coordinate profile: ${device.coordinateProfile}`);
    console.log(`  WDA port: ${device.wdaLocalPort ?? 8100}`);

    // ---- Step 1: Verify device is responsive via remote API ----
    const info = await request<{ device: object; screen: object }>(REMOTE_INFO(udid));
    assert.ok(info.device, 'Should get device info from remote endpoint');
    assert.ok(info.screen, 'Should get screen info');
    console.log(`  Screen: ${JSON.stringify((info.screen as { screenSize?: { width: number; height: number } }).screenSize)}`);

    // ---- Step 2a: Try unlocking the phone directly ----
    // This tests the remote unlock action works even before creating a workflow
    let phoneUnlocked = false;
    try {
        await request<{ ok: boolean }>(REMOTE_ACTION(udid), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'unlock' }),
        });
        phoneUnlocked = true;
        console.log('  ✅ Phone unlocked successfully');
    } catch (error) {
        console.log(`  ⚠️  Could not unlock phone: ${error instanceof Error ? error.message : error}`);
        console.log('  Will use steps that work on a locked phone (screenshot only)');
    }

    // ---- Step 2b: Take a test screenshot to verify WDA screenshot works ----
    let screenshotWorks = false;
    try {
        const screenshotResp = await fetch(`${DASHBOARD}/api/devices/${encodeURIComponent(udid)}/remote/screenshot`);
        if (screenshotResp.ok) {
            const buf = Buffer.from(await screenshotResp.arrayBuffer());
            screenshotWorks = buf.length > 100;
            console.log(`  ✅ Screenshot works (${buf.length} bytes)`);
        }
    } catch {
        console.log('  ⚠️  Screenshot endpoint not reachable (expected if phone is locked)');
    }

    // ---- Step 3: Create workflow ----
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const workflowName = `test-wf-${stamp}`;
    console.log(`\nCreating workflow "${workflowName}"`);

    const wf = await request<WorkflowEntry>(WF_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: workflowName, deviceUdid: udid }),
    });
    assert.ok(wf.id, 'workflow should have an id');
    assert.equal(wf.name, workflowName);
    assert.equal(wf.deviceUdid, udid);
    assert.equal(wf.status, 'draft');
    console.log(`  ✅ Created workflow ${wf.id}`);

    // ---- Step 4: Add steps ----
    // Build a workflow that tests multiple step types.
    // If phone is unlocked, include home/unlock/interaction steps.
    // If locked, use purely passive steps (wait + screenshot).

    if (phoneUnlocked) {
        // Unlock step (safe even if already unlocked — wda-remote's needsUnlock check short-circuits)
        const stepUnlock = await request<{ id: string }>(`${WF_API}/${wf.id}/steps`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ stepType: 'unlock', label: 'Unlock device' }),
        });
        assert.ok(stepUnlock.id);

        // Home to ensure on SpringBoard
        const stepHome = await request<{ id: string }>(`${WF_API}/${wf.id}/steps`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ stepType: 'home', label: 'Go to home screen' }),
        });
        assert.ok(stepHome.id);
    }

    // Wait step (always works — pure sleep)
    const stepWait = await request<{ id: string }>(`${WF_API}/${wf.id}/steps`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stepType: 'wait', waitMs: 1000, label: 'Wait 1s' }),
    });
    assert.ok(stepWait.id);

    // Screenshot step (works even on locked phone via WDA)
    const stepScreenshot = await request<{ id: string }>(`${WF_API}/${wf.id}/steps`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stepType: 'screenshot', label: 'Capture screenshot' }),
    });
    assert.ok(stepScreenshot.id);

    // If OPENROUTER_API_KEY is set, add an AI condition step
    const hasAiKey = Boolean(process.env.OPENROUTER_API_KEY?.trim());
    if (hasAiKey) {
        console.log('  Adding AI condition step');
        const stepAi = await request<{ id: string }>(`${WF_API}/${wf.id}/steps`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                stepType: 'if_condition',
                aiQuestion: 'Is the screen on and showing any content?',
                label: 'AI check: is screen on?',
            }),
        });
        assert.ok(stepAi.id);
    }

    // Another wait step to pad
    const stepWait2 = await request<{ id: string }>(`${WF_API}/${wf.id}/steps`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stepType: 'wait', waitMs: 500, label: 'Wait 500ms' }),
    });
    assert.ok(stepWait2.id);

    // ---- Step 5: Verify steps ----
    const fullWf = await request<WorkflowWithSteps>(`${WF_API}/${wf.id}`);
    const baseStepCount = hasAiKey ? 4 : 3; // wait + screenshot + (+ ai) + wait
    const expectedSteps = phoneUnlocked ? baseStepCount + 2 : baseStepCount;
    assert.equal(fullWf.steps.length, expectedSteps, `should have ${expectedSteps} steps`);
    console.log(`  ✅ Workflow has ${fullWf.steps.length} steps: ${
        fullWf.steps.map((s) => s.stepType).join(' → ')
    }`);

    // ---- Step 6: Start replay ----
    console.log('\nStarting workflow replay...');
    const startResult = await request<{ runId: string; status: string; totalSteps: number; deviceUdid: string }>(
        `${WF_API}/${wf.id}/replay`, { method: 'POST' },
    );

    assert.equal(startResult.status, 'running');
    assert.equal(startResult.totalSteps, expectedSteps);
    assert.equal(startResult.deviceUdid, udid);
    assert.ok(startResult.runId);

    const runId = startResult.runId;
    console.log(`  Replay started: ${runId}`);

    // ---- Step 7: Poll replay until done ----
    const deadline = Date.now() + 60_000;
    let lastStatus: ActiveReplay | null = null;
    let pollCount = 0;

    // Use the WFS_REPLAY_API which is now correct
    while (Date.now() < deadline) {
        lastStatus = await request<ActiveReplay>(`${WF_REPLAY_API}/${runId}`);
        if (lastStatus.status !== 'running') break;

        pollCount += 1;
        if (pollCount % 5 === 0) {
            console.log(`  Progress: step ${lastStatus.currentStep}/${lastStatus.totalSteps}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
    }

    assert.ok(lastStatus, 'should have a final replay status');

    // ---- Step 8: Assert results ----
    const allLogs = lastStatus.logs.map((l) => `  [${l.type}] Step ${l.step}: ${l.message}`).join('\n');

    if (lastStatus.status === 'failed') {
        console.error('Replay logs:\n' + allLogs);
        console.error('Replay error:', lastStatus.error);
    }

    assert.equal(
        lastStatus.status,
        'succeeded',
        `Replay should succeed. Status: ${lastStatus.status}. Error: ${lastStatus.error ?? 'none'}.\nLogs:\n${allLogs}`,
    );

    assert.equal(lastStatus.currentStep, lastStatus.totalSteps, 'Should complete all steps');

    // Verify specific step types executed
    const logMessages = lastStatus.logs.map((l) => l.message);
    assert.ok(logMessages.some((m) => m.includes('Waited')), 'Should have a wait step');
    assert.ok(logMessages.some((m) => m.includes('Screenshot saved')), 'Should have taken a screenshot');

    if (phoneUnlocked) {
        assert.ok(logMessages.some((m) => m.includes('Unlocked')), 'Should have unlocked the device');
        assert.ok(logMessages.some((m) => m.includes('Home')), 'Should have pressed Home');
    }

    if (hasAiKey) {
        assert.ok(logMessages.some((m) => m.includes('AI condition')), 'Should have evaluated AI condition');
    }

    console.log(`  ✅ Replay completed: ${lastStatus.status} (${lastStatus.currentStep}/${lastStatus.totalSteps} steps)`);
    console.log(`  Bothered: ${pollCount} polls to reach completion`);

    // ---- Step 9: Verify replay status persisted properly ----
    const vfyReplay = await request<ActiveReplay>(`${WF_REPLAY_API}/${runId}`);
    assert.equal(vfyReplay.status, 'succeeded');
    assert.equal(vfyReplay.workflowId, wf.id);
    assert.equal(vfyReplay.deviceUdid, udid);

    // ---- Step 10: Check replays list ----
    const replaysList = await request<{ replays: Array<{ runId: string; status: string }> }>(`${WF_API}/replays`);
    assert.ok(replaysList.replays.length >= 1, 'Should have at least one replay in the list');
    assert.ok(replaysList.replays.some((r) => r.runId === runId), 'Our replay should appear in the list');

    // ---- Step 11: Cleanup ----
    console.log('\nCleaning up test workflow...');

    // Cleanup replay
    await fetch(`${WF_API}/replays/cleanup`, { method: 'POST' });

    // Delete workflow (cascade deletes steps)
    const delResp = await fetch(`${WF_API}/${wf.id}`, {
        method: 'DELETE',
        headers: { origin: DASHBOARD },
    });
    assert.equal(delResp.status, 204, `Delete should return 204, got ${delResp.status} ${delResp.statusText}`);

    // Verify gone
    await assert.rejects(
        () => request<WorkflowWithSteps>(`${WF_API}/${wf.id}`),
        /not found/,
        'Deleted workflow should 404',
    );
    console.log('  ✅ Cleanup complete');

    console.log(`\n🎉 Workflow phone integration test PASSED`);
});