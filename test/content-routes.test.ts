import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';

// paths.ts reads SCHEDULER_DATA_DIR per call, but the media fixtures have to
// live under it, so pin it before building anything.
const directory = await mkdtemp(path.join(os.tmpdir(), 'pf-content-routes-'));
process.env.SCHEDULER_DATA_DIR = path.join(directory, 'scheduler-data');
process.env.CONTENT_GALLERY_DIR = path.join(directory, 'gallery');

const { registerContentRoutes } = await import('../src/content/routes.js');
const { ContentStateError } = await import('../src/content/repository.js');
const { ApifyNotConfiguredError } = await import('../src/content/apify.js');
type ContentRepository = import('../src/content/repository.js').ContentRepository;
type PluginRouteContext = import('../src/plugin.js').PluginRouteContext;

const readyBookmark = {
    id: 'bm-1', sourceUrl: 'https://www.tiktok.com/t/ZTUDXaRvQ', status: 'ready', kind: 'slideshow',
    caption: 'hello', musicUrl: 'https://www.tiktok.com/music/som-original-1', authorName: 'fashion.technically',
};

interface FakeState {
    outputDir?: string;
    bookmarkUrl?: (url: string) => Promise<unknown>;
    createGeneration?: () => Promise<unknown>;
    mediaRelativePath?: string | null;
}

async function buildApp(state: FakeState = {}): Promise<{ app: FastifyInstance; queued: unknown[]; created: Array<Record<string, unknown>> }> {
    const queued: unknown[] = [];
    const created: Array<Record<string, unknown>> = [];
    const repository = {
        async bookmarkUrl(url: string) {
            if (state.bookmarkUrl) return state.bookmarkUrl(url);
            return { bookmark: { ...readyBookmark, sourceUrl: url }, queued: true };
        },
        async listBookmarks() { return [readyBookmark]; },
        async bookmark(id: string) { return id === 'bm-1' ? readyBookmark : null; },
        async bookmarkDetail(id: string) { return id === 'bm-1' ? { ...readyBookmark, media: [] } : null; },
        async listGenerations() { return []; },
        async bookmarkMediaAt() {
            if (state.mediaRelativePath === null) return null;
            return { relativePath: state.mediaRelativePath ?? 'bookmarks/bm-1/slide-1.jpg', mimeType: 'image/jpeg' };
        },
        async createGeneration(input: Record<string, unknown>) {
            if (state.createGeneration) return state.createGeneration();
            created.push(input);
            return { id: `gen-${created.length}`, status: 'pending', ...input };
        },
        async createHookRun(input: Record<string, unknown>) { return { id: 'run-1', status: 'pending', ...input }; },
        async hookRun(id: string) { return id === 'run-1' ? { id, status: 'ready', hooks: ['a'] } : null; },
        async listHookRuns() { return [{ id: 'run-1', status: 'ready', hooks: ['a'] }]; },
        async updateHookRun(id: string, values: Record<string, unknown>) { return { id, ...values }; },
        async generation(id: string) {
            if (id === 'gen-ready') return { id, status: 'ready', outputDir: state.outputDir ?? null };
            return id === 'gen-1' ? { id, status: 'pending', outputDir: null } : null;
        },
        async updateGeneration(id: string, values: Record<string, unknown>) { return { id, ...values }; },
        async updateBookmark() { return readyBookmark; },
        async enqueueIngest(id: string) { queued.push(id); },
        async deleteBookmark() { /* noop */ },
    } as unknown as ContentRepository;

    const app = Fastify();
    // The gallery upload route uses request.parts(), so mirror createApp's
    // multipart registration rather than stubbing it.
    await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 20 } });
    const context = {
        app,
        scheduler: {} as PluginRouteContext['scheduler'],
        loadDevices: async () => [],
    } as unknown as PluginRouteContext;
    registerContentRoutes(context, repository);
    return { app, queued, created };
}

test('bookmarking a new URL returns 202 and an existing one returns 200', async () => {
    const { app } = await buildApp();
    const created = await app.inject({ method: 'POST', url: '/api/bookmarks', payload: { url: readyBookmark.sourceUrl } });
    assert.equal(created.statusCode, 202);

    const { app: second } = await buildApp({ bookmarkUrl: async () => ({ bookmark: readyBookmark, queued: false }) });
    const existing = await second.inject({ method: 'POST', url: '/api/bookmarks', payload: { url: readyBookmark.sourceUrl } });
    assert.equal(existing.statusCode, 200, 're-bookmarking should be idempotent, not a new ingest');
});

test('a bad URL is a 400 and a missing Apify token is a 503', async () => {
    const { app } = await buildApp({ bookmarkUrl: async () => { throw new ContentStateError('Only tiktok.com URLs can be bookmarked'); } });
    const bad = await app.inject({ method: 'POST', url: '/api/bookmarks', payload: { url: 'https://example.com' } });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.json().error, /tiktok\.com/);

    const { app: unconfigured } = await buildApp({ createGeneration: async () => { throw new ApifyNotConfiguredError(); } });
    const response = await unconfigured.inject({ method: 'POST', url: '/api/bookmarks/bm-1/generate', payload: {} });
    assert.equal(response.statusCode, 503);
    assert.match(response.json().error, /APIFY_API_TOKEN/);
});

test('unknown bookmarks and generations are 404', async () => {
    const { app } = await buildApp();
    assert.equal((await app.inject('/api/bookmarks/nope')).statusCode, 404);
    assert.equal((await app.inject('/api/generations/nope')).statusCode, 404);
});

test('the media route serves stored bytes but refuses a path that escapes the data root', async () => {
    const root = path.join(directory, 'scheduler-data');
    await mkdir(path.join(root, 'bookmarks', 'bm-1'), { recursive: true });
    await writeFile(path.join(root, 'bookmarks', 'bm-1', 'slide-1.jpg'), 'jpeg-bytes');

    const { app } = await buildApp();
    const ok = await app.inject('/api/bookmarks/bm-1/media/slide/1');
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers['content-type'], 'image/jpeg');
    assert.equal(ok.body, 'jpeg-bytes');

    // A stored path that climbs out of the data root must never be read.
    const { app: escaping } = await buildApp({ mediaRelativePath: '../../../../etc/passwd' });
    const blocked = await escaping.inject('/api/bookmarks/bm-1/media/slide/1');
    assert.equal(blocked.statusCode, 400);

    const badRole = await app.inject('/api/bookmarks/bm-1/media/secrets/1');
    assert.equal(badRole.statusCode, 400);

    const { app: missing } = await buildApp({ mediaRelativePath: null });
    assert.equal((await missing.inject('/api/bookmarks/bm-1/media/slide/9')).statusCode, 404);
});

test('generate with no hooks still makes one post, the model writing its own hook', async () => {
    const { app, created } = await buildApp();
    const response = await app.inject({ method: 'POST', url: '/api/bookmarks/bm-1/generate', payload: { galleryDir: 'gallery' } });
    assert.equal(response.statusCode, 202);
    assert.equal(response.json().generations.length, 1);
    assert.equal(created[0]?.hook, null, 'no chosen hook means the model writes one');
});

test('one generation is created per chosen hook, carrying the clip and batch', async () => {
    const { app, created } = await buildApp();
    const hooks = ['first hook', 'second hook', 'third hook'];
    const response = await app.inject({
        method: 'POST',
        url: '/api/bookmarks/bm-1/generate',
        payload: { gallery: 'nub-clips', hooks, galleryVideo: 'clip.mp4', hookRunId: 'run-1', deviceUdid: 'd1', account: '@me' },
    });
    assert.equal(response.statusCode, 202);
    assert.equal(response.json().generations.length, 3);
    assert.deepEqual(created.map((input) => input.hook), hooks);
    // The clip and the batch id are shared across every video in the batch.
    assert.ok(created.every((input) => input.galleryVideo === 'clip.mp4' && input.hookRunId === 'run-1'));
});

test('a batch larger than the cap is refused before anything is created', async () => {
    const { app, created } = await buildApp();
    const response = await app.inject({
        method: 'POST',
        url: '/api/bookmarks/bm-1/generate',
        payload: { hooks: ['a', 'b', 'c', 'd', 'e', 'f'] },
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /at most 5 hooks/);
    assert.equal(created.length, 0);
});

test('hook suggestion runs are created, fetched, and listed', async () => {
    const { app } = await buildApp();
    const created = await app.inject({ method: 'POST', url: '/api/bookmarks/bm-1/hooks', payload: { prompt: 'funnier' } });
    assert.equal(created.statusCode, 202);
    assert.equal(created.json().id, 'run-1');

    assert.equal((await app.inject('/api/hook-runs/run-1')).statusCode, 200);
    assert.equal((await app.inject('/api/hook-runs/nope')).statusCode, 404);
    assert.equal((await app.inject('/api/bookmarks/bm-1/hook-runs')).json().hookRuns.length, 1);
});

test('retry re-enqueues a failed ingest', async () => {
    const { app, queued } = await buildApp();
    const response = await app.inject({ method: 'POST', url: '/api/bookmarks/bm-1/retry' });
    assert.equal(response.statusCode, 202);
    assert.deepEqual(queued, ['bm-1']);
});

test('the gallery lists its folders and serves a file, but refuses traversal', async () => {
    const gallery = path.join(directory, 'gallery', 'nub-lifestyle');
    await mkdir(gallery, { recursive: true });
    await writeFile(path.join(gallery, 'IMG_0411.JPG'), 'jpeg-bytes');
    await writeFile(path.join(gallery, 'notes.txt'), 'ignored');
    // Somewhere a traversal could reach if the guard were missing.
    await writeFile(path.join(directory, 'gallery', 'secret.env'), 'TOKEN=leak');

    const { app } = await buildApp();

    const galleries = await app.inject('/api/gallery');
    assert.equal(galleries.statusCode, 200);
    const listed = galleries.json().galleries as Array<{ name: string; images: number; videos: number }>;
    assert.deepEqual(listed.find((entry) => entry.name === 'nub-lifestyle'), { name: 'nub-lifestyle', images: 1, videos: 0 });

    const items = await app.inject('/api/gallery/nub-lifestyle');
    assert.equal(items.statusCode, 200);
    // notes.txt is not gallery media and must not be listed.
    assert.deepEqual((items.json().items as Array<{ name: string }>).map((item) => item.name), ['IMG_0411.JPG']);

    const file = await app.inject('/api/gallery/nub-lifestyle/media/IMG_0411.JPG');
    assert.equal(file.statusCode, 200);
    assert.equal(file.headers['content-type'], 'image/jpeg');
    assert.equal(file.body, 'jpeg-bytes');

    for (const escape of ['..%2Fsecret.env', '..%2F..%2Fetc%2Fpasswd']) {
        const blocked = await app.inject(`/api/gallery/nub-lifestyle/media/${escape}`);
        assert.equal(blocked.statusCode, 400, `expected ${escape} to be refused`);
    }
    // A real file inside the gallery that is not media still gets refused.
    assert.equal((await app.inject('/api/gallery/nub-lifestyle/media/notes.txt')).statusCode, 400);
    assert.equal((await app.inject('/api/gallery/nope')).statusCode, 404, 'an unknown gallery is a 404, not a bad request');
});

function multipartBody(files: Array<{ name: string; body: string; field?: string }>): { payload: Buffer; headers: Record<string, string> } {
    const boundary = '----pfTestBoundary';
    const chunks: Buffer[] = [];
    for (const file of files) {
        chunks.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${file.field ?? 'media'}"; filename="${file.name}"\r\n`
            + 'Content-Type: application/octet-stream\r\n\r\n',
        ));
        chunks.push(Buffer.from(file.body), Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return {
        payload: Buffer.concat(chunks),
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    };
}

test('uploading creates the gallery, keeps media, and reports unsupported files', async () => {
    const app = (await buildApp()).app;
    const { payload, headers } = multipartBody([
        { name: 'shot.jpg', body: 'jpeg' },
        { name: 'clip.mp4', body: 'mp4' },
        { name: 'notes.txt', body: 'nope' },
    ]);
    const response = await app.inject({ method: 'POST', url: '/api/gallery/uploaded', payload, headers });
    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.deepEqual(body.added.sort(), ['clip.mp4', 'shot.jpg']);
    assert.deepEqual(body.rejected, ['notes.txt']);

    // The files really landed, and the txt did not.
    const items = (await app.inject('/api/gallery/uploaded')).json().items as Array<{ name: string }>;
    assert.deepEqual(items.map((item) => item.name).sort(), ['clip.mp4', 'shot.jpg']);
});

test('re-uploading the same name keeps both files instead of overwriting', async () => {
    const app = (await buildApp()).app;
    const once = multipartBody([{ name: 'dup.jpg', body: 'first' }]);
    await app.inject({ method: 'POST', url: '/api/gallery/dupes', payload: once.payload, headers: once.headers });
    const twice = multipartBody([{ name: 'dup.jpg', body: 'second' }]);
    const second = await app.inject({ method: 'POST', url: '/api/gallery/dupes', payload: twice.payload, headers: twice.headers });
    assert.deepEqual(second.json().added, ['dup-1.jpg']);

    const original = await app.inject('/api/gallery/dupes/media/dup.jpg');
    assert.equal(original.body, 'first', 'the first upload must survive');
});

test('an upload of only unsupported files is a 400', async () => {
    const app = (await buildApp()).app;
    const { payload, headers } = multipartBody([{ name: 'notes.txt', body: 'nope' }]);
    const response = await app.inject({ method: 'POST', url: '/api/gallery/rejects', payload, headers });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /Unsupported file type/);
});

test('a bad gallery name is refused before anything is written', async () => {
    const app = (await buildApp()).app;
    const { payload, headers } = multipartBody([{ name: 'shot.jpg', body: 'jpeg' }]);
    const response = await app.inject({ method: 'POST', url: '/api/gallery/..%2Fescape', payload, headers });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /Gallery names may use/);
});

test('deleting removes one gallery file and refuses traversal or non-media', async () => {
    const app = (await buildApp()).app;
    const { payload, headers } = multipartBody([{ name: 'gone.jpg', body: 'jpeg' }]);
    await app.inject({ method: 'POST', url: '/api/gallery/removals', payload, headers });

    const removed = await app.inject({ method: 'DELETE', url: '/api/gallery/removals/media/gone.jpg' });
    assert.equal(removed.statusCode, 204);
    assert.deepEqual((await app.inject('/api/gallery/removals')).json().items, []);

    assert.equal((await app.inject({ method: 'DELETE', url: '/api/gallery/removals/media/gone.jpg' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/gallery/removals/media/..%2F..%2Fsecret.env' })).statusCode, 400);
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/gallery/removals/media/notes.txt' })).statusCode, 400);
});

test('caption edits are bounded and a generation that is not ready cannot be queued', async () => {
    const { app } = await buildApp();
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/generations/gen-1', payload: { caption: '  ' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/generations/gen-1', payload: { caption: 'x'.repeat(2_201) } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/generations/gen-1', payload: { caption: 'fine' } })).statusCode, 200);

    // status is 'pending', so queueing must be refused rather than posting nothing.
    const queued = await app.inject({ method: 'POST', url: '/api/generations/gen-1/queue', payload: {} });
    assert.equal(queued.statusCode, 409);
});

test('generated media downloads with a filename naming the post it came from', async () => {
    const { downloadName } = await import('../src/content/routes.js');
    assert.equal(downloadName('/x/generatedPosts/2026-09-12/post_007', 'post.mp4'), '2026-09-12-post_007.mp4');
    assert.equal(downloadName('/x/generatedPosts/2026-09-12/post_007', 'slide-2.jpg'), '2026-09-12-post_007-slide-2.jpg');
    // Anything odd in the path is scrubbed — this lands in a header.
    assert.equal(downloadName('/x/2026 09/po"st', 'post.mp4'), '2026-09-po-st.mp4');
});

test('the media route attaches only when asked, and still refuses unknown files', async () => {
    const outputDir = path.join(directory, 'generatedPosts', '2026-09-12', 'post_007');
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, 'post.mp4'), 'mp4-bytes');
    const { app } = await buildApp({ outputDir });

    // Inline by default, so the review player can stream it.
    const inline = await app.inject('/api/generations/gen-ready/slides/post.mp4');
    assert.equal(inline.statusCode, 200);
    assert.equal(inline.headers['content-type'], 'video/mp4');
    assert.equal(inline.headers['content-disposition'], undefined);

    const download = await app.inject('/api/generations/gen-ready/slides/post.mp4?download=1');
    assert.equal(download.statusCode, 200);
    assert.equal(download.headers['content-disposition'], 'attachment; filename="2026-09-12-post_007.mp4"');
    assert.equal(download.body, 'mp4-bytes');

    // The download flag must not widen what can be read.
    assert.equal((await app.inject('/api/generations/gen-ready/slides/..%2F..%2F.env?download=1')).statusCode, 400);
    assert.equal((await app.inject('/api/generations/gen-ready/slides/plan.json?download=1')).statusCode, 400);
});
