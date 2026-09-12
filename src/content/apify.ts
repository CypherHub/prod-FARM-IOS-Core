import { httpJson } from './http.js';

// The normalized shape is deliberately identical to
// contentTemplates/instead-of-king-slideshow/source/source.json, which was
// produced by hand from this same actor. That file is the contract and the
// test fixture; keep the two in step.

export interface SourceAuthor {
    name: string;
    nickName: string;
    profileUrl: string;
    fans: number | null;
    heart: number | null;
}

export interface SourceStats {
    playCount: number | null;
    diggCount: number | null;
    shareCount: number | null;
    collectCount: number | null;
    commentCount: number | null;
}

export interface SourceMusic {
    musicName: string;
    musicAuthor: string;
    musicOriginal: boolean;
    musicId: string;
    musicUrl: string | null;
}

export interface SourcePost {
    id: string;
    webVideoUrl: string;
    submittedVideoUrl: string;
    isSlideshow: boolean;
    text: string;
    createTimeISO: string | null;
    author: SourceAuthor;
    stats: SourceStats;
    mentions: string[];
    detailedMentions: { name: string; nickName: string }[];
    hashtags: string[];
    music: SourceMusic;
    /** Remote download URLs, resolved to local filenames during ingest. */
    slideUrls: string[];
    videoUrl: string | null;
    coverUrl: string | null;
    /** Video only. The length a generated video must match; ffprobe wins if they disagree. */
    durationSeconds: number | null;
}

type Unknown = Record<string, unknown>;

const asRecord = (value: unknown): Unknown => (value && typeof value === 'object' ? value as Unknown : {});
const asString = (value: unknown): string => (typeof value === 'string' ? value : '');
const asNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

// The actor emits hashtags as objects ({ name, title, … }) but the hand-made
// fixture stores plain strings, and older actor builds emitted strings too.
function hashtagNames(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .map((entry) => (typeof entry === 'string' ? entry : asString(asRecord(entry).name)))
        .map((name) => name.replace(/^#/, '').trim())
        .filter(Boolean);
}

function mentionHandles(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .map((entry) => (typeof entry === 'string' ? entry : asString(asRecord(entry).name)))
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => (name.startsWith('@') ? name : `@${name}`));
}

// TikTok music permalinks are slug + id. The actor gives musicName/musicId but
// only a CDN playUrl, so the shareable URL the post task deep-links to has to
// be rebuilt the way the fixture stores it.
export function musicPermalink(musicName: string, musicId: string): string | null {
    if (!musicId) return null;
    const slug = musicName.toLowerCase().normalize('NFKD')
        .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return `https://www.tiktok.com/music/${slug || 'original-sound'}-${musicId}`;
}

function slideDownloadUrls(item: Unknown): string[] {
    const links = item.slideshowImageLinks;
    if (!Array.isArray(links)) return [];
    return links
        .map((entry) => (typeof entry === 'string' ? entry : asString(asRecord(entry).downloadLink)))
        .filter(Boolean);
}

export function normalizeApifyItem(raw: unknown, submittedUrl: string): SourcePost {
    const item = asRecord(raw);
    const author = asRecord(item.authorMeta);
    const music = asRecord(item.musicMeta);
    const video = asRecord(item.videoMeta);
    // Newer actor builds nest the counters under `stats`; older ones put them
    // at the top level. Accept both rather than pinning an actor version.
    const stats = asRecord(item.stats);
    const counter = (key: string) => asNumber(stats[key]) ?? asNumber(item[key]);

    const slideUrls = slideDownloadUrls(item);
    const isSlideshow = typeof item.isSlideshow === 'boolean' ? item.isSlideshow : slideUrls.length > 0;
    const musicName = asString(music.musicName);
    const musicId = asString(music.musicId);
    const authorName = asString(author.name);

    return {
        id: asString(item.id),
        webVideoUrl: asString(item.webVideoUrl) || submittedUrl,
        submittedVideoUrl: asString(item.submittedVideoUrl) || submittedUrl,
        isSlideshow,
        text: asString(item.text),
        createTimeISO: asString(item.createTimeISO) || null,
        author: {
            name: authorName,
            nickName: asString(author.nickName),
            profileUrl: asString(author.profileUrl) || (authorName ? `https://www.tiktok.com/@${authorName}` : ''),
            fans: asNumber(author.fans),
            heart: asNumber(author.heart),
        },
        stats: {
            playCount: counter('playCount'),
            diggCount: counter('diggCount'),
            shareCount: counter('shareCount'),
            collectCount: counter('collectCount'),
            commentCount: counter('commentCount'),
        },
        mentions: mentionHandles(item.mentions),
        detailedMentions: Array.isArray(item.detailedMentions)
            ? item.detailedMentions.map((entry) => {
                const mention = asRecord(entry);
                return { name: asString(mention.name), nickName: asString(mention.nickName) };
            }).filter((mention) => mention.name)
            : [],
        hashtags: hashtagNames(item.hashtags),
        music: {
            musicName,
            musicAuthor: asString(music.musicAuthor),
            musicOriginal: music.musicOriginal === true,
            musicId,
            musicUrl: musicPermalink(musicName, musicId),
        },
        slideUrls,
        videoUrl: isSlideshow ? null : (asString(item.mediaUrls && (item.mediaUrls as unknown[])[0]) || asString(video.downloadAddr) || null),
        coverUrl: asString(video.coverUrl) || asString(video.originalCoverUrl) || null,
        durationSeconds: isSlideshow ? null : asNumber(video.duration),
    };
}

export class ApifyNotConfiguredError extends Error {
    constructor() {
        super('APIFY_API_TOKEN is not set; add it to .env to bookmark TikTok posts');
    }
}

export function apifyToken(): string {
    const token = process.env.APIFY_API_TOKEN;
    if (!token) throw new ApifyNotConfiguredError();
    return token;
}

export function apifyActor(): string {
    return process.env.APIFY_TIKTOK_ACTOR ?? 'clockworks~tiktok-scraper';
}

export interface ScrapeOptions {
    signal?: AbortSignal;
    token?: string;
    actor?: string;
}

/** Runs the actor synchronously and returns the first dataset item, normalized. */
export async function scrapeTikTokPost(url: string, options: ScrapeOptions = {}): Promise<SourcePost> {
    const token = options.token ?? apifyToken();
    const actor = options.actor ?? apifyActor();
    const endpoint = `https://api.apify.com/v2/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items`
        + `?token=${encodeURIComponent(token)}`;
    const items = await httpJson<unknown[]>(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            postURLs: [url],
            resultsPerPage: 1,
            shouldDownloadSlideshowImages: true,
            shouldDownloadCovers: true,
            // Required: with this off the actor leaves `mediaUrls` and
            // `videoMeta.downloadAddr` empty, so a video post has nothing to
            // download and ingest fails with "no downloadable media".
            shouldDownloadVideos: true,
            shouldDownloadSubtitles: false,
        }),
        // The actor boots a browser; a sync run legitimately takes minutes.
        timeoutMs: Number(process.env.APIFY_TIMEOUT_MS ?? 300_000),
        signal: options.signal,
    });
    if (!Array.isArray(items) || items.length === 0) throw new Error(`Apify returned no post for ${url}`);
    const post = normalizeApifyItem(items[0], url);
    if (!post.id) throw new Error(`Apify returned an item with no post id for ${url}`);
    if (!post.isSlideshow && !post.videoUrl) throw new Error(`Apify returned no downloadable media for ${url}`);
    if (post.isSlideshow && post.slideUrls.length === 0) throw new Error(`Apify returned no slideshow images for ${url}`);
    return post;
}
