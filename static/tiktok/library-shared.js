// Helpers shared by the library pages. Served by the TikTok plugin at
// /assets/library-shared.js so the pages stay build-step free.

export const element = (selector, root = document) => {
    const node = root.querySelector(selector);
    if (!node) throw new Error(`Missing element ${selector}`);
    return node;
};

export const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

export async function jsonRequest(url, init = {}) {
    const response = await fetch(url, {
        ...init,
        headers: init.body ? { 'content-type': 'application/json', ...init.headers } : init.headers,
    });
    if (response.status === 204) return null;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
    return payload;
}

export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
));

export const number = (value) => (typeof value === 'number' ? value.toLocaleString() : '—');
export const seconds = (value) => (typeof value === 'number' ? `${Math.round(value * 100) / 100}s` : null);
export const duration = (value) => (typeof value === 'number' ? `${Math.round(value * 10) / 10}s` : '');
export const when = (value) => (value ? new Date(value).toLocaleString() : null);

export function showError(node, error) {
    node.textContent = error ? errorMessage(error) : '';
    node.hidden = !error;
}

/** The `udid|account` pairs the post task needs, from every enabled device. */
export function deviceOptions(devices) {
    return devices.filter((device) => !device.disabled).map((device) => {
        const accounts = device.pluginData?.['com.git-agni.tiktok']?.accounts ?? [];
        return accounts.map((account) =>
            `<option value="${escapeHtml(device.udid)}|${escapeHtml(account)}">${escapeHtml(device.name)} · ${escapeHtml(account)}</option>`).join('');
    }).join('');
}

/** Only galleries that can actually serve this bookmark's kind. */
export function galleryOptions(galleries, kind, selected = '') {
    const usable = galleries.filter((gallery) => (kind === 'video' ? gallery.videos > 0 : gallery.images > 0));
    if (usable.length === 0) {
        return `<option value="">No gallery with ${kind === 'video' ? 'clips' : 'images'} — upload some first</option>`;
    }
    return usable.map((gallery) => {
        const counts = kind === 'video' ? `${gallery.videos} clip(s)` : `${gallery.images} image(s)`;
        return `<option value="${escapeHtml(gallery.name)}" ${gallery.name === selected ? 'selected' : ''}>${escapeHtml(gallery.name)} · ${counts}</option>`;
    }).join('');
}

export async function loadDevices() {
    try {
        const payload = await jsonRequest('/api/devices');
        return payload.devices ?? payload ?? [];
    } catch { return []; }
}

export async function loadGalleries() {
    try { return (await jsonRequest('/api/gallery')).galleries ?? []; } catch { return []; }
}

export const param = (name) => new URLSearchParams(location.search).get(name);
