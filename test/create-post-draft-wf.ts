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

async function api(url: string, options?: RequestInit) {
    const res = await fetch(url, {
        ...options,
        headers: { origin: DASHBOARD, 'content-type': 'application/json', ...options?.headers },
    });
    const body = await res.json() as Record<string, unknown>;
    if (!res.ok) throw new Error(String(body.error ?? `HTTP ${res.status}`));
    return body;
}

interface StepDef {
    stepType: string;
    label?: string;
    x?: number;
    y?: number;
    waitMs?: number;
    aiQuestion?: string;
    appBundleId?: string;
    appActionType?: string;
    url?: string;
}

const steps: StepDef[] = [
    // 1. Unlock phone
    { stepType: 'unlock', label: 'Unlock Phone' },
    // 2. Deep link to TikTok profile page (universal link opens TikTok directly to profile)
    { stepType: 'open_url', label: 'Open TikTok to profile', url: 'https://www.tiktok.com/@my_sane_tea' },
    // 3. Let TikTok load
    { stepType: 'wait', label: 'Let TikTok load profile', waitMs: 5000 },
    // 4. Screenshot for AI
    { stepType: 'screenshot', label: 'Check profile screen' },
    // 5. AI verify we're on the profile page
    {
        stepType: 'if_condition',
        label: 'Verify on Profile',
        aiQuestion: 'Is this the TikTok profile/account page for @my_sane_tea? Look for follower/following count, a profile picture, and the account name @my_sane_tea. Answer YES if you can see the profile page.',
    },
    // 6. Tap the leftmost tab on profile — should be "Posts" tab
    //    Estimate: x~80, y~340 (below bio, left edge of pill tabs). Recalibrate from dashboard.
    { stepType: 'tap', label: 'Click Posts tab (leftmost tab)', x: 80, y: 340 },
    // 7. Settle
    { stepType: 'wait', label: 'Settle after Posts tab', waitMs: 1500 },
    // 8. Screenshot
    { stepType: 'screenshot', label: 'Check Posts tab for Drafts' },
    // 9. AI verify Drafts is visible on the posts grid
    {
        stepType: 'if_condition',
        label: 'Verify Drafts visible on Posts tab',
        aiQuestion: 'Can you see the word "Drafts" on this screen? Look for a "Drafts" tile, label, or tab among the posts grid. Answer YES if Drafts is visible.',
    },
    // 10. Tap the top-left draft thumbnail to open it
    //     Estimate: x~70, y~420 (top-left of the posts grid). Recalibrate from dashboard.
    { stepType: 'tap', label: 'Tap top-left draft thumbnail', x: 70, y: 420 },
    // 11. Wait for draft editor to open
    { stepType: 'wait', label: 'Let draft editor open', waitMs: 4000 },
    // 12. Screenshot
    { stepType: 'screenshot', label: 'Check draft editor' },
    // 13. AI verify the draft editor is open (Next button, edit controls)
    {
        stepType: 'if_condition',
        label: 'Verify Draft Editor Open',
        aiQuestion: 'Is a video/post draft editor open? Look for a "Next" button (bottom-right), "Edit" text, or video-editing controls. Do NOT look for the caption screen (Add description / Drafts / Post) — that comes after Next. Answer YES if the draft is being edited.',
    },
    // 14. Tap Next in the editor (iphonexr editorNext coordinate)
    { stepType: 'tap', label: 'Tap Next in editor', x: 286, y: 826 },
    // 15. Wait for caption screen
    { stepType: 'wait', label: 'Let caption screen load', waitMs: 2500 },
    // 16. Screenshot
    { stepType: 'screenshot', label: 'Check caption screen' },
    // 17. AI verify the caption/posting screen (Drafts / Post buttons visible)
    {
        stepType: 'if_condition',
        label: 'Verify Caption and Post Screen',
        aiQuestion: 'Is this the final caption/posting screen? Look for "Drafts" and "Post" buttons, or "Add description" text. The Post button is bottom-right, Drafts is bottom-left. Answer YES if you can see the caption screen with Post/Drafts options.',
    },
    // 18. Tap Post (finish) — iphonexr finish coordinate
    { stepType: 'tap', label: 'Tap Post (publish)', x: 306, y: 846 },
    // 19. Wait for post to complete
    { stepType: 'wait', label: 'Wait for post to complete', waitMs: 3000 },
];

async function main() {
    await loadLocalEnv();

    // 1. Create the workflow
    console.log('Creating workflow...');
    const wf = await api(WF_API, {
        method: 'POST',
        body: JSON.stringify({
            name: 'Post Draft Workflow',
            deviceUdid: DEVICE_UDID,
        }),
    }) as { id: string };
    console.log(`Workflow created: ${wf.id}`);

    // 2. Add each step
    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        console.log(`  Step ${i + 1}/${steps.length}: ${step.stepType}${step.label ? ` — ${step.label}` : ''}`);
        await api(`${WF_API}/${wf.id}/steps`, {
            method: 'POST',
            body: JSON.stringify(step),
        });
    }

    // 3. Print summary
    console.log('\n=== Workflow Created ===');
    console.log(`ID: ${wf.id}`);
    console.log(`Name: Post Draft Workflow`);
    console.log(`Device: ${DEVICE_UDID}`);
    console.log(`Steps: ${steps.length}`);

    // 4. Fetch back to confirm
    const full = await api(`${WF_API}/${wf.id}`) as { status: string; steps: unknown[] };
    console.log(`Status: ${full.status}`);
    const saved = full.steps as Array<{ stepOrder: number; stepType: string; label: string | null }>;
    console.log(`Saved steps: ${saved.length}`);
    for (const s of saved) {
        console.log(`  [${s.stepOrder}] ${s.stepType}${s.label ? ` — ${s.label}` : ''}`);
    }

    console.log('\nDone. Visit /workflows/' + wf.id + ' in the dashboard to calibrate coordinates and replay.');
}

await main();