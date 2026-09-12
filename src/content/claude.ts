import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { httpJson } from './http.js';

// Generation uses the Claude Code CLI already installed on the host rather than
// an API SDK, so no extra key or dependency is needed. The subprocess is given
// a single job — write plan.json into its workspace — and is deliberately
// denied Bash: it reads images and writes one file, nothing more.

export interface ClaudeRunOptions {
    prompt: string;
    workspace: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    model?: string;
    binary?: string;
    log?: (line: string) => void;
}

export class ClaudeRunError extends Error {}

const RATE_LIMIT_PATTERNS = [
    /rate[- ]?limit/i,
    /429/,
    /resource exhausted/i,
    /too many requests/i,
    /request.*failed.*status.*429/i,
];

function isRateLimit(error: Error): boolean {
    return RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(error.message));
}

export function claudeArguments(workspace: string, model: string): string[] {
    return [
        '-p',
        '--output-format', 'json',
        '--model', model,
        // Read/Glob to look at the source slides and the gallery, Write to emit
        // plan.json. No Bash — nothing here needs to run a command.
        '--allowedTools', 'Read,Glob,Write',
        // Without this the subprocess would block forever waiting for a
        // permission answer that no human is there to give.
        '--permission-mode', 'acceptEdits',
        '--add-dir', workspace,
    ];
}

export async function runClaude(options: ClaudeRunOptions): Promise<string> {
    const binary = options.binary ?? process.env.CLAUDE_BIN ?? 'claude';
    const model = options.model ?? process.env.CONTENT_CLAUDE_MODEL ?? 'sonnet';
    const timeoutMs = options.timeoutMs ?? Number(process.env.CONTENT_GENERATE_TIMEOUT_MS ?? 600_000);
    const log = options.log ?? (() => {});

    return new Promise<string>((resolve, reject) => {
        const child = spawn(binary, claudeArguments(options.workspace, model), {
            cwd: options.workspace,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
        });

        let stdout = '';
        let stderr = '';
        let settled = false;

        const finish = (error: Error | null, value?: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
            if (error) reject(error); else resolve(value ?? '');
        };

        const stop = (reason: string) => {
            child.kill('SIGTERM');
            // Matches the executor's cancellation shape: ask nicely, then insist.
            setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
            finish(new ClaudeRunError(reason));
        };

        const timer = setTimeout(() => stop(`Claude did not finish within ${timeoutMs}ms`), timeoutMs);
        const onAbort = () => stop('Generation was cancelled');
        options.signal?.addEventListener('abort', onAbort, { once: true });

        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            stderr += text;
            for (const line of text.split('\n').filter(Boolean)) log(`claude: ${line}`);
        });
        child.on('error', (error) => finish(new ClaudeRunError(`Unable to run ${binary}: ${error.message}`)));
        child.on('close', (code) => {
            const last = stderr.slice(-500) || stdout.slice(-500);
            if (code !== 0) {
                finish(new ClaudeRunError(`claude exited with ${code}: ${last}`));
                return;
            }
            finish(null, stdout);
        });

        child.stdin.end(options.prompt);
    });
}

// ── DeepSeek fallback via OpenRouter ─────────────────────────────────────────

interface OpenRouterConfig {
    apiKey: string;
    model: string;
    baseUrl: string;
}

function openRouterConfig(env: NodeJS.ProcessEnv = process.env): OpenRouterConfig {
    const apiKey = env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) throw new ClaudeRunError('OPENROUTER_API_KEY not set — cannot fall back to DeepSeek');
    const requested = env.DEEPSEEK_MODEL?.trim() || 'deepseek/deepseek-v4-flash-vision-exp';
    const model = requested === 'deepseek/deepseek-v4-flash'
        ? 'deepseek/deepseek-v4-flash-vision-exp'
        : requested;
    return {
        apiKey,
        model,
        baseUrl: (env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
    };
}

/**
 * Figures out what output file the prompt expects (plan.json or hooks.json)
 * by scanning the prompt itself.
 */
function expectedOutputFile(prompt: string): string {
    if (/hooks\.json/.test(prompt)) return 'hooks.json';
    // plan.json is the default for slideshow and video prompts
    return 'plan.json';
}

/**
 * Reads workspace gallery/bookmark context and returns a markdown block
 * the model can reference when choosing files.
 */
async function workspaceContext(workspace: string): Promise<string> {
    const parts: string[] = [];

    // List gallery files (direct children only — subdirectories mean albums)
    const galleryDir = path.join(workspace, 'gallery');
    try {
        const entries = await readdir(galleryDir, { withFileTypes: true });
        const files = entries
            .filter((e) => e.isFile())
            .map((e) => e.name)
            .sort();
        if (files.length > 0) {
            parts.push('### Available gallery files');
            for (const file of files) {
                const s = await stat(path.join(galleryDir, file)).catch(() => null);
                const size = s ? ` (${(s.size / 1024).toFixed(0)} KB)` : '';
                parts.push(`- \`gallery/${file}\`${size}`);
            }
        }
    } catch { /* gallery may not exist for hooks */ }

    // List bookmark reference files
    const bookmarkDir = path.join(workspace, 'bookmark');
    try {
        const entries = await readdir(bookmarkDir, { withFileTypes: true });
        const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
        if (files.length > 0) {
            parts.push('### Reference bookmark files (look at these to understand the template)');
            for (const file of files) {
                const s = await stat(path.join(bookmarkDir, file)).catch(() => null);
                const size = s ? ` (${(s.size / 1024).toFixed(0)} KB)` : '';
                parts.push(`- \`bookmark/${file}\`${size}`);
            }
        }
    } catch { /* no bookmark */ }

    return parts.length > 0 ? parts.join('\n') : '';
}

/** Sends the prompt + workspace context to OpenRouter DeepSeek and writes the output file. */
export async function runDeepSeek(options: ClaudeRunOptions): Promise<string> {
    const config = openRouterConfig();
    const outputFile = expectedOutputFile(options.prompt);
    const log = options.log ?? (() => {});

    log(`DeepSeek fallback: ${config.model} → ${outputFile}`);

    // Build the system message — instruct the model to output the expected file shape
    const outputShape = outputFile === 'hooks.json'
        ? 'Write exactly the file content (only the JSON, no markdown fences). The file must be a JSON object with a "hooks" array of strings.'
        : 'Write exactly the file content (only the JSON, no markdown fences). The file must be a valid plan.json matching the prompt\'s requested shape.';

    // Gather workspace context so the model knows what files exist
    const context = await workspaceContext(options.workspace);
    const userContent = context
        ? `The workspace contains these files:\n\n${context}\n\n---\n\n${options.prompt}`
        : options.prompt;

    const payload = {
        model: config.model,
        response_format: { type: 'json_object' },
        messages: [
            {
                role: 'system',
                content: [
                    'You are a content-generation assistant writing structured JSON output.',
                    outputShape,
                    'Respond with ONLY the JSON — no commentary, no markdown fences.',
                ].join(' '),
            },
            { role: 'user', content: userContent },
        ],
    };

    interface ChatCompletion {
        choices?: Array<{ message?: { content?: string } }>;
    }

    const response = await httpJson<ChatCompletion>(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${config.apiKey}`,
            'content-type': 'application/json',
            'HTTP-Referer': 'https://github.com/CypherHub/prod-FARM-IOS-Core',
            'X-Title': 'phone-farm-core',
        },
        body: JSON.stringify(payload),
        timeoutMs: options.timeoutMs ?? 300_000,
        retries: 2,
    });

    const raw = response.choices?.[0]?.message?.content;
    if (!raw) throw new ClaudeRunError('DeepSeek returned an empty completion');

    // Write the output file to the workspace so the caller can read it
    const outputPath = path.join(options.workspace, outputFile);
    await writeFile(outputPath, raw, 'utf-8');
    log(`DeepSeek wrote ${outputFile}`);

    return raw;
}

// ── Claude with DeepSeek fallback ────────────────────────────────────────────

/**
 * Tries Claude Code CLI first. If Claude hits a rate limit, falls back to
 * DeepSeek via OpenRouter using the DEEPSEEK_MODEL env var.
 */
export async function runClaudeWithFallback(options: ClaudeRunOptions): Promise<string> {
    const log = options.log ?? (() => {});
    try {
        return await runClaude(options);
    } catch (error) {
        if (error instanceof ClaudeRunError && isRateLimit(error)) {
            log(`Claude rate-limited: ${error.message}`);
            log('Falling back to DeepSeek via OpenRouter');
            return runDeepSeek(options);
        }
        throw error;
    }
}
