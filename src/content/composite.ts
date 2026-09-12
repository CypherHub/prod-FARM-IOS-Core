import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';

import { probeMedia } from './gallery.js';
import type { HookAlign, PlanSlide } from './plan.js';

const run = promisify(execFile);

// Type spec lifted from contentTemplates/instead-of-king-slideshow/README.md
// §"Composite type" so generated stills match the hand-made worked example.
export const SLIDE_WIDTH = 1080;
export const SLIDE_HEIGHT = 1920;

const CREAM = '#f4ece0';
/** Letterbox fill. The photoshoot is 4:3 landscape and must never be cropped to fit. */
const PAD_COLOR = { r: 0, g: 0, b: 0, alpha: 1 };
const HOOK_SIZE = 58;
const BODY_SIZE = 34;
const LINE_GAP = 1.32;
const MARGIN = 72;
const FONT_STACK = "'Helvetica Neue', Helvetica, Arial, sans-serif";

// SVG has no text wrapping, so lines are measured and broken here. The ratio is
// an average glyph-width factor for the stack above — close enough to keep copy
// inside the margins without shipping a font-metrics dependency.
const GLYPH_RATIO = 0.52;

export function wrapLine(text: string, fontSize: number, maxWidth: number): string[] {
    const perLine = Math.max(1, Math.floor(maxWidth / (fontSize * GLYPH_RATIO)));
    if (text.length <= perLine) return [text];
    const wrapped: string[] = [];
    let current = '';
    for (const word of text.split(/\s+/)) {
        const candidate = current ? `${current} ${word}` : word;
        if (candidate.length <= perLine) { current = candidate; continue; }
        if (current) wrapped.push(current);
        current = word;
    }
    if (current) wrapped.push(current);
    return wrapped;
}

export function escapeXml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character] ?? character
    ));
}

// TikTok's on-screen text: heavy sans, pure white, hard black outline, and no
// background plate at all. `paint-order` puts the stroke behind the fill so the
// outline never eats into the letterforms (verified against librsvg, which
// sharp renders with).
const HOOK_FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";
const HOOK_TEXT_SIZE = 62;
const HOOK_TEXT_GAP = 1.24;
const HOOK_TEXT_STROKE = 9;
const HOOK_TEXT_MARGIN = 64;

/**
 * Renders the hook the way TikTok renders on-screen text. Deliberately has no
 * scrim, plate, or highlight — the outline alone carries it over the video.
 */
export function hookSvg(
    hook: string,
    width = SLIDE_WIDTH,
    height = SLIDE_HEIGHT,
    /** Where the letterboxed video actually sits, so the hook lands on it. */
    contentBox: { top: number; height: number } = { top: 0, height },
    align: HookAlign = 'center',
): string {
    const maxWidth = width - HOOK_TEXT_MARGIN * 2;
    // Blank lines are kept: they are deliberate spacing, and render as a gap
    // rather than as a <text> element.
    const lines = hook.split('\n').flatMap((line) => {
        const trimmed = line.trim();
        return trimmed ? wrapLine(trimmed, HOOK_TEXT_SIZE, maxWidth) : [''];
    });

    const blockHeight = lines.length * HOOK_TEXT_SIZE * HOOK_TEXT_GAP;
    // Sit the hook inside the top of the picture, the way TikTok does. Placing
    // it on a black letterbox bar would waste the black outline entirely.
    let cursor = Math.round(contentBox.top + contentBox.height * 0.12 + HOOK_TEXT_SIZE);
    if (blockHeight > contentBox.height * 0.7) {
        cursor = Math.round(contentBox.top + (contentBox.height - blockHeight) / 2 + HOOK_TEXT_SIZE);
    }
    // Never let it run off the frame.
    cursor = Math.max(HOOK_TEXT_SIZE + 8, Math.min(cursor, height - blockHeight));

    const anchor = align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle';
    const x = align === 'left' ? HOOK_TEXT_MARGIN : align === 'right' ? width - HOOK_TEXT_MARGIN : width / 2;

    const text = lines.map((line) => {
        const y = Math.round(cursor);
        cursor += HOOK_TEXT_SIZE * HOOK_TEXT_GAP;
        if (!line) return '';
        return `<text x="${x}" y="${y}" font-family="${HOOK_FONT}" font-size="${HOOK_TEXT_SIZE}"`
            + ` font-weight="800" text-anchor="${anchor}" fill="#ffffff" stroke="#000000"`
            + ` stroke-width="${HOOK_TEXT_STROKE}" stroke-linejoin="round" paint-order="stroke fill">`
            + `${escapeXml(line)}</text>`;
    }).join('');

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${text}</svg>`;
}

/**
 * The hook slide sets its first line large; product slides keep every line at
 * body size. A scrim behind the type keeps it readable over a busy photo.
 */
export function overlaySvg(slide: PlanSlide): string {
    const isHook = slide.role === 'hook' || slide.index === 1;
    const maxWidth = SLIDE_WIDTH - MARGIN * 2;
    const rendered: Array<{ text: string; size: number; weight: number }> = [];
    for (const [position, line] of slide.overlayLines.entries()) {
        const size = isHook && position === 0 ? HOOK_SIZE : BODY_SIZE;
        const weight = isHook && position === 0 ? 700 : 500;
        for (const part of wrapLine(line, size, maxWidth)) rendered.push({ text: part, size, weight });
    }

    const blockHeight = rendered.reduce((total, line) => total + line.size * LINE_GAP, 0);
    let cursor = Math.round((SLIDE_HEIGHT - blockHeight) / 2);
    const scrimTop = Math.max(0, cursor - 56);
    const scrimHeight = Math.min(SLIDE_HEIGHT - scrimTop, blockHeight + 112);

    const text = rendered.map((line) => {
        cursor += line.size * LINE_GAP;
        return `<text x="${SLIDE_WIDTH / 2}" y="${Math.round(cursor)}" font-family="${FONT_STACK}"`
            + ` font-size="${line.size}" font-weight="${line.weight}" fill="${CREAM}" text-anchor="middle">`
            + `${escapeXml(line.text)}</text>`;
    }).join('');

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${SLIDE_WIDTH}" height="${SLIDE_HEIGHT}">`
        + `<rect x="0" y="${scrimTop}" width="${SLIDE_WIDTH}" height="${Math.round(scrimHeight)}" fill="rgba(0,0,0,0.42)"/>`
        + text
        + '</svg>';
}

/**
 * Fits the whole gallery photo into 1080×1920 and pads the rest with black.
 * The source photoshoot is 4:3 landscape, so a cover-crop to 9:16 would throw
 * away most of the frame and can cut the product in half — nothing is cropped.
 * Shared by the local renderer and the Fal one, so both start from the same
 * uncropped frame.
 */
export async function letterbox(sourceImage: string): Promise<Buffer> {
    return sharp(sourceImage)
        .resize(SLIDE_WIDTH, SLIDE_HEIGHT, { fit: 'contain', background: PAD_COLOR })
        .jpeg({ quality: 92, mozjpeg: true })
        .toBuffer();
}

/** Letterboxes the photo and burns the overlay in with an SVG layer. */
export async function compositeSlide(sourceImage: string, slide: PlanSlide, outputPath: string): Promise<void> {
    const base = await letterbox(sourceImage);
    const layers = slide.overlayLines.length > 0
        ? [{ input: Buffer.from(overlaySvg(slide)), top: 0, left: 0 }]
        : [];
    await sharp(base).composite(layers).jpeg({ quality: 92, mozjpeg: true }).toFile(outputPath);
}

/**
 * Rasterizes the overlay to a transparent 1080×1920 PNG so ffmpeg can composite
 * it. This ffmpeg is built without libfreetype (no `drawtext` filter), so text
 * cannot be drawn by ffmpeg directly — and routing video text through the same
 * SVG keeps one styling code path for stills and video.
 */
export async function renderOverlayPng(lines: string[], role = 'hook'): Promise<Buffer> {
    const svg = overlaySvg({ index: 1, galleryImage: '', overlayLines: lines, role });
    return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Where a clip lands inside the 1080×1920 frame once letterboxed, so the hook
 * can be placed on the picture rather than on a black bar.
 */
export function contentBoxFor(clipWidth: number | null, clipHeight: number | null): { top: number; height: number } {
    if (!clipWidth || !clipHeight) return { top: 0, height: SLIDE_HEIGHT };
    const scale = Math.min(SLIDE_WIDTH / clipWidth, SLIDE_HEIGHT / clipHeight);
    const height = Math.min(SLIDE_HEIGHT, Math.round(clipHeight * scale));
    return { top: Math.round((SLIDE_HEIGHT - height) / 2), height };
}

/** The video hook layer: TikTok-style white-on-black-outline, no background. */
export async function renderHookPng(
    hook: string,
    contentBox?: { top: number; height: number },
    align: HookAlign = 'center',
): Promise<Buffer> {
    return sharp(Buffer.from(hookSvg(hook, SLIDE_WIDTH, SLIDE_HEIGHT, contentBox, align))).png().toBuffer();
}

export interface VideoCompositeOptions {
    clipPath: string;
    trimStartSeconds: number;
    durationSeconds: number;
    overlayPng: string | null;
    outputPath: string;
}

/** The ffmpeg argument list, exported so a test can assert the filter graph without running it. */
export function videoCompositeArguments(options: VideoCompositeOptions): string[] {
    const { clipPath, trimStartSeconds, durationSeconds, overlayPng, outputPath } = options;
    // Fit the whole frame and pad to 1080×1920 with black — the same no-crop
    // rule the stills follow. setsar=1 keeps non-square-pixel sources honest.
    const fit = `scale=${SLIDE_WIDTH}:${SLIDE_HEIGHT}:force_original_aspect_ratio=decrease,`
        + `pad=${SLIDE_WIDTH}:${SLIDE_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
    return [
        '-hide_banner', '-loglevel', 'error', '-y',
        // -ss before -i seeks the input, which is fast and frame-accurate for h264.
        '-ss', String(trimStartSeconds), '-t', String(durationSeconds), '-i', clipPath,
        ...(overlayPng ? ['-i', overlayPng] : []),
        '-filter_complex', overlayPng ? `[0:v]${fit}[base];[base][1:v]overlay=0:0` : `[0:v]${fit}`,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
        // yuv420p is what TikTok and the Photos import path expect.
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        // The post task attaches the bookmarked TikTok sound at compose time,
        // so any audio from the gallery clip would only fight with it.
        '-an',
        outputPath,
    ];
}

/**
 * Trims the chosen gallery clip to the reference video's length, letterboxes it
 * to 1080×1920, and burns the hook text over it.
 */
export async function compositeVideo(options: {
    clipPath: string;
    trimStartSeconds: number;
    durationSeconds: number;
    hook: string;
    hookAlign?: HookAlign;
    outputPath: string;
}): Promise<void> {
    const { clipPath, trimStartSeconds, durationSeconds, hook, hookAlign = 'center', outputPath } = options;
    let overlayPng: string | null = null;
    if (hook.trim()) {
        overlayPng = path.join(path.dirname(outputPath), '.overlay.png');
        // sharp cannot read a video container, so the clip's shape comes from ffprobe.
        const { width, height } = await probeMedia(clipPath);
        await writeFile(overlayPng, await renderHookPng(hook, contentBoxFor(width, height), hookAlign));
    }
    await run('ffmpeg', videoCompositeArguments({
        clipPath, trimStartSeconds, durationSeconds, overlayPng, outputPath,
    }));
}
