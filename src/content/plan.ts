import path from 'node:path';

// Claude produces this file; our code produces the pixels. Everything the model
// writes is re-validated here before it can pick a file off disk or land in a
// caption — a plan is untrusted output, not an instruction.

export interface PlanSlide {
    index: number;
    galleryImage: string;
    overlayLines: string[];
    role: string;
}

export interface SlideshowPlan {
    kind: 'slideshow';
    slides: PlanSlide[];
    caption: string;
    hashtags: string[];
}

export interface VideoPlan {
    kind: 'video';
    galleryVideo: string;
    trimStartSeconds: number;
    /** The on-screen hook, burned over the clip in TikTok's text style. */
    hook: string;
    caption: string;
    hashtags: string[];
}

export type GenerationPlan = SlideshowPlan | VideoPlan;

export class PlanValidationError extends Error {}

const MAX_SLIDES = 6;           // TikTok's slideshow limit, matching createPostTask
const MAX_CAPTION = 2_200;      // TikTok's caption limit, matching createPostTask
export const MAX_LINES_PER_SLIDE = 8;
const MAX_LINE_LENGTH = 200;
// A hook has to be readable on a phone while the video moves.
export const MAX_HOOK_LENGTH = 220;

function asArray(value: unknown, field: string): unknown[] {
    if (!Array.isArray(value)) throw new PlanValidationError(`plan.${field} must be an array`);
    return value;
}

function asString(value: unknown, field: string): string {
    if (typeof value !== 'string') throw new PlanValidationError(`plan.${field} must be a string`);
    return value;
}

/**
 * Rejects any gallery reference that escapes the job workspace. The model is
 * told to use paths like "gallery/IMG_1.jpg", but a plan claiming
 * "../../../.env" must never be resolved and read.
 */
export function resolveGalleryAsset(workspace: string, reference: string): string {
    if (path.isAbsolute(reference)) throw new PlanValidationError(`gallery reference must be workspace-relative, got ${reference}`);
    const resolved = path.resolve(workspace, reference);
    const gallery = path.join(path.resolve(workspace), 'gallery');
    if (!resolved.startsWith(`${gallery}${path.sep}`)) {
        throw new PlanValidationError(`gallery reference ${reference} resolves outside the gallery directory`);
    }
    return resolved;
}

/** @deprecated Kept as the slideshow-flavoured name; prefer resolveGalleryAsset. */
export const resolveGalleryImage = resolveGalleryAsset;

function overlayLines(value: unknown, field: string): string[] {
    const lines = asArray(value, field)
        .map((line, index) => asString(line, `${field}[${index}]`).trim())
        .filter(Boolean);
    if (lines.length > MAX_LINES_PER_SLIDE) {
        throw new PlanValidationError(`plan.${field} must hold at most ${MAX_LINES_PER_SLIDE} lines`);
    }
    if (lines.some((line) => line.length > MAX_LINE_LENGTH)) {
        throw new PlanValidationError(`plan.${field} has a line longer than ${MAX_LINE_LENGTH} characters`);
    }
    return lines;
}

function caption(input: Record<string, unknown>): string {
    const value = asString(input.caption, 'caption').trim();
    if (!value) throw new PlanValidationError('plan.caption must not be empty');
    if (value.length > MAX_CAPTION) throw new PlanValidationError(`plan.caption must be at most ${MAX_CAPTION} characters`);
    return value;
}

function hashtags(input: Record<string, unknown>): string[] {
    return (input.hashtags === undefined ? [] : asArray(input.hashtags, 'hashtags'))
        .map((tag, position) => asString(tag, `hashtags[${position}]`).replace(/^#/, '').trim())
        .filter(Boolean);
}

export interface VideoPlanLimits {
    /** Length the generated video must match — the bookmarked post's duration. */
    targetSeconds: number;
    /** Probed durations of the gallery clips the model was offered, keyed by file name. */
    clipDurations: Map<string, number>;
}

/**
 * The kind is decided by the bookmark, never by the model — a video bookmark
 * always yields a video. Passing it in means a model that returns the wrong
 * shape fails loudly instead of quietly producing the wrong sort of post.
 */
export function validatePlan(raw: unknown, kind: 'slideshow', limits?: undefined): SlideshowPlan;
export function validatePlan(raw: unknown, kind: 'video', limits: VideoPlanLimits): VideoPlan;
export function validatePlan(raw: unknown, kind: 'slideshow' | 'video', limits?: VideoPlanLimits): GenerationPlan;
export function validatePlan(raw: unknown, kind: 'slideshow' | 'video', limits?: VideoPlanLimits): GenerationPlan {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PlanValidationError('plan.json must be a JSON object');
    const input = raw as Record<string, unknown>;
    if (input.kind !== undefined && input.kind !== kind) {
        throw new PlanValidationError(`plan.kind must be "${kind}" for this bookmark, got "${String(input.kind)}"`);
    }
    return kind === 'video' ? validateVideoPlan(input, limits) : validateSlideshowPlan(input);
}

function validateSlideshowPlan(input: Record<string, unknown>): SlideshowPlan {
    if (input.galleryVideo !== undefined || input.trimStartSeconds !== undefined) {
        throw new PlanValidationError('a slideshow plan must not carry video fields');
    }
    const slides = asArray(input.slides, 'slides');
    if (slides.length === 0) throw new PlanValidationError('plan.slides must not be empty');
    if (slides.length > MAX_SLIDES) throw new PlanValidationError(`plan.slides must hold at most ${MAX_SLIDES} slides`);

    const parsed: PlanSlide[] = slides.map((entry, position) => {
        if (!entry || typeof entry !== 'object') throw new PlanValidationError(`plan.slides[${position}] must be an object`);
        const slide = entry as Record<string, unknown>;
        // Indices must be exactly 1..n in order; a gap or a duplicate would
        // silently drop or overwrite a still during compositing.
        if (slide.index !== position + 1) throw new PlanValidationError(`plan.slides[${position}].index must be ${position + 1}`);
        const galleryImage = asString(slide.galleryImage, `slides[${position}].galleryImage`);
        if (!galleryImage.trim()) throw new PlanValidationError(`plan.slides[${position}].galleryImage must not be empty`);
        return {
            index: position + 1,
            galleryImage,
            overlayLines: overlayLines(slide.overlayLines, `slides[${position}].overlayLines`),
            role: typeof slide.role === 'string' ? slide.role : 'slide',
        };
    });

    return { kind: 'slideshow', slides: parsed, caption: caption(input), hashtags: hashtags(input) };
}

function validateVideoPlan(input: Record<string, unknown>, limits?: VideoPlanLimits): VideoPlan {
    if (!limits) throw new PlanValidationError('video plans require the target duration and clip durations');
    if (input.slides !== undefined) throw new PlanValidationError('a video plan must not carry slides');

    const galleryVideo = asString(input.galleryVideo, 'galleryVideo').trim();
    if (!galleryVideo) throw new PlanValidationError('plan.galleryVideo must not be empty');

    // The model may only pick from the clips it was actually offered — those
    // were pre-filtered for length, so an unknown name means it invented one.
    const file = path.basename(galleryVideo);
    const clipDuration = limits.clipDurations.get(file);
    if (clipDuration === undefined) {
        throw new PlanValidationError(`plan.galleryVideo ${galleryVideo} is not one of the offered gallery clips`);
    }

    const trimStartSeconds = input.trimStartSeconds;
    if (typeof trimStartSeconds !== 'number' || !Number.isFinite(trimStartSeconds) || trimStartSeconds < 0) {
        throw new PlanValidationError('plan.trimStartSeconds must be a number of seconds, zero or greater');
    }
    // Allow a frame of slack so a trim that ends exactly at the clip's end is
    // not rejected by floating-point noise in the probed duration.
    if (trimStartSeconds + limits.targetSeconds > clipDuration + 0.05) {
        throw new PlanValidationError(
            `plan.trimStartSeconds ${trimStartSeconds} plus the ${limits.targetSeconds}s target runs past ${file} (${clipDuration}s)`,
        );
    }

    // The hook is the one piece of copy a video post has, so it is required.
    // Accept `overlayLines` as a legacy alias so an older plan still validates.
    const rawHook = typeof input.hook === 'string'
        ? input.hook
        : overlayLines(input.overlayLines, 'overlayLines').join('\n');
    const hook = rawHook.split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
    if (!hook) throw new PlanValidationError('plan.hook must not be empty');
    if (hook.length > MAX_HOOK_LENGTH) throw new PlanValidationError(`plan.hook must be at most ${MAX_HOOK_LENGTH} characters`);
    if (hook.split('\n').length > MAX_LINES_PER_SLIDE) {
        throw new PlanValidationError(`plan.hook must be at most ${MAX_LINES_PER_SLIDE} lines`);
    }

    return {
        kind: 'video',
        galleryVideo,
        trimStartSeconds,
        hook,
        caption: caption(input),
        hashtags: hashtags(input),
    };
}
