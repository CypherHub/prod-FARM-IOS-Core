function element(selector) {
    const value = document.querySelector(selector);
    if (!value)
        throw new Error(`Missing element: ${selector}`);
    return value;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
async function jsonRequest(url, options) {
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok)
        throw new Error(data.error ?? `Request failed (${response.status})`);
    return data;
}
function pad(value) {
    return String(value).padStart(2, '0');
}
/** Format a Date as the local `YYYY-MM-DDTHH:mm` a datetime-local input expects. */
function toLocalInput(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/** Format a Date as the local `YYYY-MM-DD` a date input expects. */
function toLocalDate(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function formatWhen(value) {
    if (!value)
        return 'Immediately';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let size = bytes / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit += 1;
    }
    return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
}
const elements = {
    device: element('#batch-device'),
    account: element('#batch-account'),
    date: element('#batch-date'),
    slotMorning: element('#slot-morning'),
    slotAfternoon: element('#slot-afternoon'),
    slotEvening: element('#slot-evening'),
    caption: element('#batch-caption'),
    music: element('#batch-music'),
    publishConfirm: element('#batch-publish-confirm'),
    confirmPublish: element('#batch-confirm-publish'),
    applyDefaults: element('#apply-defaults'),
    shuffle: element('#shuffle-times'),
    dropZone: element('#drop-zone'),
    fileInput: element('#file-input'),
    queue: element('#queue'),
    queueEmpty: element('#queue-empty'),
    queueSummary: element('#queue-summary'),
    scheduleAll: element('#schedule-all'),
    scheduledList: element('#scheduled-list'),
    refreshScheduled: element('#refresh-scheduled'),
};
const STORE_KEYS = {
    device: 'schedule.device', account: 'schedule.account', destination: 'schedule.destination',
    slots: 'schedule.slots',
};
const SLOTS = [
    { id: 'morning', startMin: 9 * 60, endMin: 12 * 60 },
    { id: 'afternoon', startMin: 12 * 60, endMin: 16 * 60 },
    { id: 'evening', startMin: 16 * 60, endMin: 19 * 60 },
];
// Two posts on one device must clear the scheduler's conflict guard
// (SCHEDULER_MIN_TASK_GAP_MINUTES, default 10, + a post's ~1 min run ⇒ ≥ ~11 min
// start-to-start). One post per slot per day keeps posts hours apart anyway; this
// only matters at slot boundaries and against already-queued posts.
const MIN_GAP_MS = 12 * 60_000;
let devices = [];
const rows = [];
const rowElements = new Map();
let nextRowId = 1;
let busy = false;
let lastScheduled = [];
function readStore(key) {
    try {
        return window.localStorage.getItem(key);
    }
    catch {
        return null;
    }
}
function writeStore(key, value) {
    try {
        window.localStorage.setItem(key, value);
    }
    catch { /* private mode */ }
}
function selectedDestination() {
    const checked = document.querySelector('input[name="batch-destination"]:checked');
    return checked?.value === 'publish' ? 'publish' : 'draft';
}
function deviceByUdid(udid) {
    return devices.find((device) => device.udid === udid);
}
function fillAccountSelect(select, udid, selected) {
    const device = deviceByUdid(udid);
    const accounts = device?.accounts ?? [];
    select.replaceChildren();
    if (accounts.length === 0) {
        select.add(new Option('No accounts on this device', ''));
        select.disabled = true;
        return;
    }
    select.disabled = false;
    for (const account of accounts)
        select.add(new Option(account, account));
    select.value = accounts.includes(selected) ? selected : accounts[0];
}
function fillDeviceSelect(select, selected) {
    select.replaceChildren();
    for (const device of devices) {
        select.add(new Option(`${device.name}${device.connected ? '' : ' (offline)'}`, device.udid));
    }
    if (devices.some((device) => device.udid === selected))
        select.value = selected;
}
function slotCheckbox(slot) {
    if (slot.id === 'morning')
        return elements.slotMorning;
    if (slot.id === 'afternoon')
        return elements.slotAfternoon;
    return elements.slotEvening;
}
function selectedSlots() {
    return SLOTS.filter((slot) => slotCheckbox(slot).checked);
}
/**
 * Give every row the operator has not hand-edited (and not already scheduled) a
 * random time inside the next available slot. One post per selected slot per day
 * per device; when a day's slots are used up the fill rolls to the next day.
 * Posts on the same device are kept at least the min gap apart, and spaced clear
 * of the device's already-active scheduled posts.
 */
function assignTimes() {
    const slots = selectedSlots();
    const active = rows.filter((row) => row.status !== 'scheduled');
    if (slots.length === 0 || active.length === 0) {
        renderSummary();
        return;
    }
    const startBase = elements.date.value ? new Date(`${elements.date.value}T00:00`) : new Date();
    if (Number.isNaN(startBase.getTime())) {
        renderSummary();
        return;
    }
    startBase.setHours(0, 0, 0, 0);
    const now = Date.now();
    const gap = MIN_GAP_MS;
    // Seed each device's occupied start-times with the active posts already queued
    // (only known for the currently selected batch device).
    const occupied = new Map();
    const occupy = (udid, time) => {
        const list = occupied.get(udid) ?? [];
        list.push(time);
        list.sort((a, b) => a - b);
        occupied.set(udid, list);
    };
    for (const schedule of lastScheduled) {
        if (schedule.taskType !== 'post' || schedule.status !== 'active' || !schedule.nextRunAt)
            continue;
        const when = new Date(schedule.nextRunAt).getTime();
        if (!Number.isNaN(when))
            occupy(elements.device.value, when);
    }
    const bucketAt = (index) => {
        const dayOffset = Math.floor(index / slots.length);
        const slot = slots[index % slots.length];
        const day = new Date(startBase);
        day.setDate(day.getDate() + dayOffset);
        return {
            start: day.getTime() + slot.startMin * 60_000,
            end: day.getTime() + slot.endMin * 60_000,
        };
    };
    let bucketIndex = 0;
    const maxBuckets = active.length * slots.length + 500;
    for (const row of active) {
        // A hand-edited row keeps its time but still consumes one slot, so the
        // rest of the calendar stays one-per-slot and aligned.
        if (row.timeEdited) {
            const edited = row.runAt ? new Date(row.runAt).getTime() : NaN;
            if (!Number.isNaN(edited))
                occupy(row.deviceUdid, edited);
            bucketIndex += 1;
            continue;
        }
        let placed = false;
        while (bucketIndex < maxBuckets && !placed) {
            const bucket = bucketAt(bucketIndex);
            bucketIndex += 1;
            const winEnd = bucket.end - 60_000;
            let winStart = Math.max(bucket.start, now + 60_000);
            const times = occupied.get(row.deviceUdid) ?? [];
            const earlier = times.filter((time) => time <= winEnd + gap);
            if (earlier.length)
                winStart = Math.max(winStart, Math.max(...earlier) + gap);
            if (winStart >= winEnd)
                continue; // slot can't hold this row on this device — roll on
            let chosen = 0;
            for (let attempt = 0; attempt < 30; attempt += 1) {
                const candidate = Math.round((winStart + Math.random() * (winEnd - winStart)) / 60_000) * 60_000;
                if (!times.some((time) => Math.abs(time - candidate) < gap)) {
                    chosen = candidate;
                    break;
                }
            }
            if (!chosen)
                continue;
            occupy(row.deviceUdid, chosen);
            row.runAt = toLocalInput(new Date(chosen));
            const refs = rowElements.get(row.id);
            if (refs)
                refs.when.value = row.runAt;
            placed = true;
        }
        if (!placed) {
            row.runAt = '';
            const refs = rowElements.get(row.id);
            if (refs)
                refs.when.value = '';
        }
    }
    renderSummary();
}
function renderSummary() {
    const pending = rows.filter((row) => row.status !== 'scheduled').length;
    const scheduled = rows.filter((row) => row.status === 'scheduled').length;
    const failed = rows.filter((row) => row.status === 'failed').length;
    const noSlots = selectedSlots().length === 0;
    const parts = [];
    if (rows.length)
        parts.push(`${rows.length} in queue`);
    if (scheduled)
        parts.push(`${scheduled} scheduled`);
    if (failed)
        parts.push(`${failed} failed`);
    if (noSlots && rows.length) {
        parts.push('pick a time slot');
    }
    else {
        const days = [...new Set(rows.map((row) => row.runAt.slice(0, 10)).filter(Boolean))].sort();
        if (days.length) {
            const fmt = (value) => new Date(`${value}T00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
            parts.push(days.length === 1 ? fmt(days[0]) : `${fmt(days[0])} → ${fmt(days[days.length - 1])} (${days.length}d)`);
        }
    }
    elements.queueSummary.textContent = parts.join(' · ');
    elements.scheduleAll.textContent = pending > 0 ? `Schedule all (${pending})` : 'Schedule all';
    elements.scheduleAll.disabled = busy || pending === 0 || noSlots;
    elements.queueEmpty.hidden = rows.length > 0;
}
function applyRowStatus(row) {
    const refs = rowElements.get(row.id);
    if (!refs)
        return;
    const label = {
        ready: 'Ready', uploading: 'Uploading…', scheduled: 'Scheduled', failed: 'Failed',
    };
    const state = {
        ready: '', uploading: 'running', scheduled: 'succeeded', failed: 'failed',
    };
    refs.status.className = `status ${state[row.status]}`;
    refs.status.innerHTML = `<span class="dot"></span>${label[row.status]}${row.message ? ` · ${row.message}` : ''}`;
    const locked = row.status === 'scheduled' || row.status === 'uploading';
    refs.root.classList.toggle('is-scheduled', row.status === 'scheduled');
    for (const control of refs.root.querySelectorAll('input, select, textarea, button')) {
        if (control === refs.schedule)
            continue;
        control.disabled = locked;
    }
    refs.schedule.disabled = busy || row.status === 'uploading' || row.status === 'scheduled';
    refs.schedule.textContent = row.status === 'failed' ? 'Retry' : 'Schedule';
    renderSummary();
}
function renumber() {
    rows.forEach((row, index) => {
        const refs = rowElements.get(row.id);
        if (refs)
            refs.index.textContent = String(index + 1);
    });
}
function moveRow(id, delta) {
    const from = rows.findIndex((row) => row.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= rows.length)
        return;
    const [row] = rows.splice(from, 1);
    rows.splice(to, 0, row);
    for (const item of rows) {
        const refs = rowElements.get(item.id);
        if (refs)
            elements.queue.append(refs.root);
    }
    renumber();
    assignTimes();
}
function removeRow(id) {
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0)
        return;
    const [row] = rows.splice(index, 1);
    URL.revokeObjectURL(row.objectUrl);
    rowElements.get(id)?.root.remove();
    rowElements.delete(id);
    renumber();
    assignTimes();
}
function buildRow(row) {
    const root = document.createElement('article');
    root.className = 'queue-row';
    const index = document.createElement('span');
    index.className = 'queue-index';
    const previewWrap = document.createElement('div');
    previewWrap.className = 'queue-preview';
    const video = document.createElement('video');
    video.src = row.objectUrl;
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.controls = true;
    previewWrap.append(video);
    const meta = document.createElement('p');
    meta.className = 'queue-file';
    meta.textContent = `${row.file.name} · ${formatBytes(row.file.size)}`;
    video.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(video.duration)) {
            meta.textContent = `${row.file.name} · ${formatBytes(row.file.size)} · ${Math.round(video.duration)}s`;
            // Nudge past 0 so the element paints a real poster frame, not black.
            try {
                video.currentTime = Math.min(0.1, video.duration / 2);
            }
            catch { /* ignore */ }
        }
    });
    const previewCol = document.createElement('div');
    previewCol.className = 'queue-preview-col';
    previewCol.append(previewWrap, meta);
    const fields = document.createElement('div');
    fields.className = 'queue-fields';
    const caption = document.createElement('textarea');
    caption.className = 'queue-caption';
    caption.maxLength = 2200;
    caption.placeholder = 'Caption';
    caption.value = row.caption;
    const counter = document.createElement('span');
    counter.className = 'queue-counter';
    const updateCounter = () => { counter.textContent = `${caption.value.length}/2200`; };
    updateCounter();
    caption.addEventListener('input', () => { row.caption = caption.value; updateCounter(); });
    const captionWrap = document.createElement('label');
    captionWrap.className = 'queue-field';
    captionWrap.append(caption, counter);
    const music = document.createElement('input');
    music.type = 'url';
    music.placeholder = 'TikTok sound URL (optional)';
    music.value = row.music;
    music.addEventListener('input', () => { row.music = music.value; });
    const inline = document.createElement('div');
    inline.className = 'queue-inline';
    const account = document.createElement('select');
    account.className = 'queue-account';
    fillAccountSelect(account, row.deviceUdid, row.account);
    row.account = account.value;
    account.addEventListener('change', () => { row.account = account.value; });
    const device = document.createElement('select');
    device.className = 'queue-device';
    fillDeviceSelect(device, row.deviceUdid);
    device.addEventListener('change', () => {
        row.deviceUdid = device.value;
        fillAccountSelect(account, row.deviceUdid, row.account);
        row.account = account.value;
    });
    const when = document.createElement('input');
    when.type = 'datetime-local';
    when.className = 'queue-when';
    when.value = row.runAt;
    when.addEventListener('input', () => {
        row.timeEdited = true;
        row.runAt = when.value;
        renderSummary();
    });
    inline.append(labelled('Account', account), labelled('Device', device), labelled('When', when));
    fields.append(captionWrap, labelled('Sound', music), inline);
    const side = document.createElement('div');
    side.className = 'queue-side';
    const status = document.createElement('span');
    status.className = 'status';
    const scheduleButton = document.createElement('button');
    scheduleButton.type = 'button';
    scheduleButton.className = 'button secondary';
    scheduleButton.textContent = 'Schedule';
    scheduleButton.addEventListener('click', () => { void scheduleRow(row); });
    const reorder = document.createElement('div');
    reorder.className = 'queue-reorder';
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'icon-button';
    up.textContent = '↑';
    up.title = 'Move earlier';
    up.addEventListener('click', () => moveRow(row.id, -1));
    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'icon-button';
    down.textContent = '↓';
    down.title = 'Move later';
    down.addEventListener('click', () => moveRow(row.id, 1));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => removeRow(row.id));
    reorder.append(up, down, remove);
    side.append(status, scheduleButton, reorder);
    root.append(index, previewCol, fields, side);
    elements.queue.append(root);
    rowElements.set(row.id, { root, index, account, device, when, status, schedule: scheduleButton, up, down });
    applyRowStatus(row);
}
function labelled(text, control) {
    const wrap = document.createElement('label');
    wrap.className = 'queue-field';
    const span = document.createElement('span');
    span.className = 'queue-field-label';
    span.textContent = text;
    wrap.append(span, control);
    return wrap;
}
function addFiles(files) {
    const videos = Array.from(files).filter((file) => file.type.startsWith('video/'));
    if (videos.length === 0)
        return;
    for (const file of videos) {
        const row = {
            id: nextRowId++,
            file,
            objectUrl: URL.createObjectURL(file),
            caption: elements.caption.value,
            music: elements.music.value,
            account: elements.account.value,
            deviceUdid: elements.device.value,
            runAt: '',
            timeEdited: false,
            status: 'ready',
            message: '',
        };
        rows.push(row);
        buildRow(row);
    }
    renumber();
    assignTimes();
}
function applyDefaultsToRows() {
    for (const row of rows) {
        if (row.status === 'scheduled' || row.status === 'uploading')
            continue;
        row.caption = elements.caption.value;
        row.music = elements.music.value;
        row.deviceUdid = elements.device.value;
        row.account = elements.account.value;
        row.timeEdited = false;
        const refs = rowElements.get(row.id);
        if (refs) {
            refs.root.querySelector('.queue-caption').value = row.caption;
            refs.root.querySelector('.queue-caption').dispatchEvent(new Event('input'));
            refs.root.querySelector('input[type="url"]').value = row.music;
            fillDeviceSelect(refs.device, row.deviceUdid);
            fillAccountSelect(refs.account, row.deviceUdid, row.account);
            row.account = refs.account.value;
        }
    }
    assignTimes();
}
function rowTiming(row) {
    if (!row.runAt)
        return { kind: 'now' };
    const date = new Date(row.runAt);
    if (Number.isNaN(date.getTime()))
        throw new Error('Pick a valid date and time');
    return { kind: 'once', runAt: date.toISOString() };
}
async function scheduleRow(row) {
    if (row.status === 'scheduled' || row.status === 'uploading')
        return;
    const destination = selectedDestination();
    if (destination === 'publish' && !elements.confirmPublish.checked) {
        row.status = 'failed';
        row.message = 'Confirm public publishing in the batch defaults first';
        applyRowStatus(row);
        return;
    }
    if (!row.account) {
        row.status = 'failed';
        row.message = 'This device has no TikTok account';
        applyRowStatus(row);
        return;
    }
    row.status = 'uploading';
    row.message = '';
    applyRowStatus(row);
    try {
        const form = new FormData();
        form.append('media', row.file, row.file.name);
        form.append('destination', destination);
        form.append('account', row.account);
        form.append('caption', row.caption);
        form.append('musicUrl', row.music);
        form.append('timing', JSON.stringify(rowTiming(row)));
        form.append('recurringPublishConfirmed', 'false');
        const response = await fetch(`/api/devices/${encodeURIComponent(row.deviceUdid)}/posts`, { method: 'POST', body: form });
        const data = await response.json();
        if (!response.ok)
            throw new Error(data.error ?? `Request failed (${response.status})`);
        row.status = 'scheduled';
        row.scheduleId = data.id;
        row.message = data.nextRunAt ? `next ${new Date(data.nextRunAt).toLocaleString()}` : 'queued';
    }
    catch (error) {
        row.status = 'failed';
        row.message = errorMessage(error);
    }
    applyRowStatus(row);
}
async function scheduleAll() {
    if (busy)
        return;
    const destination = selectedDestination();
    if (destination === 'publish' && !elements.confirmPublish.checked) {
        elements.queueSummary.textContent = 'Confirm public publishing before scheduling.';
        return;
    }
    busy = true;
    renderSummary();
    for (const row of rows) {
        if (row.status === 'scheduled')
            continue;
        await scheduleRow(row);
    }
    busy = false;
    renderSummary();
    for (const row of rows)
        applyRowStatus(row);
    await loadScheduled();
}
function timingDescription(timing) {
    if (timing.kind === 'once')
        return `Once · ${formatWhen(timing.runAt ?? '')}`;
    if (timing.kind === 'daily')
        return `Daily · ${timing.localTime ?? '—'}`;
    if (timing.kind === 'weekly') {
        const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const days = timing.weekdays?.map((day) => names[day] ?? String(day)).join(', ') || 'no days';
        return `Weekly ${days} · ${timing.localTime ?? '—'}`;
    }
    return 'Immediately';
}
function musicHost(url) {
    if (!url)
        return '';
    try {
        return new URL(url).pathname.replace(/^\/+/, '').slice(0, 40) || 'sound';
    }
    catch {
        return 'sound';
    }
}
async function actOnSchedule(id, action) {
    try {
        await jsonRequest(`/api/schedules/${id}/${action}`, { method: 'POST' });
        await loadScheduled();
    }
    catch (error) {
        window.alert(errorMessage(error));
    }
}
function renderScheduled(schedules) {
    const posts = schedules
        .filter((schedule) => schedule.taskType === 'post')
        .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    if (posts.length === 0) {
        elements.scheduledList.className = 'task-list empty-state';
        elements.scheduledList.textContent = 'No scheduled posts on this device yet.';
        return;
    }
    elements.scheduledList.className = 'task-list';
    elements.scheduledList.replaceChildren(...posts.map((schedule) => {
        const row = document.createElement('article');
        row.className = 'task-row';
        const copy = document.createElement('div');
        const title = document.createElement('h3');
        const destination = schedule.payload.destination === 'publish' ? 'Publish' : 'Draft';
        title.textContent = schedule.payload.account ? `${destination} · ${schedule.payload.account}` : destination;
        const meta = document.createElement('p');
        const bits = [
            timingDescription(schedule.timing),
            `${schedule.payload.media?.length ?? 0} media`,
        ];
        if (schedule.payload.caption)
            bits.push(`“${schedule.payload.caption.slice(0, 60)}”`);
        if (schedule.payload.musicUrl)
            bits.push(`♪ ${musicHost(schedule.payload.musicUrl)}`);
        if (schedule.nextRunAt)
            bits.push(`next ${new Date(schedule.nextRunAt).toLocaleString()}`);
        meta.textContent = bits.join(' · ');
        copy.append(title, meta);
        const state = document.createElement('span');
        state.className = `status ${schedule.status}`;
        state.innerHTML = `<span class="dot"></span>${schedule.status}`;
        const actions = document.createElement('div');
        actions.className = 'inline-actions';
        if (schedule.status === 'active' || schedule.status === 'paused') {
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'icon-button';
            toggle.textContent = schedule.status === 'active' ? 'Pause' : 'Resume';
            toggle.addEventListener('click', () => void actOnSchedule(schedule.id, schedule.status === 'active' ? 'pause' : 'resume'));
            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.className = 'icon-button';
            cancel.textContent = 'Cancel';
            cancel.addEventListener('click', () => void actOnSchedule(schedule.id, 'cancel'));
            actions.append(toggle, cancel);
        }
        row.append(copy, state, actions);
        return row;
    }));
}
async function loadScheduled() {
    const udid = elements.device.value;
    if (!udid)
        return;
    try {
        const data = await jsonRequest(`/api/schedules?deviceUdid=${encodeURIComponent(udid)}`);
        lastScheduled = data.schedules;
        renderScheduled(data.schedules);
        assignTimes();
    }
    catch (error) {
        elements.scheduledList.className = 'task-list empty-state';
        elements.scheduledList.textContent = errorMessage(error);
    }
}
function updatePublishConfirm() {
    const publishing = selectedDestination() === 'publish';
    elements.publishConfirm.classList.toggle('visible', publishing);
    if (!publishing)
        elements.confirmPublish.checked = false;
    writeStore(STORE_KEYS.destination, selectedDestination());
}
async function init() {
    elements.date.value = toLocalDate(new Date());
    elements.date.min = toLocalDate(new Date());
    elements.dropZone.addEventListener('dragover', (event) => { event.preventDefault(); elements.dropZone.classList.add('dragover'); });
    elements.dropZone.addEventListener('dragleave', () => elements.dropZone.classList.remove('dragover'));
    elements.dropZone.addEventListener('drop', (event) => {
        event.preventDefault();
        elements.dropZone.classList.remove('dragover');
        if (event.dataTransfer?.files)
            addFiles(event.dataTransfer.files);
    });
    elements.fileInput.addEventListener('change', () => {
        if (elements.fileInput.files)
            addFiles(elements.fileInput.files);
        elements.fileInput.value = '';
    });
    elements.date.addEventListener('input', assignTimes);
    for (const box of [elements.slotMorning, elements.slotAfternoon, elements.slotEvening]) {
        box.addEventListener('change', () => {
            writeStore(STORE_KEYS.slots, selectedSlots().map((slot) => slot.id).join(','));
            assignTimes();
        });
    }
    elements.shuffle.addEventListener('click', assignTimes);
    elements.applyDefaults.addEventListener('click', applyDefaultsToRows);
    elements.scheduleAll.addEventListener('click', () => void scheduleAll());
    elements.refreshScheduled.addEventListener('click', () => void loadScheduled());
    for (const radio of document.querySelectorAll('input[name="batch-destination"]')) {
        radio.addEventListener('change', updatePublishConfirm);
    }
    elements.device.addEventListener('change', () => {
        writeStore(STORE_KEYS.device, elements.device.value);
        fillAccountSelect(elements.account, elements.device.value, readStore(STORE_KEYS.account) ?? '');
        void loadScheduled();
    });
    elements.account.addEventListener('change', () => writeStore(STORE_KEYS.account, elements.account.value));
    try {
        const raw = await jsonRequest('/api/devices');
        devices = raw
            .filter((device) => !device.disabled)
            .map((device) => ({
            udid: device.udid,
            name: device.name,
            connected: Boolean(device.connected),
            accounts: Object.values(device.pluginData ?? {}).flatMap((value) => (Array.isArray(value?.accounts) ? value.accounts.filter((entry) => typeof entry === 'string') : [])),
        }));
    }
    catch (error) {
        elements.queueSummary.textContent = errorMessage(error);
    }
    if (devices.length === 0) {
        elements.device.add(new Option('No active devices', ''));
        elements.account.add(new Option('—', ''));
        elements.scheduledList.className = 'task-list empty-state';
        elements.scheduledList.textContent = 'Register and enable a device first.';
        return;
    }
    fillDeviceSelect(elements.device, readStore(STORE_KEYS.device) ?? '');
    fillAccountSelect(elements.account, elements.device.value, readStore(STORE_KEYS.account) ?? '');
    const storedDestination = readStore(STORE_KEYS.destination);
    if (storedDestination === 'publish') {
        const publish = document.querySelector('input[name="batch-destination"][value="publish"]');
        if (publish)
            publish.checked = true;
    }
    const storedSlots = readStore(STORE_KEYS.slots);
    if (storedSlots !== null) {
        const ids = new Set(storedSlots.split(',').filter(Boolean));
        elements.slotMorning.checked = ids.has('morning');
        elements.slotAfternoon.checked = ids.has('afternoon');
        elements.slotEvening.checked = ids.has('evening');
    }
    updatePublishConfirm();
    renderSummary();
    await loadScheduled();
}
void init();
export {};
