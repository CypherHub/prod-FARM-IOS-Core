import { desc, eq } from 'drizzle-orm';
import { rm } from 'node:fs/promises';
import type { PgBoss } from 'pg-boss';

import type { DatabaseConnection } from '../database/client.js';
import {
    bookmarkMedia, bookmarks, generations, hookRuns,
    type BookmarkMediaRow, type BookmarkRow, type GenerationRow, type HookRunRow,
} from '../database/schema.js';
import {
    CONTENT_GENERATE_QUEUE, CONTENT_HOOKS_QUEUE, CONTENT_INGEST_QUEUE, ensureContentQueue,
    type ContentGenerateJob, type ContentHookJob, type ContentIngestJob,
} from '../scheduler/queue.js';
import type { JsonObject } from '../types.js';
import { bookmarkDirectory } from './paths.js';

/** Thrown when a bookmark or generation is addressed in a state that forbids the action. */
export class ContentStateError extends Error {}

export interface BookmarkDetail extends BookmarkRow { media: BookmarkMediaRow[] }

// TikTok accepts many URL forms (/t/ shortlinks, @user/video/<id>, /photo/<id>,
// with or without tracking query strings). Normalizing before the unique-index
// check is what makes re-bookmarking the same post idempotent instead of
// creating a near-duplicate row per URL variant.
export function normalizeTikTokUrl(input: string): string {
    let parsed: URL;
    try {
        parsed = new URL(input.trim());
    } catch {
        throw new ContentStateError('Enter a full TikTok URL, including https://');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new ContentStateError('TikTok URLs must be http(s)');
    }
    if (!/(^|\.)tiktok\.com$/i.test(parsed.hostname)) {
        throw new ContentStateError('Only tiktok.com URLs can be bookmarked');
    }
    parsed.protocol = 'https:';
    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed.toString();
}

export class ContentRepository {
    constructor(readonly connection: DatabaseConnection, readonly boss: PgBoss) {}

    /**
     * Idempotent on the normalized URL: re-bookmarking an existing post returns
     * the existing row rather than re-scraping. A previously failed bookmark is
     * reset and re-queued, which is how the UI's Retry works.
     */
    async bookmarkUrl(rawUrl: string): Promise<{ bookmark: BookmarkRow; queued: boolean }> {
        const sourceUrl = normalizeTikTokUrl(rawUrl);
        const existing = await this.bookmarkByUrl(sourceUrl);
        if (existing && existing.status !== 'failed') return { bookmark: existing, queued: false };

        const row = existing
            ? await this.updateBookmark(existing.id, { status: 'pending', error: null })
            : (await this.connection.db.insert(bookmarks).values({ sourceUrl }).returning())[0];
        if (!row) throw new Error('Unable to create bookmark');
        await this.enqueueIngest(row.id);
        return { bookmark: row, queued: true };
    }

    async enqueueIngest(bookmarkId: string): Promise<void> {
        await ensureContentQueue(this.boss, CONTENT_INGEST_QUEUE, 'standard');
        await this.boss.send(CONTENT_INGEST_QUEUE, { bookmarkId } satisfies ContentIngestJob);
    }

    async bookmarkByUrl(sourceUrl: string): Promise<BookmarkRow | null> {
        const [row] = await this.connection.db.select().from(bookmarks).where(eq(bookmarks.sourceUrl, sourceUrl)).limit(1);
        return row ?? null;
    }

    async bookmark(id: string): Promise<BookmarkRow | null> {
        const [row] = await this.connection.db.select().from(bookmarks).where(eq(bookmarks.id, id)).limit(1);
        return row ?? null;
    }

    async bookmarkDetail(id: string): Promise<BookmarkDetail | null> {
        const row = await this.bookmark(id);
        if (!row) return null;
        const media = await this.connection.db.select().from(bookmarkMedia)
            .where(eq(bookmarkMedia.bookmarkId, id)).orderBy(bookmarkMedia.role, bookmarkMedia.index);
        return { ...row, media };
    }

    async listBookmarks(limit = 100): Promise<BookmarkRow[]> {
        return this.connection.db.select().from(bookmarks).orderBy(desc(bookmarks.createdAt)).limit(limit);
    }

    async updateBookmark(id: string, values: Partial<typeof bookmarks.$inferInsert>): Promise<BookmarkRow> {
        const [row] = await this.connection.db.update(bookmarks)
            .set({ ...values, updatedAt: new Date() }).where(eq(bookmarks.id, id)).returning();
        if (!row) throw new ContentStateError(`Bookmark ${id} no longer exists`);
        return row;
    }

    async replaceBookmarkMedia(bookmarkId: string, rows: Array<Omit<typeof bookmarkMedia.$inferInsert, 'bookmarkId'>>): Promise<void> {
        await this.connection.db.transaction(async (tx) => {
            await tx.delete(bookmarkMedia).where(eq(bookmarkMedia.bookmarkId, bookmarkId));
            if (rows.length > 0) await tx.insert(bookmarkMedia).values(rows.map((row) => ({ ...row, bookmarkId })));
        });
    }

    async bookmarkMediaAt(bookmarkId: string, role: BookmarkMediaRow['role'], index: number): Promise<BookmarkMediaRow | null> {
        const rows = await this.connection.db.select().from(bookmarkMedia).where(eq(bookmarkMedia.bookmarkId, bookmarkId));
        return rows.find((row) => row.role === role && row.index === index) ?? null;
    }

    /** Removes the row and its media directory; the media_dir is ours, so it goes with it. */
    async deleteBookmark(id: string): Promise<void> {
        await this.connection.db.delete(bookmarks).where(eq(bookmarks.id, id));
        await rm(bookmarkDirectory(id), { recursive: true, force: true });
    }

    /** Step 1 of the create flow: queue a batch of AI hook suggestions. */
    async createHookRun(input: { bookmarkId: string; prompt?: string | null }): Promise<HookRunRow> {
        const bookmark = await this.bookmark(input.bookmarkId);
        if (!bookmark) throw new ContentStateError('Bookmark not found');
        if (bookmark.status !== 'ready') throw new ContentStateError('Bookmark is still ingesting; wait for it to finish');
        const [row] = await this.connection.db.insert(hookRuns).values({
            bookmarkId: input.bookmarkId,
            prompt: input.prompt?.trim() || null,
        }).returning();
        if (!row) throw new Error('Unable to create hook run');
        await ensureContentQueue(this.boss, CONTENT_HOOKS_QUEUE, 'singleton');
        await this.boss.send(CONTENT_HOOKS_QUEUE, { hookRunId: row.id } satisfies ContentHookJob);
        return row;
    }

    async hookRun(id: string): Promise<HookRunRow | null> {
        const [row] = await this.connection.db.select().from(hookRuns).where(eq(hookRuns.id, id)).limit(1);
        return row ?? null;
    }

    async listHookRuns(bookmarkId: string, limit = 10): Promise<HookRunRow[]> {
        return this.connection.db.select().from(hookRuns)
            .where(eq(hookRuns.bookmarkId, bookmarkId)).orderBy(desc(hookRuns.createdAt)).limit(limit);
    }

    async updateHookRun(id: string, values: Partial<typeof hookRuns.$inferInsert>): Promise<HookRunRow> {
        const [row] = await this.connection.db.update(hookRuns)
            .set({ ...values, updatedAt: new Date() }).where(eq(hookRuns.id, id)).returning();
        if (!row) throw new ContentStateError(`Hook run ${id} no longer exists`);
        return row;
    }

    async createGeneration(input: {
        bookmarkId: string; galleryDir: string; deviceUdid?: string | null; account?: string | null;
        musicUrl?: string | null; prompt?: string | null;
        /** Set to fix the hook rather than let the model write one. */
        hook?: string | null; galleryVideo?: string | null; hookRunId?: string | null;
    }): Promise<GenerationRow> {
        const bookmark = await this.bookmark(input.bookmarkId);
        if (!bookmark) throw new ContentStateError('Bookmark not found');
        if (bookmark.status !== 'ready') throw new ContentStateError('Bookmark is still ingesting; wait for it to finish');
        const [row] = await this.connection.db.insert(generations).values({
            bookmarkId: input.bookmarkId,
            galleryDir: input.galleryDir,
            deviceUdid: input.deviceUdid ?? null,
            account: input.account ?? null,
            musicUrl: input.musicUrl ?? bookmark.musicUrl,
            prompt: input.prompt?.trim() || null,
            hook: input.hook?.trim() || null,
            galleryVideo: input.galleryVideo?.trim() || null,
            hookRunId: input.hookRunId ?? null,
        }).returning();
        if (!row) throw new Error('Unable to create generation');
        await ensureContentQueue(this.boss, CONTENT_GENERATE_QUEUE, 'singleton');
        await this.boss.send(CONTENT_GENERATE_QUEUE, { generationId: row.id } satisfies ContentGenerateJob);
        return row;
    }

    async generation(id: string): Promise<GenerationRow | null> {
        const [row] = await this.connection.db.select().from(generations).where(eq(generations.id, id)).limit(1);
        return row ?? null;
    }

    async listGenerations(bookmarkId?: string, limit = 50): Promise<GenerationRow[]> {
        const query = this.connection.db.select().from(generations);
        const rows = bookmarkId
            ? await query.where(eq(generations.bookmarkId, bookmarkId)).orderBy(desc(generations.createdAt)).limit(limit)
            : await query.orderBy(desc(generations.createdAt)).limit(limit);
        return rows;
    }

    async updateGeneration(id: string, values: Partial<typeof generations.$inferInsert>): Promise<GenerationRow> {
        const [row] = await this.connection.db.update(generations)
            .set({ ...values, updatedAt: new Date() }).where(eq(generations.id, id)).returning();
        if (!row) throw new ContentStateError(`Generation ${id} no longer exists`);
        return row;
    }

    async savePlan(id: string, plan: JsonObject, caption: string, outputDir: string, hook: string): Promise<GenerationRow> {
        return this.updateGeneration(id, { plan, caption, hook, outputDir, status: 'ready', finishedAt: new Date(), error: null });
    }
}
