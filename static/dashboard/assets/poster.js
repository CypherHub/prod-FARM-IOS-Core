const statusEl = document.querySelector('#poster-status');
const toggleBtn = document.querySelector('#toggle-enabled');
const windowMeta = document.querySelector('#window-meta');
const accountList = document.querySelector('#account-list');
const historyList = document.querySelector('#history-list');
let snapshot = null;
let saving = false;
async function request(url, options) {
    const response = await fetch(url, options);
    const body = await response.json();
    if (!response.ok)
        throw new Error(body.error ?? `Request failed (${response.status})`);
    return body;
}
function jsonRequest(url, method, body) {
    return request(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}
function formatTime(value) {
    if (!value)
        return '—';
    return new Date(value).toLocaleString();
}
function heartbeatFresh(iso, nowIso) {
    if (!iso || !nowIso)
        return false;
    return Date.parse(nowIso) - Date.parse(iso) < 90_000;
}
function slotLabel(id) {
    return snapshot?.slots.find((slot) => slot.id === id)?.label ?? id;
}
function openSummary() {
    if (!snapshot)
        return 'none';
    const parts = [];
    for (const handle of snapshot.handles) {
        const open = snapshot.openWindows[handle] ?? [];
        if (!open.length)
            continue;
        parts.push(`${handle} ${open.map(slotLabel).join(', ')}`);
    }
    return parts.join(' · ') || 'none';
}
function renderStatus() {
    if (!snapshot)
        return;
    const { config, state, now } = snapshot;
    const live = heartbeatFresh(state.heartbeatAt, now);
    const action = state.currentAction;
    const parts = [];
    parts.push(config.enabled ? 'Running' : 'Paused');
    parts.push(live ? 'worker live' : 'worker not seen');
    const open = openSummary();
    parts.push(open === 'none' ? 'outside selected windows' : `in ${open}`);
    if (action)
        parts.push(`${action.step} ${action.handle}`);
    statusEl.textContent = parts.join(' · ');
    toggleBtn.textContent = config.enabled ? 'Pause' : 'Resume';
    toggleBtn.className = config.enabled ? 'button secondary' : 'button primary';
    windowMeta.textContent = `New York time · local date ${snapshot.localDate} · currently open: ${open}`;
}
function workflowLine(label, found) {
    return found ? `${label}: ${found.name}` : `${label}: missing workflow`;
}
function todayLine(handle) {
    const windows = snapshot?.config.accounts[handle]?.windows ?? [];
    if (!windows.length)
        return 'No windows selected';
    const open = new Set(snapshot?.openWindows[handle] ?? []);
    return windows.map((windowId) => {
        const slot = snapshot?.today[handle]?.[windowId];
        if (slot?.status === 'succeeded')
            return `${windowId} ✓`;
        if (slot?.plannedAt && slot.status !== 'failed') {
            return `${windowId} at ${new Date(slot.plannedAt).toLocaleTimeString()}`;
        }
        if (slot?.status === 'failed')
            return `${windowId} retry`;
        return `${windowId}${open.has(windowId) ? ' open' : ' —'}`;
    }).join(' · ');
}
function windowChoices(handle, selected) {
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
            if (saving)
                return;
            const windows = [...options.querySelectorAll('input[type="checkbox"]')]
                .filter((box) => box.checked)
                .map((box) => box.value);
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
function renderAccounts() {
    if (!snapshot)
        return;
    accountList.className = 'poster-accounts';
    accountList.replaceChildren(...snapshot.handles.map((handle) => {
        const account = snapshot.config.accounts[handle];
        const found = snapshot.workflows[handle];
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
            void request(`/api/poster/accounts/${encodeURIComponent(handle)}/run-now`, { method: 'POST' })
                .then(() => load())
                .catch(showError);
        });
        actions.append(enable, postNow);
        card.append(copy, actions);
        return card;
    }));
}
function renderHistory() {
    if (!snapshot)
        return;
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
function showError(error) {
    window.alert(error instanceof Error ? error.message : String(error));
}
async function saveConfig(patch) {
    saving = true;
    try {
        await jsonRequest('/api/poster', 'PUT', patch);
        await load();
    }
    finally {
        saving = false;
    }
}
function render() {
    renderStatus();
    renderAccounts();
    renderHistory();
}
async function load() {
    snapshot = await request('/api/poster');
    render();
}
toggleBtn.addEventListener('click', () => {
    if (!snapshot)
        return;
    void saveConfig({ enabled: !snapshot.config.enabled }).catch(showError);
});
void load().catch(showError);
setInterval(() => { if (!saving)
    void load().catch(() => { }); }, 5_000);
export {};
