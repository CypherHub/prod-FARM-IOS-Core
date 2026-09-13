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

async function main() {
    await loadLocalEnv();

    // Find the clone workflow
    const { workflows } = await api<{ workflows: Array<{ id: string; name: string }> }>(WF_API);
    const clone = workflows.find((w) => w.name === 'Create Draft (clone)');
    if (!clone) throw new Error('Clone workflow not found');
    console.log(`Found: ${clone.id} — ${clone.name}`);

    // Get its full steps
    const full = await api<{ steps: Array<{ id: string; stepOrder: number; stepType: string; label: string }> }>(`${WF_API}/${clone.id}`);
    const steps = full.steps.sort((a, b) => a.stepOrder - b.stepOrder);
    console.log(`${steps.length} steps`);

    // Steps 36 is "Unfocus from Caption", 37 is "Tap Save Drafts", 38 is "Wait for save"
    // We want: screenshot + if_condition BEFORE step 37 (Tap Save Drafts)
    // Strategy: add new steps at end, then reorder all

    console.log('\nAdding screenshot step before Save Drafts...');
    const screenshot = await api(`${WF_API}/${clone.id}/steps`, {
        method: 'POST',
        body: JSON.stringify({
            stepType: 'screenshot',
            label: 'Check for Post/Drafts buttons',
        }),
    });
    console.log(`  → Screenshot step: ${screenshot.id}`);

    console.log('Adding if_condition step...');
    const condition = await api(`${WF_API}/${clone.id}/steps`, {
        method: 'POST',
        body: JSON.stringify({
            stepType: 'if_condition',
            label: 'Verify Post/Drafts bottom buttons present',
            aiQuestion: 'Is the bottom of the screen showing two buttons side by side — one to post/save as Draft and one to go back/delete? Look for text like "Drafts", "Post", "Save". Answer YES if both buttons are visible at the bottom.',
        }),
    });
    console.log(`  → Condition step: ${condition.id}`);

    // Now reorder: insert the two new steps between 36 (Unfocus) and 37 (Tap Save Drafts)
    const originalIds = steps.map((s) => s.id);
    // Insert screenshot + condition after step 36 (index 35 in 0-based)
    const insertIndex = 36; // after 0-based index 35 = step 36 "Unfocus from Caption"
    const newOrder = [
        ...originalIds.slice(0, insertIndex),    // steps 1-36
        screenshot.id,                            // screenshot (new)
        condition.id,                             // condition (new)
        ...originalIds.slice(insertIndex),         // steps 37-38
    ];

    console.log(`\nReordering ${newOrder.length} steps...`);
    await api(`${WF_API}/${clone.id}/steps/reorder`, {
        method: 'PUT',
        body: JSON.stringify({ stepIds: newOrder }),
    });
    console.log('Reordered successfully.');

    // Verify
    const updated = await api<{ steps: Array<{ stepOrder: number; stepType: string; label: string }> }>(`${WF_API}/${clone.id}`);
    console.log('\n=== Final order ===');
    for (const s of updated.steps.sort((a, b) => a.stepOrder - b.stepOrder)) {
        console.log(`  ${s.stepOrder}. ${s.stepType} — ${s.label ?? ''}`);
    }
}

await main();