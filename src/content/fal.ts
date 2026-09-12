import sharp from 'sharp';

import { SLIDE_HEIGHT, SLIDE_WIDTH, letterbox } from './composite.js';
import { httpJson, httpRequest } from './http.js';

// Slide type is rendered by Fal's image editor rather than drawn locally with
// sharp: the model lays type into the photo the way a designer would, instead
// of stamping a flat SVG block over it. The local renderer stays as the
// fallback in composite.ts — see renderSlideText's caller in generate.ts.

const QUEUE_BASE = 'https://queue.fal.run';

export function falModel(): string {
    return process.env.CONTENT_FAL_MODEL ?? 'fal-ai/nano-banana-pro/edit';
}

export class FalNotConfiguredError extends Error {
    constructor() {
        super('FAL_API_KEY is not set; slide text will be rendered locally');
    }
}

export function falKey(): string {
    // The runbook uses FAL_KEY; .env in this repo carries FAL_API_KEY.
    const key = process.env.FAL_API_KEY ?? process.env.FAL_KEY;
    if (!key) throw new FalNotConfiguredError();
    return key;
}

export function isFalConfigured(): boolean {
    return Boolean(process.env.FAL_API_KEY ?? process.env.FAL_KEY);
}

/**
 * The instruction sent with the slide. It is deliberately emphatic about
 * leaving the photograph alone: the gallery image is the operator's real
 * product shot, and the model must letter it, not reimagine it.
 */
export function slideTextPrompt(lines: string[], isHook: boolean): string {
    const copy = lines.map((line) => `"${line}"`).join('\n');
    return [
        'Add text overlay to this image in the style of a TikTok slideshow post.',
        '',
        'Render exactly this text, one line per line, spelled exactly as written:',
        copy,
        '',
        isHook
            ? 'This is the hook slide: set the first line large and bold, the rest smaller beneath it.'
            : 'Set the first line as a heading and the remaining lines smaller beneath it.',
        'Place the text in the upper-middle of the frame, centred, in a clean bold',
        'sans-serif, cream or white, with enough weight or shadow to stay readable',
        'over the photo.',
        '',
        'Do not change the photograph itself: keep the subject, product, framing,',
        'colours, and any black letterbox bars exactly as they are. Add only the text.',
        'Do not add logos, watermarks, borders, or any words beyond the lines above.',
    ].join('\n');
}

interface QueueSubmission { status_url?: string; response_url?: string; request_id?: string }
interface QueueStatus { status?: string; response_url?: string; error?: unknown }
interface EditResponse { images?: Array<{ url?: string }> }

const POLL_INTERVAL_MS = 2_000;

const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Aborted')); }, { once: true });
});

export interface RenderSlideOptions {
    imagePath: string;
    lines: string[];
    isHook: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
    log?: (line: string) => void;
}

/**
 * Letterboxes the gallery photo to 1080×1920 locally, then asks Fal to letter
 * it. Padding first keeps the no-crop guarantee: the model receives the whole
 * frame and is told to preserve the bars, so it never reframes the product out.
 */
export async function renderSlideText(options: RenderSlideOptions): Promise<Buffer> {
    const key = falKey();
    const model = falModel();
    const timeoutMs = options.timeoutMs ?? Number(process.env.CONTENT_FAL_TIMEOUT_MS ?? 180_000);
    const log = options.log ?? (() => {});
    const deadline = Date.now() + timeoutMs;

    const base = await letterbox(options.imagePath);
    const dataUri = `data:image/jpeg;base64,${base.toString('base64')}`;
    const headers = { authorization: `Key ${key}`, 'content-type': 'application/json' };

    const submission = await httpJson<QueueSubmission>(`${QUEUE_BASE}/${model}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            prompt: slideTextPrompt(options.lines, options.isHook),
            image_urls: [dataUri],
            aspect_ratio: '9:16',
            num_images: 1,
            output_format: 'jpeg',
        }),
        timeoutMs: Math.min(timeoutMs, 120_000),
        retries: 0,
        signal: options.signal,
    });

    const statusUrl = submission.status_url
        ?? (submission.request_id ? `${QUEUE_BASE}/${model}/requests/${submission.request_id}/status` : null);
    const responseUrl = submission.response_url
        ?? (submission.request_id ? `${QUEUE_BASE}/${model}/requests/${submission.request_id}` : null);
    if (!statusUrl || !responseUrl) throw new Error('Fal did not return a queue handle');

    let status = '';
    while (status !== 'COMPLETED') {
        if (Date.now() > deadline) throw new Error(`Fal did not finish within ${timeoutMs}ms`);
        await wait(POLL_INTERVAL_MS, options.signal);
        const polled = await httpJson<QueueStatus>(statusUrl, { headers, retries: 1, signal: options.signal });
        status = String(polled.status ?? '');
        if (status === 'FAILED' || status === 'ERROR') throw new Error(`Fal request failed: ${JSON.stringify(polled.error ?? polled).slice(0, 300)}`);
    }

    const result = await httpJson<EditResponse>(responseUrl, { headers, retries: 1, signal: options.signal });
    const url = result.images?.[0]?.url;
    if (!url) throw new Error('Fal returned no image');
    log(`Fal rendered the slide (${model})`);

    const bytes = Buffer.from(await (await fetch(url, { signal: options.signal })).arrayBuffer());
    // Normalize back to exactly 1080×1920 — the model can return a slightly
    // different size, and the post task expects consistent stills.
    return sharp(bytes).resize(SLIDE_WIDTH, SLIDE_HEIGHT, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 1 } })
        .jpeg({ quality: 92, mozjpeg: true }).toBuffer();
}
