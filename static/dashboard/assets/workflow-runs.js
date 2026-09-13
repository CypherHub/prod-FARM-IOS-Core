const API = '/api/workflow-runs';
const WF_API = '/api/workflows';
const listEl = document.getElementById('run-list');
const refreshBtn = document.getElementById('refresh-runs');
const filterWf = document.getElementById('filter-workflow');
const filterStatus = document.getElementById('filter-status');
const paginationEl = document.getElementById('pagination');
const detailModal = document.getElementById('run-detail-modal');
const detailBody = document.getElementById('detail-body');
const detailTitle = document.getElementById('detail-title');
const detailClose = document.getElementById('detail-close');

let currentPage = 0;
const PAGE_SIZE = 30;

async function api(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error((await r.json().catch(() => ({error: r.statusText}))).error || r.statusText);
    return r.json();
}

function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString();
}

function fmtDuration(startIso, endIso) {
    if (!startIso) return '—';
    const start = new Date(startIso).getTime();
    const end = endIso ? new Date(endIso).getTime() : Date.now();
    const diff = end - start;
    if (diff < 1000) return diff + 'ms';
    return (diff / 1000).toFixed(1) + 's';
}

function statusBadge(s) {
    return '<span class="status ' + s + '"><span class="dot"></span>' + s + '</span>';
}

function renderRun(run) {
    const article = document.createElement('article');
    article.className = 'task-row wf-run';
    article.dataset.runId = run.id;

    const copy = document.createElement('div');
    const title = document.createElement('h3');
    title.innerHTML = statusBadge(run.status) + ' ' + (run.workflowName || 'Unknown') + ' <span style="font-weight:400;font-size:13px;color:var(--fg-3)">· ' + fmtDate(run.startedAt) + '</span>';
    const meta = document.createElement('p');
    meta.style.cssText = 'color:var(--fg-3);font-size:12px';
    meta.textContent = (run.deviceUdid ? run.deviceUdid.slice(0, 8) + '…' : '—') + ' · ' + run.totalSteps + ' steps · ' + fmtDuration(run.startedAt, run.finishedAt);

    const preview = document.createElement('div');
    preview.className = 'log-preview';
    const logs = typeof run.logs === 'string' ? JSON.parse(run.logs) : (run.logs || []);
    const lastLogs = logs.slice(-3);
    for (const l of lastLogs) {
        const span = document.createElement('span');
        span.textContent = l.message;
        preview.appendChild(span);
    }

    copy.append(title, meta, preview);
    const actions = document.createElement('div');
    actions.className = 'inline-actions';
    const btn = document.createElement('button');
    btn.className = 'button secondary';
    btn.type = 'button';
    btn.textContent = 'View logs';
    btn.addEventListener('click', (e) => { e.stopPropagation(); openDetail(run.id); });
    actions.appendChild(btn);
    article.append(copy, actions);

    article.addEventListener('click', () => openDetail(run.id));
    return article;
}

function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\u0008/g,'[BS]');
}

async function openDetail(runId) {
    detailModal.classList.add('open');
    detailBody.innerHTML = '<span class="spinner"></span> Loading…';
    try {
        const run = await api(API + '/' + runId);
        detailTitle.textContent = (run.workflowName || 'Workflow') + ' Run';
        const logs = typeof run.logs === 'string' ? JSON.parse(run.logs) : (run.logs || []);
        const isRunning = run.status === 'running';

        let html = '<dl class="run-meta-grid">';
        html += '<dt>Status</dt><dd>' + statusBadge(run.status) + '</dd>';
        html += '<dt>Workflow</dt><dd>' + (run.workflowName || 'Unknown') + '</dd>';
        html += '<dt>Device</dt><dd>' + (run.deviceUdid || '—') + '</dd>';
        html += '<dt>Steps</dt><dd>' + run.totalSteps + '</dd>';
        html += '<dt>Started</dt><dd>' + fmtDate(run.startedAt) + '</dd>';
        html += '<dt>Duration</dt><dd>' + fmtDuration(run.startedAt, run.finishedAt) + '</dd>';
        if (run.error) html += '<dt>Error</dt><dd style="color:var(--danger)">' + escapeHtml(run.error) + '</dd>';
        html += '</dl>';

        if (isRunning) {
            html += '<p style="color:var(--accent);font-weight:600">⏳ This run is still in progress — auto-refreshing every 3s.</p>';
        }

        html += '<h3 style="margin-bottom:8px">Logs (' + logs.length + ' entries)</h3>';
        html += '<div id="run-logs">';
        for (const log of logs) {
            const stepNum = log.step || 0;
            const msg = escapeHtml(log.message || '');
            const type = log.type || 'info';
            html += '<div class="log-entry ' + type + '"><span class="log-step">#' + stepNum + '</span>' + msg + '</div>';
        }
        if (!logs.length) html += '<p style="color:var(--fg-3)">No log entries recorded.</p>';
        html += '</div>';

        detailBody.innerHTML = html;

        if (isRunning) {
            // Auto-refresh the modal for in-progress runs
            setTimeout(function refreshIfOpen() {
                var m = document.getElementById('run-detail-modal');
                if (m && m.classList.contains('open')) {
                    openDetail(runId);
                }
            }, 3000);
        }
    } catch (err) {
        detailBody.innerHTML = '<p style="color:var(--danger)">Error: ' + escapeHtml(err.message || String(err)) + '</p>';
    }
}

async function loadRuns() {
    refreshBtn.disabled = true;
    try {
        const workflowFilter = filterWf.value;
        const statusFilter = filterStatus.value;
        let url = API + '?limit=' + PAGE_SIZE + '&offset=' + (currentPage * PAGE_SIZE);
        if (workflowFilter) url += '&workflowId=' + encodeURIComponent(workflowFilter);
        const data = await api(url);
        const runs = Array.isArray(data.runs) ? data.runs : [];

        // Client-side status filter (API doesn't support it yet)
        const filtered = statusFilter ? runs.filter(function(r) { return r.status === statusFilter; }) : runs;

        if (!filtered.length) {
            listEl.className = 'task-list empty-state';
            listEl.innerHTML = '<h2>No runs yet</h2><p>Run a workflow to see historical logs here.</p>';
            paginationEl.style.display = 'none';
            return;
        }
        listEl.className = 'task-list';
        listEl.replaceChildren.apply(listEl, filtered.map(renderRun));

        const total = data.total || filtered.length;
        const pages = Math.ceil(total / PAGE_SIZE);
        if (pages <= 1) { paginationEl.style.display = 'none'; return; }
        paginationEl.style.display = 'flex';
        paginationEl.innerHTML = '';
        if (currentPage > 0) {
            const prev = document.createElement('button');
            prev.className = 'button secondary'; prev.type = 'button';
            prev.textContent = '← Previous';
            prev.addEventListener('click', function() { currentPage--; loadRuns(); });
            paginationEl.appendChild(prev);
        }
        const span = document.createElement('span');
        span.style.cssText = 'font-size:13px;color:var(--fg-3)';
        span.textContent = 'Page ' + (currentPage + 1) + ' of ' + pages;
        paginationEl.appendChild(span);
        if (currentPage < pages - 1) {
            const next = document.createElement('button');
            next.className = 'button secondary'; next.type = 'button';
            next.textContent = 'Next →';
            next.addEventListener('click', function() { currentPage++; loadRuns(); });
            paginationEl.appendChild(next);
        }
    } catch (err) {
        listEl.className = 'task-list';
        listEl.innerHTML = '<p style="color:var(--danger)">' + (err.message || String(err)) + '</p>';
    } finally {
        refreshBtn.disabled = false;
    }
}

async function loadWorkflowFilter() {
    try {
        const data = await api(WF_API);
        const workflows = data.workflows || [];
        for (const wf of workflows) {
            const opt = document.createElement('option');
            opt.value = wf.id;
            opt.textContent = wf.name;
            filterWf.appendChild(opt);
        }
    } catch {}
}

// Event listeners
refreshBtn.addEventListener('click', loadRuns);
filterWf.addEventListener('change', function() { currentPage = 0; loadRuns(); });
filterStatus.addEventListener('change', function() { currentPage = 0; loadRuns(); });
detailClose.addEventListener('click', function() { detailModal.classList.remove('open'); });
detailModal.addEventListener('click', function(e) {
    if (e.target === detailModal) detailModal.classList.remove('open');
});

loadWorkflowFilter();
loadRuns();

// Poll active runs for status updates
setInterval(function() {
    const open = detailModal.classList.contains('open');
    if (open) return; // the timeout in openDetail handles its own refresh
    loadRuns();
}, 10000);

export {};