import { spawn } from 'node:child_process';

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
            if (code !== 0) {
                finish(new ClaudeRunError(`claude exited with ${code}: ${stderr.slice(-500) || stdout.slice(-500)}`));
                return;
            }
            finish(null, stdout);
        });

        child.stdin.end(options.prompt);
    });
}
