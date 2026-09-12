export {};

interface WorkflowEntry {
    id: string;
    name: string;
    description: string | null;
    deviceUdid: string | null;
    status: 'draft' | 'active' | 'completed' | 'archived';
    createdAt: string;
    updatedAt: string;
}

interface WorkflowWithSteps extends WorkflowEntry {
    steps: Array<{ id: string; stepType: string; stepOrder: number }>;
}

const listElement = document.querySelector<HTMLElement>('#workflow-list')!;
const refreshBtn = document.querySelector<HTMLButtonElement>('#refresh-workflows')!;
const createBtn = document.querySelector<HTMLButtonElement>('#create-workflow')!;
const createDialog = document.querySelector<HTMLDialogElement>('#create-dialog')!;
const createSubmit = document.querySelector<HTMLButtonElement>('#create-submit')!;

const API = '/api/workflows';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
    const response = await fetch(url, options);
    const body = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
    return body;
}

function button(label: string, action: () => Promise<void>): HTMLButtonElement {
    const value = document.createElement('button');
    value.className = 'icon-button'; value.type = 'button'; value.textContent = label;
    value.addEventListener('click', () => void action().catch((error) => {
        window.alert(error instanceof Error ? error.message : String(error));
    }));
    return value;
}

function shortDevice(udid: string | null): string {
    if (!udid) return '—';
    return udid.length > 20 ? `${udid.slice(0, 8)}…${udid.slice(-6)}` : udid;
}

function date(value: string): string {
    return new Date(value).toLocaleString();
}

function renderWorkflows(items: WorkflowEntry[]): void {
    if (!items.length) {
        listElement.className = 'task-list empty-state';
        listElement.innerHTML = '<h2>No workflows yet</h2><p>Create your first workflow to get started.</p>';
        return;
    }
    listElement.className = 'task-list';
    listElement.replaceChildren(...items.map((wf) => {
        const row = document.createElement('article'); row.className = 'task-row';
        const copy = document.createElement('div');
        const title = document.createElement('h3');
        title.textContent = `${wf.name} · ${wf.status} · device ${shortDevice(wf.deviceUdid)}`;
        const meta = document.createElement('p');
        meta.textContent = `${date(wf.createdAt)}${wf.description ? ` · ${wf.description}` : ''}`;
        copy.append(title, meta);

        const state = document.createElement('span');
        state.className = `status ${wf.status}`;
        state.textContent = wf.status;

        const actions = document.createElement('div');
        actions.className = 'inline-actions';
        actions.append(
            button('Edit', async () => { window.location.href = `/workflows/${wf.id}`; }),
            button('Replay', async () => {
                const result = await request<{ runId: string }>(`${API}/${wf.id}/replay`, { method: 'POST' });
                if (result.runId) window.location.href = `/workflows/${wf.id}`;
            }),
            button('Delete', async () => {
                if (!window.confirm(`Delete workflow "${wf.name}"?`)) return;
                await fetch(`${API}/${wf.id}`, { method: 'DELETE' });
                await load();
            }),
        );
        row.append(copy, state, actions);
        return row;
    }));
}

async function load(): Promise<void> {
    refreshBtn.disabled = true;
    try {
        const data = await request<{ workflows: WorkflowEntry[] }>(API);
        renderWorkflows(data.workflows);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        listElement.textContent = message;
    } finally { refreshBtn.disabled = false; }
}

createBtn.addEventListener('click', () => void createDialog.showModal());

createSubmit.addEventListener('click', async (e) => {
    e.preventDefault();
    const name = (document.querySelector<HTMLInputElement>('#wf-name')!).value.trim();
    const desc = (document.querySelector<HTMLTextAreaElement>('#wf-description')!).value.trim();
    const udid = (document.querySelector<HTMLInputElement>('#wf-udid')!).value.trim();
    if (!name) return;
    try {
        await request<WorkflowEntry>(API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name, description: desc || undefined, deviceUdid: udid || undefined }),
        });
        createDialog.close();
        // Reset form
        (document.querySelector<HTMLInputElement>('#wf-name')!).value = '';
        (document.querySelector<HTMLTextAreaElement>('#wf-description')!).value = '';
        (document.querySelector<HTMLInputElement>('#wf-udid')!).value = '';
        await load();
    } catch (error) {
        window.alert(error instanceof Error ? error.message : String(error));
    }
});

refreshBtn.addEventListener('click', () => void load());
void load();