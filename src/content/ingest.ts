import { mkdir, rm } from 'node:fs/promises';

import type { BookmarkMediaRow } from '../database/schema.js';
import { scrapeTikTokPost, type ScrapeOptions, type SourcePost } from './apify.js';
import { downloadTo } from './download.js';
import { probeMedia } from './gallery.js';
import { imageDimensions, readOverlayText, readVideoFirstFrameText } from './overlay-ocr.js';
import { bookmarkDirectory, toRelative } from './paths.js';
import type { ContentRepository } from './repository.js';

type MediaInsert = Omit<typeof import('../database/schema.js').bookmarkMedia.$inferInsert, 'bookmarkId'>;

export interface IngestDependencies {
    scrape?: (url: string, options: ScrapeOptions) => Promise<SourcePost>;
    log?: (line: string) => void;
}

/**
 * Runs one `content-ingest` job: scrape, download every still (or the video
 * plus its cover), OCR the overlay text, and record it all. Any throw lands the
 * bookmark in `failed` with the message so the page can show it and offer a
 * retry, rather than leaving a row stuck in `ingesting` forever.
 */
export async function ingestBookmark(
    repository: ContentRepository,
    bookmarkId: string,
    signal?: AbortSignal,
    dependencies: IngestDependencies = {},
): Promise<void> {
    const scrape = dependencies.scrape ?? scrapeTikTokPost;
    const log = dependencies.log ?? ((line: string) => console.log(`[ingest ${bookmarkId}] ${line}`));

    const bookmark = await repository.bookmark(bookmarkId);
    if (!bookmark) return;
    if (bookmark.status === 'ingesting') log('Re-entering an ingest that did not finish; starting over');

    await repository.updateBookmark(bookmarkId, { status: 'ingesting', error: null });
    const directory = bookmarkDirectory(bookmarkId);

    try {
        log(`Scraping ${bookmark.sourceUrl}`);
        const post = await scrape(bookmark.sourceUrl, { signal });

        // Start from a clean directory so a retry cannot mix new media with
        // stale files from a previous partial run.
        await rm(directory, { recursive: true, force: true });
        await mkdir(directory, { recursive: true });

        const media: MediaInsert[] = [];

        if (post.coverUrl) {
            try {
                const cover = await downloadTo(post.coverUrl, directory, 'cover', { signal });
                media.push({
                    index: 0, role: 'cover', relativePath: toRelative(cover.absolutePath),
                    mimeType: cover.mimeType, size: cover.size, sha256: cover.sha256,
                    ...await imageDimensions(cover.absolutePath),
                });
            } catch (error) {
                // A missing cover is cosmetic; never fail an ingest over it.
                log(`Cover download failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        if (post.isSlideshow) {
            for (const [position, url] of post.slideUrls.entries()) {
                const index = position + 1;
                const slide = await downloadTo(url, directory, `slide-${index}`, { signal });
                log(`Reading overlay text on slide ${index}`);
                media.push({
                    index, role: 'slide', relativePath: toRelative(slide.absolutePath),
                    mimeType: slide.mimeType, size: slide.size, sha256: slide.sha256,
                    ocrText: await readOverlayText(slide.absolutePath),
                    ...await imageDimensions(slide.absolutePath),
                });
            }
        } else if (post.videoUrl) {
            const video = await downloadTo(post.videoUrl, directory, 'video', { signal, fallbackExtension: '.mp4' });
            log('Reading overlay text on the first video frame');
            // First frame only — see readVideoFirstFrameText.
            const { text } = await readVideoFirstFrameText(video.absolutePath);
            // The container is authoritative: a generated video has to match
            // this length exactly, and the scraper's figure is often rounded.
            const probed = await probeMedia(video.absolutePath);
            media.push({
                index: 1, role: 'video', relativePath: toRelative(video.absolutePath),
                mimeType: video.mimeType, size: video.size, sha256: video.sha256, ocrText: text,
                width: probed.width, height: probed.height,
                durationSeconds: probed.durationSeconds ?? post.durationSeconds,
            });
        }

        await repository.replaceBookmarkMedia(bookmarkId, media as Array<Omit<BookmarkMediaRow, 'id' | 'bookmarkId' | 'createdAt'>>);
        // The hook is what the post opens with: the video's first frame, or
        // slide 1. It seeds the hook a generated post has to rhyme with.
        const opener = media.find((row) => row.role === 'video') ?? media.find((row) => row.role === 'slide' && row.index === 1);
        await repository.updateBookmark(bookmarkId, {
            status: 'ready',
            tiktokId: post.id,
            kind: post.isSlideshow ? 'slideshow' : 'video',
            caption: post.text,
            authorName: post.author.name,
            authorNickname: post.author.nickName,
            musicUrl: post.music.musicUrl,
            musicName: post.music.musicName,
            musicAuthor: post.music.musicAuthor,
            musicId: post.music.musicId,
            playCount: post.stats.playCount,
            diggCount: post.stats.diggCount,
            commentCount: post.stats.commentCount,
            shareCount: post.stats.shareCount,
            collectCount: post.stats.collectCount,
            hashtags: post.hashtags,
            mentions: post.mentions,
            raw: post as unknown as Record<string, never>,
            hook: opener?.ocrText?.trim() || null,
            mediaDir: toRelative(directory),
            postedAt: post.createTimeISO ? new Date(post.createTimeISO) : null,
            ingestedAt: new Date(),
            error: null,
        });
        log(`Ingested ${media.length} file(s)`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`Failed: ${message}`);
        await repository.updateBookmark(bookmarkId, { status: 'failed', error: message });
    }
}
