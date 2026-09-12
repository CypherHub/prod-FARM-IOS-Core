import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import type { FastifyReply } from 'fastify';

import type { PluginRouteContext } from '../plugin.js';
import { ApifyNotConfiguredError } from './apify.js';
import {
    GalleryError, GalleryNotFoundError, classify, createGallery, deleteGalleryFile, listGalleries,
    listGalleryItems, resolveGalleryFile, resolveGalleryRoot, sanitizeUploadName, uniqueFileName,
} from './gallery.js';
import { dataRoot, resolveWithinDataRoot } from './paths.js';
import { ContentRepository, ContentStateError } from './repository.js';

/** What a finished generation leaves in its output folder. */
const SLIDE_OUTPUT = /^slide-\d+\.jpg$/;
const VIDEO_OUTPUT = 'post.mp4';
/**
 * A download filename built from the output folder, e.g.
 * `2026-09-12-post_007.mp4`. Sanitized because it lands in a header.
 */
export function downloadName(outputDir: string, file: string): string {
    const post = path.basename(outputDir);
    const day = path.basename(path.dirname(outputDir));
    const stem = file === VIDEO_OUTPUT ? `${day}-${post}` : `${day}-${post}-${path.basename(file, path.extname(file))}`;
    return `${stem.replace(/[^A-Za-z0-9._-]/g, '-')}${path.extname(file)}`;
}

/** How many videos one batch may create at once. */
const MAX_HOOKS_PER_BATCH = 5;

const MIME_BY_EXTENSION: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
};

function statusFor(error: unknown): number {
    if (error instanceof ApifyNotConfiguredError) return 503;
    if (error instanceof ContentStateError || error instanceof GalleryError) return 400;
    return 500;
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function sha256Of(file: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        createReadStream(file).on('data', (chunk) => hash.update(chunk)).once('error', reject).once('end', () => resolve(hash.digest('hex')));
    });
}

/**
 * The content library: bookmark ingestion, the review page, and the hand-off
 * back into the existing post task. Registered from the TikTok plugin, so core
 * routing in src/api/app.ts stays untouched — plugin routes may claim any path,
 * and the nav link arrives through the plugin's navLinks.
 */
export function registerContentRoutes(context: PluginRouteContext, repository?: ContentRepository): void {
    // The repository is injectable so route tests can exercise the HTTP layer
    // without a database.
    const content = repository ?? new ContentRepository(context.scheduler.connection, context.scheduler.boss);
    const { app } = context;

    // The library is a small set of pages rather than one crowded screen:
    // a bookmarks index, a template page, the create flow, and the gallery.
    const page = (file: string) => async (_request: unknown, reply: FastifyReply) => reply
        .type('text/html')
        .send(createReadStream(fileURLToPath(new URL(`../../static/tiktok/${file}`, import.meta.url))));

    app.get('/library', page('library.html'));
    app.get('/library/gallery', page('gallery.html'));
    app.get('/library/create', page('create.html'));
    app.get<{ Params: { id: string } }>('/library/bookmarks/:id', page('bookmark.html'));

    // Shared page assets. Immutable caching would strand edits, so they are
    // served no-cache like the unversioned dashboard assets.
    const staticAsset = (file: string, type: string) => async (_request: unknown, reply: FastifyReply) => reply
        .type(type).header('cache-control', 'no-cache')
        .send(createReadStream(fileURLToPath(new URL(`../../static/tiktok/${file}`, import.meta.url))));

    app.get('/assets/library-shared.js', staticAsset('library-shared.js', 'text/javascript'));
    app.get('/assets/library.css', staticAsset('library-shared.css', 'text/css'));

    app.post<{ Body: { url?: string } }>('/api/bookmarks', async (request, reply) => {
        try {
            const { bookmark, queued } = await content.bookmarkUrl(request.body?.url ?? '');
            return reply.code(queued ? 202 : 200).send(bookmark);
        } catch (error) {
            return reply.code(statusFor(error)).send({ error: message(error) });
        }
    });

    app.get<{ Querystring: { limit?: string } }>('/api/bookmarks', async (request) => ({
        bookmarks: await content.listBookmarks(Math.min(Number(request.query.limit ?? 100) || 100, 500)),
    }));

    app.get<{ Params: { id: string } }>('/api/bookmarks/:id', async (request, reply) => {
        const bookmark = await content.bookmarkDetail(request.params.id);
        if (!bookmark) return reply.code(404).send({ error: 'Bookmark not found' });
        return { ...bookmark, generations: await content.listGenerations(bookmark.id) };
    });

    app.post<{ Params: { id: string } }>('/api/bookmarks/:id/retry', async (request, reply) => {
        const bookmark = await content.bookmark(request.params.id);
        if (!bookmark) return reply.code(404).send({ error: 'Bookmark not found' });
        await content.updateBookmark(bookmark.id, { status: 'pending', error: null });
        await content.enqueueIngest(bookmark.id);
        return reply.code(202).send({ status: 'pending' });
    });

    app.delete<{ Params: { id: string } }>('/api/bookmarks/:id', async (request, reply) => {
        await content.deleteBookmark(request.params.id);
        return reply.code(204).send();
    });

    // Nothing else in the app serves bytes out of the scheduler data directory,
    // so this route owns the traversal guard for stored media.
    app.get<{ Params: { id: string; role: string; index: string } }>(
        '/api/bookmarks/:id/media/:role/:index', async (request, reply) => {
            const { role, index } = request.params;
            if (role !== 'slide' && role !== 'cover' && role !== 'video') {
                return reply.code(400).send({ error: 'role must be slide, cover, or video' });
            }
            const media = await content.bookmarkMediaAt(request.params.id, role, Number(index));
            if (!media) return reply.code(404).send({ error: 'Media not found' });
            let absolute: string;
            try {
                absolute = resolveWithinDataRoot(media.relativePath);
            } catch {
                return reply.code(400).send({ error: 'Stored media path is invalid' });
            }
            return reply
                .type(media.mimeType || MIME_BY_EXTENSION[path.extname(absolute).toLowerCase()] || 'application/octet-stream')
                .header('cache-control', 'private, max-age=3600')
                .send(createReadStream(absolute));
        },
    );

    app.get('/api/gallery', async () => ({ galleries: await listGalleries() }));

    app.get<{ Params: { name: string } }>('/api/gallery/:name', async (request, reply) => {
        try {
            return { name: request.params.name, items: await listGalleryItems(request.params.name) };
        } catch (error) {
            if (error instanceof GalleryNotFoundError) return reply.code(404).send({ error: 'Gallery not found' });
            return reply.code(error instanceof GalleryError ? 400 : 500).send({ error: message(error) });
        }
    });

    app.get<{ Params: { name: string; file: string } }>('/api/gallery/:name/media/:file', async (request, reply) => {
        let absolute: string;
        try {
            absolute = resolveGalleryFile(request.params.name, request.params.file);
        } catch {
            return reply.code(400).send({ error: 'Unknown gallery file' });
        }
        if (!classify(absolute)) return reply.code(400).send({ error: 'Unsupported gallery file type' });
        return reply
            .type(MIME_BY_EXTENSION[path.extname(absolute).toLowerCase()] ?? 'application/octet-stream')
            .header('cache-control', 'private, max-age=3600')
            .send(createReadStream(absolute));
    });

    /**
     * Adds photos and clips to a gallery from the browser, creating the gallery
     * if it does not exist yet. Names are sanitized and de-duplicated, and only
     * recognized media extensions are kept — anything else is reported back
     * rather than silently dropped.
     */
    app.post<{ Params: { name: string } }>('/api/gallery/:name', async (request, reply) => {
        let directory: string;
        try {
            directory = await createGallery(request.params.name);
        } catch (error) {
            return reply.code(400).send({ error: message(error) });
        }

        const added: string[] = [];
        const rejected: string[] = [];
        try {
            for await (const part of request.parts()) {
                if (part.type === 'field') continue;
                if (part.fieldname !== 'media') continue;
                const candidate = sanitizeUploadName(part.filename ?? '', `upload-${added.length + 1}`);
                if (!classify(candidate)) {
                    // Drain the stream; skipping it would stall the parser.
                    part.file.resume();
                    rejected.push(part.filename ?? candidate);
                    continue;
                }
                const name = await uniqueFileName(directory, candidate);
                const target = path.join(directory, name);
                await pipeline(part.file, createWriteStream(target, { flags: 'wx' }));
                if (part.file.truncated) {
                    await rm(target, { force: true });
                    throw new ContentStateError(`${candidate} exceeds the upload limit`);
                }
                added.push(name);
            }
        } catch (error) {
            return reply.code(statusFor(error) === 500 ? 400 : statusFor(error)).send({ error: message(error) });
        }

        if (added.length === 0 && rejected.length > 0) {
            return reply.code(400).send({ error: `Unsupported file type: ${rejected.join(', ')}`, added, rejected });
        }
        return reply.code(201).send({ gallery: request.params.name, added, rejected });
    });

    app.delete<{ Params: { name: string; file: string } }>('/api/gallery/:name/media/:file', async (request, reply) => {
        try {
            await deleteGalleryFile(request.params.name, request.params.file);
            return reply.code(204).send();
        } catch (error) {
            if (error instanceof GalleryNotFoundError) return reply.code(404).send({ error: 'Gallery file not found' });
            return reply.code(statusFor(error)).send({ error: message(error) });
        }
    });

    app.post<{ Params: { id: string }; Body: { prompt?: string } }>(
        '/api/bookmarks/:id/hooks', async (request, reply) => {
            try {
                const run = await content.createHookRun({
                    bookmarkId: request.params.id,
                    prompt: request.body?.prompt?.slice(0, 2_000) ?? null,
                });
                return reply.code(202).send(run);
            } catch (error) {
                return reply.code(statusFor(error)).send({ error: message(error) });
            }
        },
    );

    app.get<{ Params: { id: string } }>('/api/hook-runs/:id', async (request, reply) => {
        const run = await content.hookRun(request.params.id);
        return run ?? reply.code(404).send({ error: 'Hook run not found' });
    });

    app.get<{ Params: { id: string } }>('/api/bookmarks/:id/hook-runs', async (request) => ({
        hookRuns: await content.listHookRuns(request.params.id),
    }));

    /**
     * Creates one generation per chosen hook. With no `hooks` it behaves as it
     * always did and makes a single post whose hook the model writes.
     */
    app.post<{
        Params: { id: string };
        Body: {
            gallery?: string; galleryDir?: string; deviceUdid?: string; account?: string;
            prompt?: string; hooks?: string[]; galleryVideo?: string; hookRunId?: string;
        };
    }>('/api/bookmarks/:id/generate', async (request, reply) => {
        try {
            // `gallery` names a folder under the gallery root (what the page
            // sends); `galleryDir` stays supported for an explicit path.
            const named = request.body?.gallery?.trim();
            const galleryDir = named
                ? resolveGalleryRoot(named)
                : path.resolve(request.body?.galleryDir?.trim() || process.env.CONTENT_GALLERY_DIR || 'gallery');

            const chosen = (request.body?.hooks ?? [])
                .filter((hook): hook is string => typeof hook === 'string')
                .map((hook) => hook.trim())
                .filter(Boolean);
            if (chosen.length > MAX_HOOKS_PER_BATCH) {
                return reply.code(400).send({ error: `Choose at most ${MAX_HOOKS_PER_BATCH} hooks` });
            }

            const shared = {
                bookmarkId: request.params.id,
                galleryDir,
                deviceUdid: request.body?.deviceUdid?.trim() || null,
                account: request.body?.account?.trim() || null,
                prompt: request.body?.prompt?.slice(0, 2_000) ?? null,
                galleryVideo: request.body?.galleryVideo?.trim() || null,
                hookRunId: request.body?.hookRunId?.trim() || null,
            };

            // No hooks chosen means the old one-shot behaviour: the model writes one.
            const hooks = chosen.length > 0 ? chosen : [null];
            const created = [];
            for (const hook of hooks) created.push(await content.createGeneration({ ...shared, hook }));
            return reply.code(202).send({ generations: created });
        } catch (error) {
            return reply.code(statusFor(error)).send({ error: message(error) });
        }
    });

    app.get<{ Params: { id: string } }>('/api/generations/:id', async (request, reply) => {
        const generation = await content.generation(request.params.id);
        if (!generation) return reply.code(404).send({ error: 'Generation not found' });
        const files = generation.outputDir ? await readdir(generation.outputDir).catch(() => []) : [];
        return {
            ...generation,
            kind: files.includes(VIDEO_OUTPUT) ? 'video' : 'slideshow',
            slides: files.filter((name) => SLIDE_OUTPUT.test(name)).sort(),
            video: files.includes(VIDEO_OUTPUT) ? VIDEO_OUTPUT : null,
        };
    });

    app.get<{ Params: { id: string; name: string }; Querystring: { download?: string } }>(
        '/api/generations/:id/slides/:name', async (request, reply) => {
            const generation = await content.generation(request.params.id);
            if (!generation?.outputDir) return reply.code(404).send({ error: 'Generation has no output yet' });
            // Only ever serve the files this generation produced.
            const { name } = request.params;
            if (!SLIDE_OUTPUT.test(name) && name !== VIDEO_OUTPUT) return reply.code(400).send({ error: 'Unknown output file' });

            if (request.query.download !== undefined) {
                // Name the file after the post it came from, so a folder of
                // downloads is still identifiable: 2026-09-12-post_007.mp4.
                reply.header('content-disposition', `attachment; filename="${downloadName(generation.outputDir, name)}"`);
            }
            return reply
                .type(name === VIDEO_OUTPUT ? 'video/mp4' : 'image/jpeg')
                .header('cache-control', 'private, max-age=3600')
                .send(createReadStream(path.join(generation.outputDir, name)));
        },
    );

    app.patch<{ Params: { id: string }; Body: { caption?: string } }>('/api/generations/:id', async (request, reply) => {
        const caption = request.body?.caption;
        if (typeof caption !== 'string' || !caption.trim()) return reply.code(400).send({ error: 'caption must not be empty' });
        if (caption.length > 2_200) return reply.code(400).send({ error: 'caption must be at most 2200 characters' });
        const generation = await content.generation(request.params.id);
        if (!generation) return reply.code(404).send({ error: 'Generation not found' });
        return content.updateGeneration(generation.id, { caption });
    });

    /**
     * Copies the generated stills into the scheduler's asset store and creates
     * the existing TikTok post task from them — the same path a manual upload
     * takes, so posting behavior is identical. Always a draft: nothing reaches
     * a public feed without someone reviewing it on the phone.
     */
    app.post<{ Params: { id: string }; Body: { deviceUdid?: string; account?: string } }>(
        '/api/generations/:id/queue', async (request, reply) => {
            const generation = await content.generation(request.params.id);
            if (!generation) return reply.code(404).send({ error: 'Generation not found' });
            if (generation.status !== 'ready') return reply.code(409).send({ error: 'Generation is not ready yet' });
            if (!generation.outputDir) return reply.code(409).send({ error: 'Generation produced no files' });

            const udid = request.body?.deviceUdid?.trim() || generation.deviceUdid;
            const account = request.body?.account?.trim() || generation.account;
            if (!udid) return reply.code(400).send({ error: 'Choose a device' });
            if (!account) return reply.code(400).send({ error: 'Choose a TikTok account' });
            const device = (await context.loadDevices()).find((entry) => entry.udid === udid);
            if (!device) return reply.code(404).send({ error: 'Device is not registered' });
            if (device.disabled) return reply.code(409).send({ error: 'This device is disconnected — reconnect it before posting' });

            const root = dataRoot();
            const assetRoot = path.join(root, 'assets');
            await mkdir(assetRoot, { recursive: true });
            const directory = await mkdtemp(path.join(assetRoot, 'post-'));
            let assetIds: string[] = [];
            try {
                const produced = await readdir(generation.outputDir);
                // A video generation posts the single MP4; the post task's
                // validator accepts exactly one video or only images, never both.
                const names = produced.includes(VIDEO_OUTPUT)
                    ? [VIDEO_OUTPUT]
                    : produced.filter((name) => SLIDE_OUTPUT.test(name))
                        .sort((a, b) => Number(/\d+/.exec(a)?.[0]) - Number(/\d+/.exec(b)?.[0]));
                if (names.length === 0) throw new ContentStateError('Generation produced no media');

                const files = [];
                for (const [position, name] of names.entries()) {
                    const target = path.join(directory, `${String(position).padStart(2, '0')}-${name}`);
                    await copyFile(path.join(generation.outputDir, name), target);
                    files.push({ path: target, name, mimeType: name === VIDEO_OUTPUT ? 'video/mp4' : 'image/jpeg' });
                }
                const stored = await context.scheduler.registerAssets(await Promise.all(files.map(async (file) => ({
                    relativePath: path.relative(root, file.path), originalName: file.name, mimeType: file.mimeType,
                    size: (await stat(file.path)).size, sha256: await sha256Of(file.path),
                }))));
                assetIds = stored.map(({ id }) => id);

                const schedule = await context.scheduler.createTask({
                    deviceUdid: device.udid,
                    task: {
                        pluginId: 'com.git-agni.tiktok', taskType: 'post', taskVersion: 1,
                        payload: {
                            media: stored.map(({ id, name, mimeType }) => ({ assetId: id, name, mimeType })),
                            destination: 'draft', account,
                            ...(generation.caption ? { caption: generation.caption } : {}),
                            ...(generation.musicUrl ? { musicUrl: generation.musicUrl } : {}),
                        },
                    },
                    timing: { kind: 'now' },
                }, device.pluginData['com.git-agni.tiktok'] ?? {}, new Date(), assetIds);

                await content.updateGeneration(generation.id, {
                    status: 'queued', deviceUdid: device.udid, account, queuedScheduleId: schedule.id,
                });
                return reply.code(202).send(schedule);
            } catch (error) {
                if (assetIds.length) await context.scheduler.deleteAssets(assetIds);
                await rm(directory, { recursive: true, force: true });
                return reply.code(statusFor(error) === 500 ? 400 : statusFor(error)).send({ error: message(error) });
            }
        },
    );
}
