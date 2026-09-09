import { inject } from './support.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// registry.ts freezes DEVICES_CONFIG_PATH at first import — set it before any
// src module loads, then pull everything in dynamically.
const directory = await mkdtemp(path.join(os.tmpdir(), 'pf-schedule-'));
const configPath = path.join(directory, 'devices.json');
await writeFile(configPath, JSON.stringify([
    { name: 'Nu Work', udid: 'sched-device', pluginData: { 'com.git-agni.tiktok': { accounts: ['@pixl.robotics', '@my_sane_tea'] } } },
]));
process.env.DEVICES_CONFIG_PATH = configPath;
process.env.SCHEDULER_DATA_DIR = path.join(directory, 'scheduler-data');

const { createApp } = await import('../src/api/app.js');
const { defaultDashboardTheme } = await import('../src/dashboard-theme.js');
const { PluginRegistry } = await import('../src/registry.js');
const { createTikTokPlugin } = await import('../src/tiktok-plugin.js');
type SchedulerRepository = import('../src/scheduler/repository.js').SchedulerRepository;
type CreateTaskInput = import('../src/types.js').CreateTaskInput;

interface RegisterAssetsInput { originalName: string; mimeType: string; size: number; sha256: string }

function fakeScheduler() {
    const calls: { registerAssets: RegisterAssetsInput[][]; createTask: CreateTaskInput[] } = { registerAssets: [], createTask: [] };
    const scheduler = {
        async activeExecution() { return null; },
        async listSchedules() { return []; },
        async deleteAssets() { /* noop */ },
        async registerAssets(files: RegisterAssetsInput[]) {
            calls.registerAssets.push(files);
            return files.map((file, index) => ({ id: `asset-${index}`, name: file.originalName, mimeType: file.mimeType }));
        },
        async createTask(input: CreateTaskInput) {
            calls.createTask.push(input);
            return {
                id: 'sched-1', deviceUdid: input.deviceUdid, pluginId: input.task.pluginId,
                taskType: input.task.taskType, taskVersion: input.task.taskVersion,
                payload: input.task.payload, timing: input.timing, status: 'active',
                runWindowMinutes: input.runWindowMinutes ?? 30,
                nextRunAt: new Date('2030-01-01T09:00:00.000Z'),
                createdAt: new Date(), updatedAt: new Date(),
            };
        },
    } as unknown as SchedulerRepository;
    return { scheduler, calls };
}

function multipartBody(parts: Array<{ name: string; value?: string; filename?: string; contentType?: string; data?: Buffer }>) {
    const boundary = `----pf${Math.random().toString(16).slice(2)}`;
    const chunks: Buffer[] = [];
    for (const part of parts) {
        let head = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
        if (part.filename) head += `; filename="${part.filename}"`;
        head += '\r\n';
        if (part.contentType) head += `Content-Type: ${part.contentType}\r\n`;
        head += '\r\n';
        chunks.push(Buffer.from(head, 'utf8'), part.data ?? Buffer.from(part.value ?? '', 'utf8'), Buffer.from('\r\n', 'utf8'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
    return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

test('serves the batch schedule page and its script, and links to it from the nav', async (context) => {
    const { scheduler } = fakeScheduler();
    const app = await createApp({
        plugins: new PluginRegistry([createTikTokPlugin({ postEntrypoint: '/example/post.js' })]),
        scheduler, dashboardTheme: defaultDashboardTheme,
    });
    context.after(() => app.close());

    const page = await inject(app, { method: 'GET', url: '/schedule' });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /id="drop-zone"/);
    assert.match(page.body, /\/assets\/schedule\.js\?v=[\w-]+/);

    const script = await inject(app, { method: 'GET', url: '/assets/schedule.js' });
    assert.equal(script.statusCode, 200);
    assert.match(String(script.headers['content-type']), /javascript/);
    assert.match(script.body, /api\/devices\//);

    for (const url of ['/', '/tasks', '/schedule']) {
        const res = await inject(app, { method: 'GET', url });
        assert.match(res.body, /href="\/schedule"/, url);
    }
});

test('the queue submit path schedules a draft post with staggered once timing', async (context) => {
    const { scheduler, calls } = fakeScheduler();
    const app = await createApp({
        plugins: new PluginRegistry([createTikTokPlugin({ postEntrypoint: '/example/post.js' })]),
        scheduler, dashboardTheme: defaultDashboardTheme,
    });
    context.after(() => app.close());

    const runAt = new Date('2030-06-01T09:15:00.000Z').toISOString();
    const { body, contentType } = multipartBody([
        { name: 'media', filename: 'render.mp4', contentType: 'video/mp4', data: Buffer.from('fake-mp4-bytes') },
        { name: 'destination', value: 'draft' },
        { name: 'account', value: '@pixl.robotics' },
        { name: 'caption', value: 'day two ☕' },
        { name: 'musicUrl', value: '' },
        { name: 'timing', value: JSON.stringify({ kind: 'once', runAt }) },
        { name: 'runWindowMinutes', value: '30' },
        { name: 'recurringPublishConfirmed', value: 'false' },
    ]);

    const res = await inject(app, {
        method: 'POST', url: '/api/devices/sched-device/posts',
        headers: { 'content-type': contentType }, payload: body,
    });

    assert.equal(res.statusCode, 202, res.body);
    assert.equal(res.json().id, 'sched-1');

    assert.equal(calls.registerAssets.length, 1);
    assert.equal(calls.registerAssets[0]![0]!.originalName, 'render.mp4');
    assert.equal(calls.registerAssets[0]![0]!.mimeType, 'video/mp4');

    assert.equal(calls.createTask.length, 1);
    const input = calls.createTask[0]!;
    assert.equal(input.deviceUdid, 'sched-device');
    assert.equal(input.task.taskType, 'post');
    assert.deepEqual(input.timing, { kind: 'once', runAt });
    const payload = input.task.payload as { destination: string; account: string; caption?: string; media: Array<{ name: string }> };
    assert.equal(payload.destination, 'draft');
    assert.equal(payload.account, '@pixl.robotics');
    assert.equal(payload.caption, 'day two ☕');
    assert.equal(payload.media[0]!.name, 'render.mp4');
});

test('a post with no draft/publish choice is rejected before scheduling', async (context) => {
    const { scheduler, calls } = fakeScheduler();
    const app = await createApp({
        plugins: new PluginRegistry([createTikTokPlugin({ postEntrypoint: '/example/post.js' })]),
        scheduler, dashboardTheme: defaultDashboardTheme,
    });
    context.after(() => app.close());

    const { body, contentType } = multipartBody([
        { name: 'media', filename: 'render.mp4', contentType: 'video/mp4', data: Buffer.from('fake-mp4-bytes') },
        { name: 'account', value: '@pixl.robotics' },
        { name: 'timing', value: JSON.stringify({ kind: 'now' }) },
    ]);
    const res = await inject(app, {
        method: 'POST', url: '/api/devices/sched-device/posts',
        headers: { 'content-type': contentType }, payload: body,
    });
    assert.equal(res.statusCode, 400);
    assert.equal(calls.createTask.length, 0);
});
