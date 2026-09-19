export {};

interface PosterAccountConfig {
    enabled: boolean;
    windows: string[];
}

interface PosterSlotState {
    plannedAt?: string;
    status: 'pending' | 'succeeded' | 'failed';
    attempts: number;
    retryAfter?: string;
    switchRunId?: string;
    postRunId?: string;
    error?: string;
    finishedAt?: string;
}

interface PosterHistoryEntry {
    key: string;
    handle: string;
    windowId: string;
    status: string;
    switchRunId?: string;
    postRunId?: string;
    error?: string;
    finishedAt: string;
}

interface PosterSnapshot {
    config: {
        enabled: boolean;
        timezone: string;
        accounts: Record<string, PosterAccountConfig>;
    };
    state: {
        heartbeatAt?: string;
        currentAction?: {
            handle: string;
            windowId: string;
            step: string;
            runId?: string;
            startedAt: string;
        } | null;
        history: PosterHistoryEntry[];
        slots: Record<string, PosterSlotState>;
    };
    slots: Array<{ id: string; label: string }>;
    handles: string[];
    now: string;
    localDate: string;
    openWindows: Record<string, string[]>;
    workflows: Record<string, {
        switch: { id: string; name: string } | null;
        post: { id: string; name: string } | null;
    }>;
    today: Record<string, Record<string, PosterSlotState | null>>;
}

const statusEl = document.querySelector<HTMLElement>('#poster-status')!;
const toggleBtn = document.querySelector<HTMLButtonElement>('#toggle-enabled')!;
const windowMeta = document.querySelector<HTMLElement>('#window-meta')!;
const accountList = document.querySelector<HTMLElement>('#account-list')!;
const historyList = document.querySelector<HTMLElement>('#history-list')!;

let snapshot: PosterSnapshot | null = null;
let saving = false;

async function request<T>(url: string, options?: RequestInit): Promise<T> {
    const response = await fetch(url, options);
    const body = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
    return body;
}

function jsonRequest<T>(url: string, method: string, body?: unknown): Promise<T> {
    return request<T>(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

function formatTime(value?: string): string {
    if (!value) return '—';
    return new Date(value).toLocaleString();
}

function heartbeatFresh(iso?: string, nowIso?: string): boolean {
    if (!iso || !nowIso) return false;
    return Date.parse(nowIso) - Date.parse(iso) < 90_000;
}

function slotLabel(id: string): string {
    return snapshot?.slots.find((slot) => slot.id === id)?.label ?? id;
}

function openSummary(): string {
    if (!snapshot) return 'none';
    const parts: string[] = [];
    for (const handle of snapshot.handles) {
        const open = snapshot.openWindows[handle] ?? [];
        if (!open.length) continue;
        parts.push(`${handle} ${open.map(slotLabel).join(', ')}`);
    }
    return parts.join(' · ') || 'none';
}

function renderStatus(): void {
    if (!snapshot) return;
    const { config, state, now } = snapshot;
    const live = heartbeatFresh(state.heartbeatAt, now);
    const action = state.currentAction;
    const parts: string[] = [];
    parts.push(config.enabled ? 'Running' : 'Paused');
    parts.push(live ? 'worker live' : 'worker not seen');
    const open = openSummary();
    parts.push(open === 'none' ? 'outside selected windows' : `in ${open}`);
    if (action) parts.push(`${action.step} ${action.handle}`);
    statusEl.textContent = parts.join(' · ');
    toggleBtn.textContent = config.enabled ? 'Pause' : 'Resume';
    toggleBtn.className = config.enabled ? 'button secondary' : 'button primary';
    windowMeta.textContent = `New York time · local date ${snapshot.localDate} · currently open: ${open}`;
}

function workflowLine(label: string, found: { name: string } | null): string {
    return found ? `${label}: ${found.name}` : `${label}: missing workflow`;
}

function todayLine(handle: string): string {
    const windows = snapshot?.config.accounts[handle]?.windows ?? [];
    if (!windows.length) return 'No windows selected';
    const open = new Set(snapshot?.openWindows[handle] ?? []);
    return windows.map((windowId) => {
        const slot = snapshot?.today[handle]?.[windowId];
        if (slot?.status === 'succeeded') return `${windowId} ✓`;
        if (slot?.plannedAt && slot.status !== 'failed') {
            return `${windowId} at ${new Date(slot.plannedAt).toLocaleTimeString()}`;
        }
        if (slot?.status === 'failed') return `${windowId} retry`;
        return `${windowId}${open.has(windowId) ? ' open' : ' —'}`;
    }).join(' · ');
}

function windowChoices(handle: string, selected: readonly string[]): HTMLFieldSetElement {
    const field = document.createElement('fieldset');
    field.className = 'weekday-field poster-account-windows';
    const legend = document.createElement('legend');
    legend.textContent = 'Time windows';
    const options = document.createElement('div');
    options.className = 'weekday-options';
    for (const slot of snapshot?.slots ?? []) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = slot.id;
        input.checked = selected.includes(slot.id);
        input.addEventListener('change', () => {
            if (saving) return;
            const windows = [...options.querySelectorAll('input[type="checkbox"]')]
                .filter((box) => (box as HTMLInputElement).checked)
                .map((box) => (box as HTMLInputElement).value);
            void saveConfig({ accounts: { [handle]: { windows } } }).catch(showError);
        });
        const span = document.createElement('span');
        span.textContent = slot.label;
        label.append(input, span);
        options.append(label);
    }
    field.append(legend, options);
    return field;
}

function renderAccounts(): void {
    if (!snapshot) return;
    accountList.className = 'poster-accounts';
    accountList.replaceChildren(...snapshot.handles.map((handle) => {
        const account = snapshot!.config.accounts[handle];
        const found = snapshot!.workflows[handle];
        const card = document.createElement('article');
        card.className = 'poster-account';
        const copy = document.createElement('div');
        const title = document.createElement('h3');
        title.textContent = handle;
        const meta = document.createElement('p');
        meta.className = 'muted';
        meta.textContent = [
            workflowLine('Switch', found?.switch ?? null),
            workflowLine('Post', found?.post ?? null),
            todayLine(handle),
        ].join('\n');
        meta.style.whiteSpace = 'pre-wrap';
        copy.append(title, meta, windowChoices(handle, account?.windows ?? []));

        const actions = document.createElement('div');
        actions.className = 'inline-actions';
        const enable = document.createElement('button');
        enable.type = 'button';
        enable.className = 'button secondary';
        enable.textContent = account?.enabled ? 'Disable' : 'Enable';
        enable.addEventListener('click', () => {
            void saveConfig({ accounts: { [handle]: { enabled: !account?.enabled } } }).catch(showError);
        });
        const postNow = document.createElement('button');
        postNow.type = 'button';
        postNow.className = 'button primary';
        postNow.textContent = 'Post now';
        postNow.disabled = !account?.enabled || !found?.switch || !found?.post;
        postNow.addEventListener('click', () => {
            void request<{ ok: boolean }>(`/api/poster/accounts/${encodeURIComponent(handle)}/run-now`, { method: 'POST' })
                .then(() => load())
                .catch(showError);
        });
        actions.append(enable, postNow);
        card.append(copy, actions);
        return card;
    }));
}

function renderHistory(): void {
    if (!snapshot) return;
    const history = snapshot.state.history ?? [];
    if (!history.length) {
        historyList.className = 'task-list';
        historyList.innerHTML = '<div class="empty-state"><h2>No poster runs yet</h2><p>Resume the poster or tap Post now.</p></div>';
        return;
    }
    historyList.className = 'task-list';
    historyList.replaceChildren(...history.slice(0, 20).map((entry) => {
        const row = document.createElement('article');
        row.className = 'task-row';
        const copy = document.createElement('div');
        const title = document.createElement('h3');
        title.textContent = `${entry.handle} · ${entry.windowId} · ${entry.status}`;
        const meta = document.createElement('p');
        meta.textContent = `${formatTime(entry.finishedAt)}${entry.error ? ` · ${entry.error}` : ''}`;
        copy.append(title, meta);
        const status = document.createElement('span');
        status.className = `status ${entry.status}`;
        status.textContent = entry.status;
        row.append(copy, status);
        return row;
    }));
}

function showError(error: unknown): void {
    window.alert(error instanceof Error ? error.message : String(error));
}

async function saveConfig(patch: Record<string, unknown>): Promise<void> {
    saving = true;
    try {
        await jsonRequest('/api/poster', 'PUT', patch);
        await load();
    } finally {
        saving = false;
    }
}

function render(): void {
    renderStatus();
    renderAccounts();
    renderHistory();
}

async function load(): Promise<void> {
    snapshot = await request<PosterSnapshot>('/api/poster');
    render();
}

toggleBtn.addEventListener('click', () => {
    if (!snapshot) return;
    void saveConfig({ enabled: !snapshot.config.enabled }).catch(showError);
});

void load().catch(showError);
setInterval(() => { if (!saving) void load().catch(() => {}); }, 5_000);
