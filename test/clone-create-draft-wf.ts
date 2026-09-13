import { readFile } from 'node:fs/promises';
import path from 'node:path';

async function loadLocalEnv() {
    const text = await readFile(path.resolve(import.meta.dirname, '..', '.env'), 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq < 1) continue;
        if (process.env[t.slice(0, eq)] === undefined) process.env[t.slice(0, eq)] = t.slice(eq + 1).replace(/^["']|["']$/g, '');
    }
}

const DASHBOARD = process.env.PHONE_FARM_URL ?? 'http://127.0.0.1:3000';
const WF_API = `${DASHBOARD}/api/workflows`;
const DEVICE_UDID = '00008020-000819CA2203002E';

async function api<T = Record<string, unknown>>(url: string, options?: RequestInit): Promise<T> {
    const res = await fetch(url, {
        ...options,
        headers: { origin: DASHBOARD, 'content-type': 'application/json', ...options?.headers },
    });
    if (res.status === 204) return undefined as unknown as T;
    const body = await res.json() as T & { error?: string };
    if (!res.ok) throw new Error(String(body.error ?? `HTTP ${res.status}`));
    return body;
}

interface WorkflowStep {
    stepType: string;
    label?: string;
    x?: number;
    y?: number;
    endX?: number;
    endY?: number;
    durationMs?: number;
    waitMs?: number;
    aiQuestion?: string;
    appBundleId?: string;
    appActionType?: string;
    url?: string;
    text?: string;
    skipSteps?: number;
}

async function main() {
    await loadLocalEnv();

    // Read the perfected workflow
    const SOURCE_WORKFLOW_ID = '63d71802-027c-44d6-a537-42029fc1dc3f';
    console.log(`Reading perfected workflow ${SOURCE_WORKFLOW_ID}...`);
    const source = await api<{ name: string; steps: Array<WorkflowStep & { id: string; stepOrder: number }> }>(
        `${WF_API}/${SOURCE_WORKFLOW_ID}`
    );
    console.log(`Found: "${source.name}" with ${source.steps.length} steps`);

    // Delete existing cloned workflow if present
    try {
        const { workflows } = await api<{ workflows?: Array<{ id: string; name: string }> }>(WF_API);
        const list = workflows ?? [];
        const existing = list.find((w) => w.name === 'Create Draft (clone)');
        if (existing) {
            console.log(`Deleting old clone: ${existing.id}...`);
            await fetch(`${WF_API}/${existing.id}`, { method: 'DELETE', headers: { origin: DASHBOARD } });
        }
    } catch {
        console.log('No old clone to remove');
    }

    // Create new cloned workflow
    console.log('Creating cloned workflow...');
    const wf = await api<{ id: string }>(WF_API, {
        method: 'POST',
        body: JSON.stringify({
            name: 'Create Draft (clone)',
            deviceUdid: DEVICE_UDID,
        }),
    });
    console.log(`Cloned workflow created: ${wf.id}`);

    // Copy each step
    const steps = source.steps.sort((a, b) => a.stepOrder - b.stepOrder);
    for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        const body: Record<string, unknown> = {
            stepType: s.stepType,
            label: s.label || undefined,
            x: s.x ?? undefined,
            y: s.y ?? undefined,
            endX: s.endX ?? undefined,
            endY: s.endY ?? undefined,
            durationMs: s.durationMs ?? undefined,
            waitMs: s.waitMs ?? undefined,
            aiQuestion: s.aiQuestion || undefined,
            appBundleId: s.appBundleId || undefined,
            appActionType: s.appActionType || undefined,
            url: s.url || undefined,
            text: s.text || undefined,
            skipSteps: s.skipSteps ?? undefined,
        };
        console.log(`  Step ${i + 1}/${steps.length}: ${s.stepType}${s.label ? ` — ${s.label}` : ''}`);
        await api(`${WF_API}/${wf.id}/steps`, {
            method: 'POST',
            body: JSON.stringify(body),
        });
    }

    // Verify
    const full = await api<{ steps: unknown[] }>(`${WF_API}/${wf.id}`);
    console.log(`\n=== Clone Complete ===`);
    console.log(`New workflow ID: ${wf.id}`);
    console.log(`Steps copied: ${full.steps.length}`);

    console.log('\nUpdate create.html to use this workflow ID:');
    console.log(`  state.workflowId = '${wf.id}';`);
}

await main();