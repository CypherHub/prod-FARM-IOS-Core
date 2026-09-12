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
    url?: string;
    skipSteps?: number;
}

// iphonexr profile constants
const CELL_X = 68;
const CELL_STEP = 168;
const CELL_Y = 707;
const UPLOAD_X = 40;
const UPLOAD_Y = 832;
const PICKER_NEXT_X = 306;
const PICKER_NEXT_Y = 829;
const EDITOR_NEXT_X = 286;
const EDITOR_NEXT_Y = 826;
const CAPTION_X = 160;
const CAPTION_Y = 276;
const FINISH_X = 306;
const FINISH_Y = 846;

// Placeholder music URL — replaceable from the library bookmark page
const MUSIC_URL = 'https://www.tiktok.com/music/original-sound-7018355359623482120';

// === Helper: generate a 4-step tap+check block ===
// skipSteps=0 means gate mode (NO stops replay)
function tapCheck(
    label: string,
    x: number,
    y: number,
    stepOrderHint: number,
    skipSteps: number,
    isLast: boolean,
): StepDef[] {
    return [
        { stepType: 'tap', label: `Tap ${label}`, x, y },
        { stepType: 'wait', label: `Settle after ${label}`, waitMs: 1500 },
        { stepType: 'screenshot', label: `Check ${label} selection` },
        {
            stepType: 'if_condition',
            label: isLast ? 'Verify video selected (final)' : `Video selected after ${label}? YES=skip remaining`,
            aiQuestion: 'Is a video thumbnail highlighted with a selection circle or checkmark? Look for a blue or red circle on one of the thumbnails in the gallery grid. Answer YES if a video is selected.',
            skipSteps: skipSteps || undefined,
        },
    ];
}

const steps: StepDef[] = [
    // === Open + verify ===
    { stepType: 'unlock', label: 'Unlock Phone' },
    { stepType: 'open_url', label: 'Open TikTok music page', url: MUSIC_URL },
    { stepType: 'wait', label: 'Let music page load', waitMs: 8000 },
    { stepType: 'screenshot', label: 'Check music page' },
    {
        stepType: 'if_condition',
        label: 'Verify Use this sound visible',
        aiQuestion: 'Can you see a "Use this sound" button on this screen? Look for a pink, blue, or red button with text containing "sound" or "use". Answer YES if you can see the Use this sound button.',
    },
    { stepType: 'tap', label: 'Tap Use this sound (ESTIMATE)', x: 207, y: 790 },
    { stepType: 'wait', label: 'Let sound attach and camera open', waitMs: 4000 },
    { stepType: 'screenshot', label: 'Check camera screen' },
    {
        stepType: 'if_condition',
        label: 'Verify camera screen',
        aiQuestion: 'Are you now on the TikTok camera/creation screen? Look for a red record button, gallery thumbnails, or a shutter button. Answer YES if the camera screen is visible.',
    },

    // === Gallery picker ===
    { stepType: 'tap', label: 'Tap gallery upload thumbnail', x: UPLOAD_X, y: UPLOAD_Y },
    { stepType: 'wait', label: 'Let picker open', waitMs: 3000 },
    { stepType: 'screenshot', label: 'Check gallery picker' },
    {
        stepType: 'if_condition',
        label: 'Verify picker open',
        aiQuestion: 'Is the photo/video gallery picker open? Look for a grid of thumbnails, a "Recents" label, or a "Select multiple" toggle. Answer YES if the picker/gallery is open.',
    },

    // === Newest-video selection with per-tap AI checks ===
    // Skip mode: if AI says YES (video found), skip remaining taps
    // skipSteps=9: skip tap middle + check + tap right + check (8 steps) + 1 for the loop increment offset
    // skipSteps=5: skip tap right + check (4 steps) + 1 offset
    ...tapCheck('left cell (oldest)', CELL_X, CELL_Y, 14, 8, false),
    ...tapCheck('middle cell', CELL_X + CELL_STEP, CELL_Y, 18, 4, false),
    ...tapCheck('right cell (newest)', CELL_X + 2 * CELL_STEP, CELL_Y, 22, 0, true),

    { stepType: 'wait', label: 'Final settle after selection', waitMs: 1000 },

    // === Editor flow ===
    { stepType: 'tap', label: 'Tap Next in picker', x: PICKER_NEXT_X, y: PICKER_NEXT_Y },
    { stepType: 'wait', label: 'Let editor load', waitMs: 3000 },
    { stepType: 'screenshot', label: 'Check editor' },
    {
        stepType: 'if_condition',
        label: 'Verify editor open',
        aiQuestion: 'Is the TikTok video editor open? Look for editing controls, a trim bar, or a "Next" button (bottom-right). Answer YES if the editor is visible.',
    },
    { stepType: 'tap', label: 'Tap Next in editor', x: EDITOR_NEXT_X, y: EDITOR_NEXT_Y },
    { stepType: 'wait', label: 'Let caption screen load', waitMs: 3000 },
    { stepType: 'screenshot', label: 'Check caption screen' },
    {
        stepType: 'if_condition',
        label: 'Verify caption screen',
        aiQuestion: 'Is this the final caption/posting screen? Look for "Drafts" and "Post" buttons, or "Add description" text. Answer YES if the caption screen is visible.',
    },
    { stepType: 'tap', label: 'Tap caption field to focus', x: CAPTION_X, y: CAPTION_Y },
    { stepType: 'wait', label: 'Settle after caption focus', waitMs: 1000 },
    { stepType: 'tap', label: 'Tap Post (save to drafts)', x: FINISH_X, y: FINISH_Y },
    { stepType: 'wait', label: 'Wait for save', waitMs: 3000 },
];

async function main() {
    await loadLocalEnv();

    // Delete old workflow with same name first if exists
    try {
        const existing = await api(WF_API) as { workflows?: Array<{ id: string; name: string }> };
        const list = existing.workflows ?? [];
        const old = list.find((w) => w.name === 'Create Draft with Video, Caption and Song');
        if (old) {
            console.log('Removing old workflow...');
            await fetch(`${WF_API}/${old.id}`, { method: 'DELETE', headers: { origin: DASHBOARD } });
        }
    } catch {
        console.log('No old workflow to remove (or list failed)');
    }

    // 1. Create the workflow
    console.log('Creating workflow...');
    const wf = await api(WF_API, {
        method: 'POST',
        body: JSON.stringify({
            name: 'Create Draft with Video, Caption and Song',
            deviceUdid: DEVICE_UDID,
        }),
    }) as { id: string };
    console.log(`Workflow created: ${wf.id}`);

    // 2. Add each step
    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        console.log(`  Step ${i + 1}/${steps.length}: ${step.stepType}${step.label ? ` — ${step.label}` : ''}${step.skipSteps ? ` [skipSteps=${step.skipSteps}]` : ''}`);
        await api(`${WF_API}/${wf.id}/steps`, {
            method: 'POST',
            body: JSON.stringify(step),
        });
    }

    // 3. Fetch back to confirm
    const full = await api(`${WF_API}/${wf.id}`) as { status: string; steps: unknown[] };
    console.log(`\n=== Workflow Created ===`);
    console.log(`ID: ${wf.id}`);
    console.log(`Status: ${full.status}`);
    const saved = full.steps as Array<{ stepOrder: number; stepType: string; label: string | null; skipSteps: number | null }>;
    console.log(`Saved steps: ${saved.length}`);
    for (const s of saved) {
        console.log(`  [${s.stepOrder}] ${s.stepType}${s.label ? ` — ${s.label}` : ''}${s.skipSteps ? ` [skip=${s.skipSteps}]` : ''}`);
    }

    console.log('\nDone. Visit /workflows/' + wf.id + ' in the dashboard.');
}

await main();