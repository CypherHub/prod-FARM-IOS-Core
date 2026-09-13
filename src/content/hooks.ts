import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runClaude, runClaudeWithFallback } from './claude.js';
import { referenceBlock, type ReferenceInput } from './generate.js';
import { resolveWithinDataRoot } from './paths.js';
import { assertHook, normalizeHook, PlanValidationError } from './plan.js';
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
 *
 * The model can return either:
 * - `["hook1", "hook2"]` (legacy string[] format)
 * - `[{ "hook": "hook1", "caption": "caption1" }, ...]` (new object format)
 */
export function validateHooks(raw: unknown): Array<string | { hook: string; caption: string }> {
    const list = Array.isArray(raw) ? raw : (raw as { hooks?: unknown })?.hooks;
    if (!Array.isArray(list)) throw new PlanValidationError('hooks.json must hold a "hooks" array');

    const result: Array<string | { hook: string; caption: string }> = [];
    for (const [index, entry] of list.entries()) {
        if (typeof entry === 'string') {
            const hook = normalizeHook(entry);
            if (!hook) continue;
            assertHook(hook, `hooks[${index}]`);
            if (!result.some((r) => typeof r === 'string' ? r === hook : r.hook === hook)) {
                result.push(hook);
            }
        } else if (typeof entry === 'object' && entry !== null) {
            const obj = entry as Record<string, unknown>;
            const hookText = typeof obj.hook === 'string' ? normalizeHook(obj.hook) : '';
            if (!hookText) continue;
            assertHook(hookText, `hooks[${index}].hook`);
            const caption = typeof obj.caption === 'string' ? obj.caption : '';
            if (!result.some((r) => typeof r === 'string' ? r === hookText : r.hook === hookText)) {
                result.push({ hook: hookText, caption });
            }
        } else {
            throw new PlanValidationError(`hooks[${index}] must be a string or { hook, caption } object`);
        }
    }

    if (result.length === 0) throw new PlanValidationError('hooks.json produced no usable hooks');
    if (result.length > MAX_HOOKS) throw new PlanValidationError(`hooks.json must hold at most ${MAX_HOOKS} hooks`);
    return result;
}

export function buildHookPrompt(input: ReferenceInput & { kind: 'slideshow' | 'video'; count: number }): string {
    const surface = input.kind === 'video'
        ? 'burned over the video as large white text with a black outline, TikTok style'
        : 'set as the opening slide of a slideshow';
    return [
        `You are writing ${input.count} pairs of hooks and captions for a TikTok post that reuses the`,
        'structure of a reference post.',
        '',
        ...referenceBlock(input),
        '',
        `The hook is ${surface}, so keep each one short enough to read at a glance.`,
        'A hook may span several lines, and a blank line between lines is allowed when',
        'the pause helps it land — for example a question, a blank line, then the punchline.',
        '',
        'You also write a matching caption for each hook. The caption is the post text',
        'that goes in the bio area. The first line should grab attention (like the hook),',
        'then a blank line, then the body copy. Keep captions to 2-5 lines.',
        '',
        'Your job:',
        `1. Look at the reference material in ./bookmark to see what the post is doing.`,
        `2. Write ${input.count} DIFFERENT hook/caption pairs that could open a post in the same style.`,
        '   Vary the angle — do not write five rewordings of one sentence.',
        '   They are for the operator\'s own product, not the reference\'s.',
        '',
        'Then write exactly one file, hooks.json, at the workspace root:',
        '',
        '[{ "hook": "first hook", "caption": "caption for first hook" },',
        ' { "hook": "second hook", "caption": "caption for second hook" }]',
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
    const runModel = dependencies.runModel ?? runClaudeWithFallback;
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

        log(`Asking Claude for ${HOOK_SUGGESTION_COUNT} hook/caption pairs`);
        await runModel({ prompt, workspace, signal, log });

        let hooks: Array<string | { hook: string; caption: string }>;
        try {
            hooks = validateHooks(JSON.parse(await readFile(path.join(workspace, 'hooks.json'), 'utf8')));
        } catch (error) {
            throw new Error(`Claude did not produce a usable hooks.json: ${error instanceof Error ? error.message : String(error)}`);
        }

        await repository.updateHookRun(hookRunId, { status: 'ready', hooks, finishedAt: new Date(), error: null });
        log(`Suggested ${hooks.length} hook/caption pair(s)`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`Failed: ${message}`);
        await repository.updateHookRun(hookRunId, { status: 'failed', error: message, finishedAt: new Date() });
    } finally {
        if (workspace) await rm(workspace, { recursive: true, force: true });
    }
}
