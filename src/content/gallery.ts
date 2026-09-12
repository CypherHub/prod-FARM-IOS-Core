import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// A gallery is a folder of the operator's own media under CONTENT_GALLERY_DIR.
// Images feed slideshow generations, videos feed video generations, and the two
// never mix: a slideshow is built from stills, a video is one trimmed clip.
export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic']);
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v']);

const MAX_ITEMS = Number(process.env.CONTENT_MAX_GALLERY_ITEMS ?? 200);

/** A gallery name or file that is malformed or escapes the root — a client error. */
export class GalleryError extends Error {}
/** A well-formed gallery name that simply is not there. */
export class GalleryNotFoundError extends GalleryError {}

export interface GalleryItem {
    name: string;
    kind: 'image' | 'video';
    size: number;
    width: number | null;
    height: number | null;
    /** Videos only. */
    durationSeconds: number | null;
}

export interface GallerySummary {
    name: string;
    images: number;
    videos: number;
}

export function galleryRoot(): string {
    return path.resolve(process.env.CONTENT_GALLERY_DIR ?? 'gallery');
}

/**
 * Resolves a named gallery under the gallery root and refuses anything that
 * escapes it. Gallery names arrive from HTTP and from model output, so the
 * same guard shape as resolveWithinDataRoot applies here.
 */
export function resolveGalleryRoot(name: string): string {
    const root = galleryRoot();
    const resolved = path.resolve(root, name);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        throw new GalleryError(`Gallery ${name} resolves outside the gallery directory`);
    }
    return resolved;
}

/** Resolves one file inside a named gallery, rejecting any path separator games. */
export function resolveGalleryFile(name: string, file: string): string {
    const directory = resolveGalleryRoot(name);
    const resolved = path.resolve(directory, file);
    if (!resolved.startsWith(`${directory}${path.sep}`)) {
        throw new GalleryError(`${file} resolves outside gallery ${name}`);
    }
    return resolved;
}

// A gallery the operator creates from the web app becomes a directory name, so
// it is whitelisted rather than merely guarded against traversal.
const GALLERY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertGalleryName(name: string): string {
    const trimmed = name.trim();
    if (!GALLERY_NAME.test(trimmed) || trimmed.includes('..')) {
        throw new GalleryError('Gallery names may use letters, numbers, dots, dashes, and underscores');
    }
    return trimmed;
}

/** Strips anything that could steer the write out of the gallery directory. */
export function sanitizeUploadName(filename: string, fallback: string): string {
    const base = path.basename(filename || fallback).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
    return base || fallback;
}

/**
 * Picks a name that is not taken, so re-uploading a file never silently
 * overwrites the one the gallery already has.
 */
export async function uniqueFileName(directory: string, desired: string): Promise<string> {
    const extension = path.extname(desired);
    const stem = desired.slice(0, desired.length - extension.length) || 'upload';
    for (let suffix = 0; suffix < 1_000; suffix += 1) {
        const candidate = suffix === 0 ? desired : `${stem}-${suffix}${extension}`;
        try {
            await stat(path.join(directory, candidate));
        } catch {
            return candidate;
        }
    }
    throw new GalleryError(`Too many files named like ${desired}`);
}

export async function createGallery(name: string): Promise<string> {
    const directory = resolveGalleryRoot(assertGalleryName(name));
    await mkdir(directory, { recursive: true });
    return directory;
}

/** Removes one media file from a gallery. Refuses anything that is not gallery media. */
export async function deleteGalleryFile(name: string, file: string): Promise<void> {
    const absolute = resolveGalleryFile(name, file);
    if (!classify(absolute)) throw new GalleryError('Only gallery media can be deleted');
    try {
        await rm(absolute);
    } catch {
        throw new GalleryNotFoundError(`${file} is not in gallery ${name}`);
    }
}

export function classify(file: string): 'image' | 'video' | null {
    const extension = path.extname(file).toLowerCase();
    if (IMAGE_EXTENSIONS.has(extension)) return 'image';
    if (VIDEO_EXTENSIONS.has(extension)) return 'video';
    return null;
}

/**
 * One ffprobe call for dimensions and duration. Used both for gallery videos
 * and for the reference video during ingest — the container is authoritative,
 * whatever the scraper reported.
 */
export async function probeMedia(file: string): Promise<{ width: number | null; height: number | null; durationSeconds: number | null }> {
    try {
        const { stdout } = await run('ffprobe', [
            '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height:format=duration',
            '-of', 'json', file,
        ]);
        const parsed = JSON.parse(stdout) as {
            streams?: Array<{ width?: number; height?: number }>;
            format?: { duration?: string };
        };
        const stream = parsed.streams?.[0];
        const duration = Number(parsed.format?.duration);
        return {
            width: stream?.width ?? null,
            height: stream?.height ?? null,
            durationSeconds: Number.isFinite(duration) ? duration : null,
        };
    } catch {
        return { width: null, height: null, durationSeconds: null };
    }
}

async function listNames(directory: string, kind: 'image' | 'video'): Promise<string[]> {
    let entries;
    try {
        entries = await readdir(directory, { withFileTypes: true });
    } catch {
        throw new GalleryNotFoundError(`Gallery directory ${directory} could not be read`);
    }
    return entries
        .filter((entry) => entry.isFile() && classify(entry.name) === kind)
        .map((entry) => entry.name)
        .sort()
        .slice(0, MAX_ITEMS);
}

export async function listGalleryImages(directory: string): Promise<string[]> {
    return listNames(directory, 'image');
}

export async function listGalleryVideos(directory: string): Promise<string[]> {
    return listNames(directory, 'video');
}

/** Every gallery folder under the root, with its counts, for the picker. */
export async function listGalleries(): Promise<GallerySummary[]> {
    const root = galleryRoot();
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch {
        return [];
    }
    const summaries: GallerySummary[] = [];
    for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
        const directory = path.join(root, entry.name);
        summaries.push({
            name: entry.name,
            images: (await listGalleryImages(directory)).length,
            videos: (await listGalleryVideos(directory)).length,
        });
    }
    return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

/** Full item listing for one gallery. Videos are probed; images are not, to keep this fast. */
export async function listGalleryItems(name: string): Promise<GalleryItem[]> {
    const directory = resolveGalleryRoot(name);
    const items: GalleryItem[] = [];
    for (const file of await listGalleryImages(directory)) {
        items.push({ name: file, kind: 'image', size: (await stat(path.join(directory, file))).size, width: null, height: null, durationSeconds: null });
    }
    for (const file of await listGalleryVideos(directory)) {
        const absolute = path.join(directory, file);
        const probed = await probeMedia(absolute);
        items.push({ name: file, kind: 'video', size: (await stat(absolute)).size, ...probed });
    }
    return items;
}

export interface EligibleClip {
    name: string;
    durationSeconds: number;
}

/**
 * Gallery clips long enough to yield a trim of `targetSeconds`. A clip shorter
 * than the reference is unusable — IMG_0432.mov (1.1 s) is a real example — so
 * this is filtered before the model ever sees the list, rather than being
 * caught as a validation failure afterwards.
 */
export async function eligibleClips(directory: string, targetSeconds: number): Promise<EligibleClip[]> {
    const eligible: EligibleClip[] = [];
    for (const file of await listGalleryVideos(directory)) {
        const { durationSeconds } = await probeMedia(path.join(directory, file));
        if (durationSeconds !== null && durationSeconds >= targetSeconds) {
            eligible.push({ name: file, durationSeconds });
        }
    }
    return eligible;
}
