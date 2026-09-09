import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const FARM_PROCESSES = ['appium', 'wda:service', 'worker', 'web'] as const;

export interface RestartPolicy {
    maxConsecutive: number;
    burst: number;
    windowMs: number;
    healthyMs: number;
    initialBackoffMs: number;
    maxBackoffMs: number;
}

export interface CrashState {
    consecutive: number;
    recent: number[];
}

export interface RestartDecision {
    action: 'restart' | 'failsafe';
    reason?: string;
    backoffMs: number;
}

export interface SuperviseOptions {
    processes?: readonly string[];
    policy?: RestartPolicy;
    lock?: boolean;
    lockPath?: string;
    spawnProcess?: (name: string) => ChildProcess;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
    write?: (stream: 'stdout' | 'stderr', chunk: string) => void;
    killTimeoutMs?: number;
}

const defaultPolicy: RestartPolicy = {
    maxConsecutive: 10,
    burst: 5,
    windowMs: 60_000,
    healthyMs: 60_000,
    initialBackoffMs: 1_000,
    maxBackoffMs: 30_000,
};

export function restartPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): RestartPolicy {
    return {
        maxConsecutive: integerEnv(env.FARM_MAX_CONSECUTIVE, defaultPolicy.maxConsecutive),
        burst: integerEnv(env.FARM_RESTART_BURST, defaultPolicy.burst),
        windowMs: integerEnv(env.FARM_RESTART_WINDOW_MS, defaultPolicy.windowMs),
        healthyMs: integerEnv(env.FARM_HEALTHY_MS, defaultPolicy.healthyMs),
        initialBackoffMs: integerEnv(env.FARM_BACKOFF_MS, defaultPolicy.initialBackoffMs),
        maxBackoffMs: integerEnv(env.FARM_MAX_BACKOFF_MS, defaultPolicy.maxBackoffMs),
    };
}

export function emptyCrashState(): CrashState {
    return { consecutive: 0, recent: [] };
}

export function recordExit(state: CrashState, exitedAt: number, livedMs: number, policy: RestartPolicy): CrashState {
    return {
        consecutive: livedMs >= policy.healthyMs ? 1 : state.consecutive + 1,
        recent: [...state.recent, exitedAt].filter((at) => exitedAt - at <= policy.windowMs),
    };
}

export function nextBackoff(consecutive: number, policy: RestartPolicy): number {
    const shift = Math.max(0, consecutive - 1);
    return Math.min(policy.maxBackoffMs, policy.initialBackoffMs * (2 ** shift));
}

export function decideRestart(state: CrashState, policy: RestartPolicy): RestartDecision {
    if (state.recent.length >= policy.burst) {
        return {
            action: 'failsafe',
            reason: `${state.recent.length} exits within ${Math.round(policy.windowMs / 1000)}s`,
            backoffMs: 0,
        };
    }
    if (state.consecutive >= policy.maxConsecutive) {
        return {
            action: 'failsafe',
            reason: `${state.consecutive} consecutive exits`,
            backoffMs: 0,
        };
    }
    return { action: 'restart', backoffMs: nextBackoff(state.consecutive, policy) };
}

export class FarmSupervisor {
    private readonly processes: readonly string[];
    private readonly policy: RestartPolicy;
    private readonly lockEnabled: boolean;
    private readonly lockPath: string;
    private readonly spawnProcess: (name: string) => ChildProcess;
    private readonly now: () => number;
    private readonly wait: (ms: number) => Promise<void>;
    private readonly write: (stream: 'stdout' | 'stderr', chunk: string) => void;
    private readonly killTimeoutMs: number;
    private readonly children = new Map<string, ChildProcess>();
    private readonly crashes = new Map<string, CrashState>();
    private readonly generation = new Map<string, number>();
    private stopping = false;
    private failsafeReason?: string;
    private lockHeld = false;
    private finished!: Promise<number>;
    private resolveFinished!: (code: number) => void;

    constructor(options: SuperviseOptions = {}) {
        this.processes = options.processes ?? FARM_PROCESSES;
        this.policy = options.policy ?? restartPolicyFromEnv();
        this.lockEnabled = options.lock !== false;
        this.lockPath = options.lockPath ?? path.resolve('.farm.lock');
        this.spawnProcess = options.spawnProcess ?? spawnFarmProcess;
        this.now = options.now ?? Date.now;
        this.wait = options.wait ?? delay;
        this.write = options.write ?? ((stream, chunk) => {
            (stream === 'stderr' ? process.stderr : process.stdout).write(chunk);
        });
        this.killTimeoutMs = options.killTimeoutMs ?? 5_000;
    }

    async start(): Promise<number> {
        this.finished = new Promise((resolve) => {
            this.resolveFinished = resolve;
        });
        if (this.lockEnabled) await this.acquireLock();
        this.write('stdout', `Starting farm (${this.processes.join(', ')}). `
            + `Crash-loop failsafe: ${this.policy.burst} exits in ${Math.round(this.policy.windowMs / 1000)}s `
            + `or ${this.policy.maxConsecutive} consecutive exits.\n`);
        for (const name of this.processes) this.launch(name);
        return this.finished;
    }

    async shutdown(reason: string): Promise<void> {
        if (this.stopping) return;
        this.stopping = true;
        this.write('stdout', `Stopping farm after ${reason}\n`);
        await this.stopAll();
        await this.releaseLock();
        this.resolveFinished(this.failsafeReason ? 1 : 0);
    }

    private launch(name: string): void {
        if (this.stopping) return;
        const id = (this.generation.get(name) ?? 0) + 1;
        this.generation.set(name, id);
        const startedAt = this.now();
        let settled = false;
        let child: ChildProcess;
        try {
            child = this.spawnProcess(name);
        } catch (error) {
            this.onExit(name, id, startedAt, error instanceof Error ? error.message : String(error));
            return;
        }
        this.children.set(name, child);
        prefixStream(child.stdout, (line) => this.write('stdout', `[${name}] ${line}`));
        prefixStream(child.stderr, (line) => this.write('stderr', `[${name}] ${line}`));
        const finish = (detail: string) => {
            if (settled || this.generation.get(name) !== id) return;
            settled = true;
            if (this.children.get(name) === child) this.children.delete(name);
            this.onExit(name, id, startedAt, detail);
        };
        child.once('error', (error) => finish(error.message));
        child.once('exit', (code, signal) => {
            finish(signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`);
        });
    }

    private onExit(name: string, id: number, startedAt: number, detail: string): void {
        if (this.stopping || this.generation.get(name) !== id) return;
        const livedMs = Math.max(0, this.now() - startedAt);
        const state = recordExit(this.crashes.get(name) ?? emptyCrashState(), this.now(), livedMs, this.policy);
        this.crashes.set(name, state);
        const decision = decideRestart(state, this.policy);
        if (decision.action === 'failsafe') {
            this.failsafeReason = `[${name}] ${decision.reason}`;
            this.write('stderr', `[${name}] exited (${detail}); failsafe: ${decision.reason} — stopping the farm\n`);
            void this.shutdown('failsafe');
            return;
        }
        this.write('stderr', `[${name}] exited (${detail}); restarting in ${Math.round(decision.backoffMs / 1000)}s\n`);
        void this.wait(decision.backoffMs).then(() => {
            if (this.stopping || this.generation.get(name) !== id) return;
            this.launch(name);
        });
    }

    private async stopAll(): Promise<void> {
        const running = [...this.children.entries()];
        this.children.clear();
        await Promise.all(running.map(([name, child]) => this.stopChild(name, child)));
    }

    private async stopChild(name: string, child: ChildProcess): Promise<void> {
        if (child.exitCode !== null || child.signalCode) return;
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        signalTree(child, 'SIGTERM');
        await Promise.race([exited, this.wait(this.killTimeoutMs)]);
        if (child.exitCode === null && child.signalCode == null) {
            this.write('stderr', `[${name}] still running after SIGTERM; sending SIGKILL\n`);
            signalTree(child, 'SIGKILL');
            await Promise.race([exited, this.wait(2_000)]);
        }
    }

    private async acquireLock(): Promise<void> {
        const pidPath = path.join(this.lockPath, 'pid');
        try {
            await mkdir(this.lockPath, { mode: 0o700 });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            const holder = await readFile(pidPath, 'utf8').then((text) => Number.parseInt(text, 10)).catch(() => Number.NaN);
            if (Number.isInteger(holder) && processAlive(holder)) {
                throw new Error(`Farm supervisor already running (pid ${holder})`);
            }
            await rm(this.lockPath, { recursive: true, force: true });
            await mkdir(this.lockPath, { mode: 0o700 });
        }
        await writeFile(pidPath, String(process.pid));
        this.lockHeld = true;
    }

    private async releaseLock(): Promise<void> {
        if (!this.lockHeld) return;
        this.lockHeld = false;
        await rm(this.lockPath, { recursive: true, force: true });
    }
}

function spawnFarmProcess(name: string): ChildProcess {
    return spawn('npm', ['run', name, '--silent'], {
        cwd: process.cwd(),
        detached: true,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

function prefixStream(stream: NodeJS.ReadableStream | null | undefined, writeLine: (line: string) => void): void {
    if (!stream) return;
    let buffer = '';
    stream.on('data', (chunk: Buffer | string) => {
        buffer += chunk.toString();
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
            writeLine(buffer.slice(0, newline + 1));
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf('\n');
        }
    });
    stream.on('end', () => {
        if (buffer) writeLine(buffer.endsWith('\n') ? buffer : `${buffer}\n`);
    });
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
    const pid = child.pid;
    if (pid) {
        try {
            process.kill(-pid, signal);
            return;
        } catch {
            // Process is not a group leader (tests, or spawn without detached).
        }
    }
    try {
        child.kill(signal);
    } catch {
        // Already gone.
    }
}

function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function integerEnv(value: string | undefined, fallback: number): number {
    if (value === undefined || value === '') return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isMain(): boolean {
    if (!process.argv[1]) return false;
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

async function main(): Promise<void> {
    const farm = new FarmSupervisor();
    const stop = (signal: string) => {
        void farm.shutdown(signal);
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
    try {
        process.exitCode = await farm.start();
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    }
}

if (isMain()) void main();
