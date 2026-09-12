import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp, { type Sharp } from 'sharp';

import { recognizeWords, type OcrWord } from '../tiktok/ocr.js';

const run = promisify(execFile);

// Tesseract's accuracy falls off on small text. Upscale small stills to this
// width, but never shrink a larger one — downscaling a 1608px slide to 1080
// throws away exactly the detail the recognizer needs.
const OCR_WIDTH = 1600;

/**
 * TikTok overlay copy is typically bright type laid over a photo, and the worst
 * case is pale text on a pale background — cream on a beige wall reads fine to
 * a human but has almost no luminance contrast for Tesseract, which then
 * returns photo texture as words. Thresholding isolates the bright type; the
 * right cut-off differs per image, so each is tried and the cleanest read wins.
 */
const OCR_VARIANTS: Array<(image: Sharp) => Sharp> = [
    (image) => image.grayscale(),
    (image) => image.grayscale().threshold(180),
    (image) => image.grayscale().threshold(200),
    (image) => image.grayscale().threshold(220),
];

/** How much of a read looks like real words rather than texture noise. */
export function wordScore(lines: string[]): number {
    return lines.join(' ').split(/\s+/).filter((token) => /^[A-Za-z][A-Za-z'’]{2,}$/.test(token)).length;
}

/**
 * Drops lines that are mostly stray glyphs picked out of the photo, by the
 * ratio of letters and digits to everything else. A length rule would be wrong:
 * "me:" is real overlay copy, while "¢ ¥ ) 9, & ®" is texture.
 */
export function dropNoiseLines(lines: string[]): string[] {
    return lines.filter((line) => {
        const solid = line.replace(/\s/g, '');
        const alphanumeric = solid.replace(/[^A-Za-z0-9]/g, '').length;
        return alphanumeric >= 2 && alphanumeric / solid.length >= 0.5;
    });
}

/**
 * Groups recognized words back into visual lines. Overlay copy is written and
 * reviewed line by line, so a flat word list is the wrong unit — the caller
 * wants "Health Trackers I'd wear instead of Oura Ring", not 8 tokens.
 */
export function groupWordsIntoLines(words: OcrWord[]): string[] {
    if (words.length === 0) return [];
    const sorted = [...words].sort((a, b) => a.y - b.y || a.x - b.x);
    const lines: OcrWord[][] = [];
    for (const word of sorted) {
        const current = lines[lines.length - 1];
        const previous = current?.[current.length - 1];
        // Same line when the vertical centers overlap within half a glyph height.
        const sameLine = previous
            && Math.abs((word.y + word.height / 2) - (previous.y + previous.height / 2)) < Math.max(word.height, previous.height) * 0.6;
        if (sameLine && current) current.push(word);
        else lines.push([word]);
    }
    return lines
        .map((line) => line.sort((a, b) => a.x - b.x).map((word) => word.text).join(' ').trim())
        .filter(Boolean);
}

export async function readOverlayText(imagePath: string): Promise<string> {
    // withoutEnlargement:false lets small stills grow; the explicit max keeps a
    // large one from being shrunk.
    const { width } = await sharp(imagePath).metadata();
    const resize = { width: Math.max(OCR_WIDTH, width ?? OCR_WIDTH), withoutEnlargement: false };

    let best: string[] = [];
    let bestScore = -1;
    for (const variant of OCR_VARIANTS) {
        let lines: string[];
        try {
            const prepared = await variant(sharp(imagePath).resize(resize)).png().toBuffer();
            lines = dropNoiseLines(groupWordsIntoLines(await recognizeWords(prepared)));
        } catch {
            continue;
        }
        const score = wordScore(lines);
        if (score > bestScore) { bestScore = score; best = lines; }
    }
    return best.join('\n');
}

/**
 * Videos get their first frame only. Full multi-frame OCR would need shot
 * detection and timed span collapsing; the first frame carries the hook
 * overlay, which is the part that matters when copying a template.
 */
export async function readVideoFirstFrameText(videoPath: string): Promise<{ text: string; framePath: string }> {
    const framePath = path.join(path.dirname(videoPath), 'frame-1.jpg');
    await rm(framePath, { force: true });
    await run('ffmpeg', ['-loglevel', 'error', '-i', videoPath, '-frames:v', '1', '-q:v', '2', framePath]);
    const text = await readOverlayText(framePath);
    return { text, framePath };
}

export async function imageDimensions(imagePath: string): Promise<{ width: number | null; height: number | null }> {
    try {
        const { width, height } = await sharp(await readFile(imagePath)).metadata();
        return { width: width ?? null, height: height ?? null };
    } catch {
        return { width: null, height: null };
    }
}
