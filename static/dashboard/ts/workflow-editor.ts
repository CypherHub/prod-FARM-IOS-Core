export {};

interface WorkflowStep {
    id: string;
    workflowId: string;
    stepOrder: number;
    stepType: string;
    label: string | null;
    x: number | null;
    y: number | null;
    endX: number | null;
    endY: number | null;
    durationMs: number | null;
    waitMs: number | null;
    aiQuestion: string | null;
    appBundleId: string | null;
    appActionType: string | null;
    url: string | null;
}

interface WorkflowData {
    id: string;
    name: string;
    description: string | null;
    deviceUdid: string | null;
    status: string;
    steps: WorkflowStep[];
}

interface ReplayStatus {
    runId: string;
    status: string;
    totalSteps: number;
    currentStep: number;
    logs: Array<{ step: number; message: string; type: string }>;
    error?: string;
}

// Get workflow ID from URL
const urlMatch = window.location.pathname.match(/\/workflows\/([a-f0-9-]+)/);
const workflowId = urlMatch?.[1];
if (!workflowId) throw new Error('No workflow ID in URL');

const API = '/api/workflows';

// DOM elements
const nameDisplay = document.querySelector<HTMLElement>('#workflow-name-display')!;
const editorName = document.querySelector<HTMLElement>('#wf-editor-name')!;
const editorMeta = document.querySelector<HTMLElement>('#wf-editor-meta')!;
const stepsList = document.querySelector<HTMLElement>('#steps-list')!;
const stepDetail = document.querySelector<HTMLElement>('#step-detail')!;
const stepDetailTitle = document.querySelector<HTMLElement>('#step-detail-title')!;
const stepLabel = document.querySelector<HTMLInputElement>('#step-label')!;
const stepParams = document.querySelector<HTMLElement>('#step-params')!;
const stepUpdate = document.querySelector<HTMLButtonElement>('#step-update')!;
const stepDelete = document.querySelector<HTMLButtonElement>('#step-delete')!;
const saveBtn = document.querySelector<HTMLButtonElement>('#save-workflow')!;
const replayBtn = document.querySelector<HTMLButtonElement>('#replay-workflow')!;
const replayStatus = document.querySelector<HTMLElement>('#replay-status')!;
const addStepBtn = document.querySelector<HTMLButtonElement>('#add-step')!;
const addStepDialog = document.querySelector<HTMLDialogElement>('#add-step-dialog')!;
const stepTypeSelect = document.querySelector<HTMLSelectElement>('#step-type-select')!;
const addStepParams = document.querySelector<HTMLElement>('#add-step-params')!;
const addStepSubmit = document.querySelector<HTMLButtonElement>('#add-step-submit')!;
const recordToggle = document.querySelector<HTMLInputElement>('#record-toggle')!;
const recordToggleContainer = document.querySelector<HTMLElement>('#record-toggle-container')!;
const screenImg = document.querySelector<HTMLImageElement>('#wf-screen')!;
const streamLabel = document.querySelector<HTMLElement>('#wf-stream-label')!;
const deviceSelect = document.querySelector<HTMLSelectElement>('#wf-device-select')!;

let workflow: WorkflowData | null = null;
let selectedStepId: string | null = null;
// Track which step type fields to show in detail
let detailStepType: string | null = null;
let replayRunId: string | null = null;
let screenWidth = 0;
let screenHeight = 0;
let streamInterval: ReturnType<typeof setInterval> | null = null;

async function request<T>(url: string, options?: RequestInit): Promise<T> {
    const response = await fetch(url, options);
    if (response.status === 204) return undefined as unknown as T;
    const body = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
    return body;
}

function escapeHtml(value: string | null | undefined): string {
    if (!value) return '';
    return String(value).replace(/[&<>"']/g, (ch) => {
        switch (ch) { case '&': return '&amp;'; case '<': return '&lt;'; case '>': return '&gt;'; case '"': return '&quot;'; case "'": return '&#39;'; }
        return ch;
    });
}

function stepIcon(type: string): string {
    switch (type) {
        case 'tap': return '&#128073;';
        case 'swipe': return '&#8594;';
        case 'wait': return '&#9200;';
        case 'if_condition': return '&#129302;';
        case 'home': return '&#8962;';
        case 'unlock': return '&#128274;';
        case 'open_url': return '&#128279;';
        case 'app_action': return '&#9881;';
        case 'screenshot': return '&#128247;';
        default: return '&#8212;';
    }
}

function stepSummary(step: WorkflowStep): string {
    let label = step.label ? ` — ${escapeHtml(step.label)}` : '';
    switch (step.stepType) {
        case 'tap': return `Tap (${step.x}, ${step.y})${label}`;
        case 'swipe': return `Swipe (${step.x},${step.y}) -> (${step.endX},${step.endY}) ${step.durationMs}ms${label}`;
        case 'wait': return `Wait ${step.waitMs ?? 1000}ms${label}`;
        case 'if_condition': return `IF: ${escapeHtml(step.aiQuestion?.slice(0, 40))}${label}`;
        case 'home': return `Home${label}`;
        case 'unlock': return `Unlock${label}`;
        case 'open_url': return `URL: ${escapeHtml(step.url?.slice(0, 40))}${label}`;
        case 'app_action': return `${step.appActionType ?? 'activate'} ${escapeHtml(step.appBundleId)}${label}`;
        case 'screenshot': return `Screenshot${label}`;
        default: return step.stepType;
    }
}

function renderSteps(): void {
    if (!workflow) return;
    const items = workflow.steps;
    if (!items.length) {
        stepsList.className = 'task-list empty-state';
        stepsList.innerHTML = '<h2>No steps yet</h2><p>Use Record mode to tap on the phone screen, or click Add step to create one manually.</p>';
        return;
    }
    stepsList.className = 'task-list';
    stepsList.replaceChildren(...items.map((step) => {
        const row = document.createElement('article');
        row.className = `task-row${step.id === selectedStepId ? ' task-row-selected' : ''}`;
        row.dataset.stepId = step.id;

        const copy = document.createElement('div');
        const title = document.createElement('h3');
        title.innerHTML = `${stepIcon(step.stepType)} Step ${step.stepOrder}: ${step.stepType.replace('_', ' ').toUpperCase()}`;
        const meta = document.createElement('p');
        meta.textContent = stepSummary(step);
        copy.append(title, meta);

        const actions = document.createElement('div');
        actions.className = 'inline-actions';
        const upBtn = document.createElement('button');
        upBtn.className = 'icon-button'; upBtn.type = 'button'; upBtn.textContent = '&#8593;';
        upBtn.innerHTML = '&#8593;';
        upBtn.addEventListener('click', (e) => { e.stopPropagation(); void moveStep(step.id, -1); });
        if (step.stepOrder === 1) upBtn.disabled = true;

        const downBtn = document.createElement('button');
        downBtn.className = 'icon-button'; downBtn.type = 'button'; downBtn.textContent = '&#8595;';
        downBtn.innerHTML = '&#8595;';
        downBtn.addEventListener('click', (e) => { e.stopPropagation(); void moveStep(step.id, 1); });
        if (step.stepOrder === items.length) downBtn.disabled = true;

        actions.append(upBtn, downBtn);

        row.addEventListener('click', () => selectStep(step.id));
        row.append(copy, actions);
        return row;
    }));
}

function selectStep(stepId: string | null): void {
    selectedStepId = stepId;
    if (!stepId || !workflow) {
        stepDetail.style.display = 'none';
        return;
    }
    const step = workflow.steps.find((s) => s.id === stepId);
    if (!step) { stepDetail.style.display = 'none'; return; }

    stepDetail.style.display = 'block';
    detailStepType = step.stepType;
    stepDetailTitle.textContent = `Step ${step.stepOrder}: ${step.stepType.replace('_', ' ').toUpperCase()}`;
    stepLabel.value = step.label ?? '';

    // Render step-specific params
    stepParams.innerHTML = renderStepParams(step);
}

function renderStepParams(step: WorkflowStep): string {
    switch (step.stepType) {
        case 'tap':
            return `
                <div class="field"><label>X coordinate<input id="dt-x" type="number" value="${step.x ?? ''}"></label></div>
                <div class="field"><label>Y coordinate<input id="dt-y" type="number" value="${step.y ?? ''}"></label></div>`;
        case 'swipe':
            return `
                <div class="field"><label>Start X<input id="dt-x" type="number" value="${step.x ?? ''}"></label></div>
                <div class="field"><label>Start Y<input id="dt-y" type="number" value="${step.y ?? ''}"></label></div>
                <div class="field"><label>End X<input id="dt-endX" type="number" value="${step.endX ?? ''}"></label></div>
                <div class="field"><label>End Y<input id="dt-endY" type="number" value="${step.endY ?? ''}"></label></div>
                <div class="field"><label>Duration (ms)<input id="dt-durationMs" type="number" value="${step.durationMs ?? 500}"></label></div>`;
        case 'wait':
            return `
                <div class="field"><label>Wait (ms)<input id="dt-waitMs" type="number" value="${step.waitMs ?? 1000}"></label></div>`;
        case 'if_condition':
            return `
                <div class="field"><label>AI Question<input id="dt-aiQuestion" type="text" value="${escapeHtml(step.aiQuestion ?? '')}" style="width:100%"></label></div>
                <p class="hint">When this step runs, a screenshot is taken and sent to AI with your question. If YES, the workflow continues. If NO, the workflow stops.</p>`;
        case 'open_url':
            return `
                <div class="field"><label>URL<input id="dt-url" type="url" value="${escapeHtml(step.url ?? '')}" style="width:100%"></label></div>`;
        case 'app_action':
            return `
                <div class="field"><label>Bundle ID<input id="dt-appBundleId" type="text" value="${escapeHtml(step.appBundleId ?? '')}"></label></div>
                <div class="field"><label>Action<select id="dt-appActionType"><option value="activate" ${step.appActionType === 'activate' ? 'selected' : ''}>Activate</option><option value="terminate" ${step.appActionType === 'terminate' ? 'selected' : ''}>Terminate</option></select></label></div>`;
        case 'home':
        case 'unlock':
        case 'screenshot':
            return `<p class="hint">This step has no additional configuration.</p>`;
        default:
            return '';
    }
}

async function moveStep(stepId: string, direction: number): Promise<void> {
    if (!workflow) return;
    const idx = workflow.steps.findIndex((s) => s.id === stepId);
    if (idx < 0) return;
    const targetIdx = idx + direction;
    if (targetIdx < 0 || targetIdx >= workflow.steps.length) return;

    const current = workflow.steps[idx]!;
    const target = workflow.steps[targetIdx]!;

    // Swap step order
    await request(`${API}/${workflowId}/steps/reorder`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stepIds: workflow.steps.map((s) => s.id === stepId ? target.id : s.id === target.id ? stepId : s.id) }),
    });

    await reloadWorkflow();
}

function renderStepTypeFields(stepType: string): string {
    switch (stepType) {
        case 'tap':
            return `
                <div class="field"><label>X coordinate (click on phone to set)<input id="as-x" type="number" placeholder="e.g. 200"></label></div>
                <div class="field"><label>Y coordinate (click on phone to set)<input id="as-y" type="number" placeholder="e.g. 400"></label></div>`;
        case 'swipe':
            return `
                <div class="field"><label>Start X<input id="as-x" type="number" placeholder="e.g. 200"></label></div>
                <div class="field"><label>Start Y<input id="as-y" type="number" placeholder="e.g. 700"></label></div>
                <div class="field"><label>End X<input id="as-endX" type="number" placeholder="e.g. 200"></label></div>
                <div class="field"><label>End Y<input id="as-endY" type="number" placeholder="e.g. 100"></label></div>
                <div class="field"><label>Duration (ms)<input id="as-durationMs" type="number" value="500" placeholder="500"></label></div>`;
        case 'wait':
            return `<div class="field"><label>Duration (ms)<input id="as-waitMs" type="number" value="1000" placeholder="1000"></label></div>`;
        case 'if_condition':
            return `
                <div class="field" style="grid-column:1/-1"><label>Question for AI<textarea id="as-aiQuestion" placeholder="Is the music page visible?" style="min-height:60px"></textarea></label></div>
                <p class="hint">When this step runs, a screenshot is taken. The AI answers YES or NO to your question. NO stops the workflow.</p>`;
        case 'open_url':
            return `<div class="field" style="grid-column:1/-1"><label>URL<input id="as-url" type="url" placeholder="https://www.tiktok.com/music/..." style="width:100%"></label></div>`;
        case 'app_action':
            return `
                <div class="field"><label>Bundle ID<input id="as-appBundleId" type="text" placeholder="com.zhiliaoapp.musically"></label></div>
                <div class="field"><label>Action<select id="as-appActionType"><option value="activate">Activate</option><option value="terminate">Terminate</option></select></label></div>`;
        case 'home':
        case 'unlock':
        case 'screenshot':
            return `<p class="hint">This step type requires no additional parameters.</p>`;
        default:
            return '';
    }
}

async function addStep(stepType: string): Promise<void> {
    if (!workflowId) return;
    const label = (document.querySelector<HTMLInputElement>('#add-step-label')!)?.value?.trim() ?? '';
    const body: Record<string, unknown> = { stepType, label: label || undefined };

    // Collect fields based on type
    const x = (document.querySelector<HTMLInputElement>('#as-x'))?.value;
    const y = (document.querySelector<HTMLInputElement>('#as-y'))?.value;
    const endX = (document.querySelector<HTMLInputElement>('#as-endX'))?.value;
    const endY = (document.querySelector<HTMLInputElement>('#as-endY'))?.value;
    const durationMs = (document.querySelector<HTMLInputElement>('#as-durationMs'))?.value;
    const waitMs = (document.querySelector<HTMLInputElement>('#as-waitMs'))?.value;
    const aiQuestion = (document.querySelector<HTMLTextAreaElement>('#as-aiQuestion'))?.value;
    const url = (document.querySelector<HTMLInputElement>('#as-url'))?.value;
    const appBundleId = (document.querySelector<HTMLInputElement>('#as-appBundleId'))?.value;
    const appActionType = (document.querySelector<HTMLSelectElement>('#as-appActionType'))?.value;

    if (x) body.x = Number(x);
    if (y) body.y = Number(y);
    if (endX) body.endX = Number(endX);
    if (endY) body.endY = Number(endY);
    if (durationMs) body.durationMs = Number(durationMs);
    if (waitMs) body.waitMs = Number(waitMs);
    if (aiQuestion) body.aiQuestion = aiQuestion;
    if (url) body.url = url;
    if (appBundleId) body.appBundleId = appBundleId;
    if (appActionType) body.appActionType = appActionType;

    await request(`${API}/${workflowId}/steps`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });

    addStepDialog.close();
    await reloadWorkflow();
}

async function updateSelectedStep(): Promise<void> {
    if (!selectedStepId || !detailStepType) return;
    const body: Record<string, unknown> = {};
    body.label = stepLabel.value ?? '';

    const x = (document.querySelector<HTMLInputElement>('#dt-x'))?.value;
    const y = (document.querySelector<HTMLInputElement>('#dt-y'))?.value;
    const endX = (document.querySelector<HTMLInputElement>('#dt-endX'))?.value;
    const endY = (document.querySelector<HTMLInputElement>('#dt-endY'))?.value;
    const durationMs = (document.querySelector<HTMLInputElement>('#dt-durationMs'))?.value;
    const waitMs = (document.querySelector<HTMLInputElement>('#dt-waitMs'))?.value;
    const aiQuestion = (document.querySelector<HTMLInputElement>('#dt-aiQuestion'))?.value;
    const url = (document.querySelector<HTMLInputElement>('#dt-url'))?.value;
    const appBundleId = (document.querySelector<HTMLInputElement>('#dt-appBundleId'))?.value;
    const appActionType = (document.querySelector<HTMLSelectElement>('#dt-appActionType'))?.value;

    if (x !== null && x !== undefined && x !== '') body.x = Number(x);
    if (y !== null && y !== undefined && y !== '') body.y = Number(y);
    if (endX !== null && endX !== undefined && endX !== '') body.endX = Number(endX);
    if (endY !== null && endY !== undefined && endY !== '') body.endY = Number(endY);
    if (durationMs !== null && durationMs !== undefined && durationMs !== '') body.durationMs = Number(durationMs);
    if (waitMs !== null && waitMs !== undefined && waitMs !== '') body.waitMs = Number(waitMs);
    if (aiQuestion !== null && aiQuestion !== undefined && aiQuestion !== '') body.aiQuestion = aiQuestion;
    if (url !== null && url !== undefined && url !== '') body.url = url;
    if (appBundleId !== null && appBundleId !== undefined && appBundleId !== '') body.appBundleId = appBundleId;
    if (appActionType !== null && appActionType !== undefined && appActionType !== '') body.appActionType = appActionType;

    await request(`/api/workflow-steps/${selectedStepId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });

    await reloadWorkflow();
    // Re-select the step to refresh the detail panel with server-confirmed values
    selectStep(selectedStepId);
}

async function deleteSelectedStep(): Promise<void> {
    if (!selectedStepId) return;
    if (!window.confirm('Delete this step?')) return;
    await request(`/api/workflow-steps/${selectedStepId}`, { method: 'DELETE' });
    selectedStepId = null;
    stepDetail.style.display = 'none';
    await reloadWorkflow();
}

async function reloadWorkflow(): Promise<void> {
    workflow = await request<WorkflowData>(`${API}/${workflowId}`);
    updateHeader();
    renderSteps();
}

function updateHeader(): void {
    if (!workflow) return;
    nameDisplay.textContent = workflow.name;
    editorName.textContent = workflow.name;
    editorMeta.textContent = `${workflow.steps.length} steps · ${workflow.status}${workflow.deviceUdid ? ` · device: ${workflow.deviceUdid.slice(0, 8)}…` : ' · no device'}`;
    saveBtn.style.display = 'inline-flex';
}

async function saveWorkflow(): Promise<void> {
    if (!workflow) return;
    const name = window.prompt('Workflow name', workflow.name);
    if (!name) return;
    await request(`${API}/${workflowId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
    });
    await reloadWorkflow();
}

async function startReplay(): Promise<void> {
    if (!workflowId) return;
    if (workflow && !workflow.deviceUdid) {
        const udid = window.prompt('This workflow has no device assigned. Enter a device UDID:');
        if (!udid) return;
        await request(`${API}/${workflowId}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ deviceUdid: udid.trim() }),
        });
        await reloadWorkflow();
    }

    replayStatus.style.display = 'flex';
    replayStatus.innerHTML = '<span class="spinner"></span>Running workflow…';
    replayBtn.disabled = true;

    try {
        const result = await request<ReplayStatus>(`${API}/${workflowId}/replay`, { method: 'POST' });
        replayRunId = result.runId;
        pollReplay();
    } catch (error) {
        replayStatus.innerHTML = `<span class="dot failed"></span>Replay failed: ${error instanceof Error ? error.message : String(error)}`;
        replayBtn.disabled = false;
    }
}

function pollReplay(): void {
    if (!replayRunId) return;
    const interval = setInterval(async () => {
        try {
            const status = await request<ReplayStatus>(`/api/workflows/replay/${replayRunId}`);
            const logs = status.logs.slice(-5).map((log) => `[${log.type}] Step ${log.step}: ${log.message}`).join('\n');
            replayStatus.innerHTML = `
                <div class="run-heading"><span class="status running"><span class="dot"></span>${status.status}</span>
                <span class="run-meta">Step ${status.currentStep}/${status.totalSteps}</span></div>
                <pre>${logs || 'Running…'}</pre>`;

            if (status.status !== 'running') {
                clearInterval(interval);
                replayBtn.disabled = false;
                if (status.status === 'succeeded') {
                    replayStatus.innerHTML = replayStatus.innerHTML.replace('class="status running"', 'class="status succeeded"');
                    replayStatus.querySelector('.run-heading')!.innerHTML = '<span class="status succeeded"><span class="dot"></span>Succeeded</span>';
                } else if (status.status === 'failed') {
                    replayStatus.querySelector('.run-heading')!.innerHTML = `<span class="status failed"><span class="dot"></span>Failed</span>`;
                } else if (status.status === 'stopped') {
                    replayStatus.querySelector('.run-heading')!.innerHTML = `<span class="status stopped"><span class="dot"></span>Stopped</span>`;
                }
            }
        } catch {
            clearInterval(interval);
            replayBtn.disabled = false;
            replayStatus.innerHTML = '<span class="dot failed"></span>Replay connection lost';
        }
    }, 1000);
}

// === DEVICE SELECTOR ===

interface DeviceInfo {
    udid: string;
    name: string;
    connected: unknown | null;
    disabled?: boolean;
}

async function loadDevices(): Promise<DeviceInfo[]> {
    try {
        const raw = await request<DeviceInfo[]>('/api/devices');
        return raw.filter((d) => !d.disabled);
    } catch {
        return [];
    }
}

function populateDeviceSelect(devices: DeviceInfo[]): void {
    deviceSelect.innerHTML = '<option value="">— No device —</option>';
    for (const device of devices) {
        const opt = document.createElement('option');
        opt.value = device.udid;
        opt.textContent = `${device.name}${device.connected ? '' : ' (offline)'}`;
        deviceSelect.append(opt);
    }
    if (workflow?.deviceUdid) {
        deviceSelect.value = workflow.deviceUdid;
    }
}

async function updateDeviceAssignment(udid: string): Promise<void> {
    await request(`${API}/${workflowId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceUdid: udid || null }),
    });
    workflow = await request<WorkflowData>(`${API}/${workflowId}`);
    updateHeader();
    if (udid) {
        connectStream();
    } else {
        if (streamInterval) clearInterval(streamInterval);
        screenImg.src = '';
        streamLabel.textContent = 'Assign a device to this workflow to stream its screen';
        recordToggleContainer.style.display = 'none';
    }
}

// === PHONE STREAM ===

function connectStream(): void {
    if (!workflow?.deviceUdid) {
        streamLabel.textContent = 'Assign a device to this workflow to stream its screen';
        recordToggleContainer.style.display = 'none';
        return;
    }
    const udid = workflow.deviceUdid;
    recordToggleContainer.style.display = 'flex';

    // Start MJPEG stream
    screenImg.src = `/api/devices/${encodeURIComponent(udid)}/remote/stream?t=${Date.now()}`;
    screenImg.onerror = () => {
        // Fallback to polling screenshots
        if (streamInterval) clearInterval(streamInterval);
        streamInterval = setInterval(() => {
            screenImg.src = `/api/devices/${encodeURIComponent(udid)}/remote/screenshot?t=${Date.now()}`;
        }, 2000);
        streamLabel.textContent = 'Stream unavailable, polling screenshots';
    };
    screenImg.onload = () => {
        if (streamInterval) clearInterval(streamInterval);
        streamLabel.textContent = 'Live stream connected';
        // Fetch screen size
        fetch(`/api/devices/${encodeURIComponent(udid)}/remote/info`)
            .then((r) => r.json())
            .then((data) => {
                if (data.screen) {
                    screenWidth = data.screen.screenSize.width;
                    screenHeight = data.screen.screenSize.height;
                }
            })
            .catch(() => {});
    };
}

// Record mode: capture taps on the stream
screenImg.addEventListener('pointerdown', (e) => {
    if (!recordToggle.checked || !workflow?.deviceUdid) return;
    e.preventDefault();

    // Tap at the point
    const rect = screenImg.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;

    // Calculate normalized coordinates
    const imgAspect = screenWidth / screenHeight;
    const imgRectAspect = rect.width / rect.height;

    let nx = offsetX / rect.width;
    let ny = offsetY / rect.height;

    // Account for image fit within the phone frame
    if (imgRectAspect > imgAspect) {
        // Phone is portrait, container is wider
        const visibleW = rect.height * imgAspect;
        const offset = (rect.width - visibleW) / 2;
        nx = (offsetX - offset) / visibleW;
    } else if (imgAspect > imgRectAspect) {
        // Container is taller
        const visibleH = rect.width / imgAspect;
        const offset = (rect.height - visibleH) / 2;
        ny = (offsetY - offset) / visibleH;
    }

    nx = Math.max(0, Math.min(1, nx));
    ny = Math.max(0, Math.min(1, ny));

    // Convert normalized to raw pixel coordinates
    const rawX = Math.round(nx * screenWidth);
    const rawY = Math.round(ny * screenHeight);

    // Actually tap the phone
    fetch(`/api/devices/${encodeURIComponent(workflow.deviceUdid)}/remote/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'tap', x: rawX, y: rawY }),
    }).catch(() => {});

    // Check if a tap step is selected in the detail panel — update its coordinates
    if (selectedStepId && detailStepType === 'tap') {
        const step = workflow.steps.find((s) => s.id === selectedStepId);
        if (step) {
            fetch(`/api/workflow-steps/${selectedStepId}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ x: rawX, y: rawY, label: step.label || `Recorded tap (${rawX}, ${rawY})` }),
            })
                .then((r) => r.json())
                .then(() => reloadWorkflow())
                .then(() => selectStep(selectedStepId))
                .catch(() => {});
            return;
        }
    }

    // Otherwise, add a new tap step
    fetch(`${API}/${workflowId}/steps`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stepType: 'tap', x: rawX, y: rawY, label: `Recorded tap (${rawX}, ${rawY})` }),
    })
        .then((r) => r.json())
        .then(() => reloadWorkflow())
        .catch(() => {});
});

// Swipe pad remote controls
document.querySelectorAll('.remote-button[data-dir]').forEach((btn) => {
    btn.addEventListener('click', async () => {
        if (!workflow?.deviceUdid) return;
        const dir = (btn as HTMLElement).dataset.dir!;
        const cx = Math.round(screenWidth / 2);
        const cy = Math.round(screenHeight / 2);
        const delta = Math.round(Math.min(screenWidth, screenHeight) * 0.3);
        let action: Record<string, unknown> = { type: 'swipe', startX: cx, startY: cy, endX: cx, endY: cy, durationMs: 300 };

        switch (dir) {
            case 'up':
                action = { type: 'swipe', startX: cx, startY: cy + delta, endX: cx, endY: cy - delta, durationMs: 300 };
                break;
            case 'down':
                action = { type: 'swipe', startX: cx, startY: cy - delta, endX: cx, endY: cy + delta, durationMs: 300 };
                break;
            case 'left':
                action = { type: 'swipe', startX: cx + delta, startY: cy, endX: cx - delta, endY: cy, durationMs: 300 };
                break;
            case 'right':
                action = { type: 'swipe', startX: cx - delta, startY: cy, endX: cx + delta, endY: cy, durationMs: 300 };
                break;
        }
        try {
            await fetch(`/api/devices/${encodeURIComponent(workflow.deviceUdid!)}/remote/action`, {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action),
            });
        } catch { /* ignore */ }
    });
});

// System controls
document.querySelectorAll('.remote-button[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
        if (!workflow?.deviceUdid) return;
        const action = (btn as HTMLElement).dataset.action!;
        try {
            await fetch(`/api/devices/${encodeURIComponent(workflow.deviceUdid)}/remote/action`, {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: action }),
            });
        } catch { /* ignore */ }
    });
});

// Save workflow name
saveBtn.addEventListener('click', () => void saveWorkflow());

// Replay
replayBtn.addEventListener('click', () => void startReplay());

// Add step
addStepBtn.addEventListener('click', () => {
    // Reset form
    const labelField = document.querySelector<HTMLInputElement>('#add-step-label')!;
    labelField.value = '';
    addStepParams.innerHTML = renderStepTypeFields('tap');
    addStepDialog.showModal();
});

stepTypeSelect.addEventListener('change', () => {
    addStepParams.innerHTML = renderStepTypeFields(stepTypeSelect.value);
});

addStepSubmit.addEventListener('click', async (e) => {
    e.preventDefault();
    await addStep(stepTypeSelect.value);
});

stepUpdate.addEventListener('click', () => void updateSelectedStep());
stepDelete.addEventListener('click', () => void deleteSelectedStep());

// Register click handler to deselect step
document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest('#steps-list') && !target.closest('#step-detail')) {
        selectedStepId = null;
        stepDetail.style.display = 'none';
    }
});

// Device selector
deviceSelect.addEventListener('change', () => {
    void updateDeviceAssignment(deviceSelect.value);
});

// Initial load
async function init(): Promise<void> {
    const devices = await loadDevices();
    populateDeviceSelect(devices);
    await reloadWorkflow();
    connectStream();
}

void init();