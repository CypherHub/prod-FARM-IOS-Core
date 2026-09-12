import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runClaude } from './claude.js';
import { referenceBlock, type ReferenceInput } from './generate.js';
import { resolveWithinDataRoot } from './paths.js';
import { MAX_HOOK_LENGTH, MAX_LINES_PER_SLIDE, PlanValidationError } from './plan.js';
import type { ContentRepository } from './repository.js';

/** How many suggestions the model is asked for, and the ceiling we will accept. */
export const HOOK_SUGGESTION_COUNT = 5;
const MAX_HOOKS = 8;

export interface HookDependencies {
    runModel?: typeof runClaude;
    log?: (line: string) => void;
}

/**
 * Validates the hooks.json the model writes. Same posture as validatePlan: the
 * model's output is untrusted, so shape and limits are re-checked here before
 * anything reaches a generation.
 */
export function validateHooks(raw: unknown): string[] {
    const list = Array.isArray(raw) ? raw : (raw as { hooks?: unknown })?.hooks;
    if (!Array.isArray(list)) throw new PlanValidationError('hooks.json must hold a "hooks" array');

    const hooks: string[] = [];
    for (const [index, entry] of list.entries()) {
        if (typeof entry !== 'string') throw new PlanValidationError(`hooks[${index}] must be a string`);
        const hook = entry.split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
        if (!hook) continue;
        if (hook.length > MAX_HOOK_LENGTH) throw new PlanValidationError(`hooks[${index}] must be at most ${MAX_HOOK_LENGTH} characters`);
        if (hook.split('\n').length > MAX_LINES_PER_SLIDE) {
            throw new PlanValidationError(`hooks[${index}] must be at most ${MAX_LINES_PER_SLIDE} lines`);
        }
        // The picker is a list of choices; duplicates waste a slot.
        if (!hooks.includes(hook)) hooks.push(hook);
    }

    if (hooks.length === 0) throw new PlanValidationError('hooks.json produced no usable hooks');
    if (hooks.length > MAX_HOOKS) throw new PlanValidationError(`hooks.json must hold at most ${MAX_HOOKS} hooks`);
    return hooks;
}

export function buildHookPrompt(input: ReferenceInput & { kind: 'slideshow' | 'video'; count: number }): string {
    const surface = input.kind === 'video'
        ? 'burned over the video as large white text with a black outline, TikTok style'
        : 'set as the opening slide of a slideshow';
    return [
        `You are writing ${input.count} alternative hooks for a TikTok post that reuses the`,
        'structure of a reference post.',
        '',
        ...referenceBlock(input),
        '',
        `The hook is ${surface}, so keep each one to one or two short lines that a viewer can`,
        'read at a glance.',
        '',
        'Your job:',
        `1. Look at the reference material in ./bookmark to see what the post is doing.`,
        `2. Write ${input.count} DIFFERENT hooks that could open a post in the same style.`,
        '   Vary the angle — do not write five rewordings of one sentence.',
        '   They are for the operator\'s own product, not the reference\'s.',
        '',
        'Then write exactly one file, hooks.json, at the workspace root:',
        '',
        '{ "hooks": ["first hook", "second hook"] }',
        '',
        'Write hooks.json and nothing else. Do not modify any other file.',
    ].join('\n');
}

/**
 * Runs one `content-hooks` job: a short, text-only Claude call that proposes
 * hooks for the operator to choose from. Deliberately cheap — it renders
 * nothing and touches no gallery media.
 */
export async function suggestHooks(
    repository: ContentRepository,
    hookRunId: string,
    signal?: AbortSignal,
    dependencies: HookDependencies = {},
): Promise<void> {
    const runModel = dependencies.runModel ?? runClaude;
    const log = dependencies.log ?? ((line: string) => console.log(`[hooks ${hookRunId}] ${line}`));

    const run = await repository.hookRun(hookRunId);
    if (!run) return;
    await repository.updateHookRun(hookRunId, { status: 'generating', error: null });

    let workspace: string | null = null;
    try {
        const bookmark = await repository.bookmarkDetail(run.bookmarkId);
        if (!bookmark) throw new Error('Bookmark no longer exists');

        workspace = await mkdtemp(path.join(os.tmpdir(), 'content-hooks-'));
        const bookmarkWorkspace = path.join(workspace, 'bookmark');
        await mkdir(bookmarkWorkspace, { recursive: true });

        const slides = bookmark.media.filter((row) => row.role === 'slide');
        const videoRow = bookmark.media.find((row) => row.role === 'video');
        const referenceRows = slides.length > 0 ? slides : bookmark.media.filter((row) => row.role === 'cover');
        for (const row of referenceRows) {
            const source = resolveWithinDataRoot(row.relativePath);
            await copyFile(source, path.join(bookmarkWorkspace, `slide-${row.index}${path.extname(source)}`)).catch(() => {});
        }

        const prompt = buildHookPrompt({
            kind: bookmark.kind === 'video' ? 'video' : 'slideshow',
            count: HOOK_SUGGESTION_COUNT,
            templateHook: bookmark.hook,
            userPrompt: run.prompt,
            sourceCaption: bookmark.caption ?? '',
            sourceOverlays: (slides.length > 0 ? referenceRows : [videoRow].filter(Boolean) as typeof referenceRows)
                .map((row) => row.ocrText ?? ''),
            hashtags: bookmark.hashtags ?? [],
            musicName: bookmark.musicName,
        });
        await writeFile(path.join(workspace, 'PROMPT.txt'), prompt);

        log(`Asking Claude for ${HOOK_SUGGESTION_COUNT} hooks`);
        await runModel({ prompt, workspace, signal, log });

        let hooks: string[];
        try {
            hooks = validateHooks(JSON.parse(await readFile(path.join(workspace, 'hooks.json'), 'utf8')));
        } catch (error) {
            throw new Error(`Claude did not produce a usable hooks.json: ${error instanceof Error ? error.message : String(error)}`);
        }

        await repository.updateHookRun(hookRunId, { status: 'ready', hooks, finishedAt: new Date(), error: null });
        log(`Suggested ${hooks.length} hook(s)`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`Failed: ${message}`);
        await repository.updateHookRun(hookRunId, { status: 'failed', error: message, finishedAt: new Date() });
    } finally {
        if (workspace) await rm(workspace, { recursive: true, force: true });
    }
}
