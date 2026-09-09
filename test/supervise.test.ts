import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
    decideRestart,
    emptyCrashState,
    FarmSupervisor,
    nextBackoff,
    recordExit,
    restartPolicyFromEnv,
    type RestartPolicy,
} from '../src/supervise.js';

type FakeChild = {
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    killed: boolean;
    kill(signal?: NodeJS.Signals): boolean;
    once(event: string, listener: (...args: unknown[]) => void): FakeChild;
    exit(code?: number | null, signal?: NodeJS.Signals | null): void;
};

const policy: RestartPolicy = {
    maxConsecutive: 3,
    burst: 3,
    windowMs: 10_000,
    healthyMs: 5_000,
    initialBackoffMs: 1_000,
    maxBackoffMs: 8_000,
};

test('restartPolicyFromEnv uses defaults and rejects non-positive values', () => {
    const defaults = restartPolicyFromEnv({});
    assert.equal(defaults.burst, 5);
    assert.equal(defaults.maxConsecutive, 10);
    assert.equal(restartPolicyFromEnv({ FARM_RESTART_BURST: '2' }).burst, 2);
    assert.equal(restartPolicyFromEnv({ FARM_RESTART_BURST: '0' }).burst, defaults.burst);
    assert.equal(restartPolicyFromEnv({ FARM_BACKOFF_MS: 'nope' }).initialBackoffMs, defaults.initialBackoffMs);
});

test('recordExit resets the consecutive count after a healthy run', () => {
    const first = recordExit(emptyCrashState(), 1_000, 100, policy);
    assert.equal(first.consecutive, 1);
    const afterHealthy = recordExit(first, 10_000, policy.healthyMs, policy);
    assert.equal(afterHealthy.consecutive, 1);
    const afterCrash = recordExit(first, 2_000, 100, policy);
    assert.equal(afterCrash.consecutive, 2);
});

test('recordExit forgets crashes outside the failsafe window', () => {
    const first = recordExit(emptyCrashState(), 1_000, 100, policy);
    const second = recordExit(first, 1_000 + policy.windowMs + 1, 100, policy);
    assert.equal(second.recent.length, 1);
});

test('nextBackoff doubles until the cap', () => {
    assert.equal(nextBackoff(1, policy), 1_000);
    assert.equal(nextBackoff(2, policy), 2_000);
    assert.equal(nextBackoff(3, policy), 4_000);
    assert.equal(nextBackoff(4, policy), 8_000);
    assert.equal(nextBackoff(8, policy), 8_000);
});

test('decideRestart trips after a burst of exits in the window', () => {
    let state = emptyCrashState();
    const decisions = [];
    for (let i = 0; i < 3; i += 1) {
        state = recordExit(state, i * 10, 50, policy);
        decisions.push(decideRestart(state, policy));
    }
    assert.equal(decisions[0]?.action, 'restart');
    assert.equal(decisions[1]?.action, 'restart');
    assert.equal(decisions[2]?.action, 'failsafe');
    assert.match(decisions[2]?.reason ?? '', /3 exits within 10s/);
});

test('decideRestart trips after too many consecutive short-lived exits', () => {
    const longWindow: RestartPolicy = { ...policy, burst: 99, maxConsecutive: 3 };
    let state = emptyCrashState();
    state = recordExit(state, 1, 10, longWindow);
    state = recordExit(state, 2, 10, longWindow);
    assert.equal(decideRestart(state, longWindow).action, 'restart');
    state = recordExit(state, 3, 10, longWindow);
    const decision = decideRestart(state, longWindow);
    assert.equal(decision.action, 'failsafe');
    assert.match(decision.reason ?? '', /3 consecutive exits/);
});

test('FarmSupervisor restarts a process that exits, then stops on failsafe', async () => {
    const spawned: FakeChild[] = [];
    const logs: string[] = [];
    const farm = new FarmSupervisor({
        processes: ['web'],
        lock: false,
        policy,
        wait: async () => {},
        write: (_stream, chunk) => { logs.push(chunk); },
        spawnProcess: () => {
            const child = fakeChild();
            spawned.push(child);
            return child as unknown as import('node:child_process').ChildProcess;
        },
    });

    const done = farm.start();
    await waitFor(() => spawned.length === 1);
    spawned[0]?.exit(1);
    await waitFor(() => spawned.length === 2);
    spawned[1]?.exit(1);
    await waitFor(() => spawned.length === 3);
    spawned[2]?.exit(1);

    assert.equal(await done, 1);
    assert.equal(spawned.length, 3);
    assert.match(logs.join(''), /failsafe: 3 exits within 10s/);
});

test('FarmSupervisor shutdown does not relaunch stopped processes', async () => {
    const spawned: FakeChild[] = [];
    const farm = new FarmSupervisor({
        processes: ['worker'],
        lock: false,
        policy,
        wait: async () => {},
        write: () => {},
        spawnProcess: () => {
            const child = fakeChild();
            spawned.push(child);
            return child as unknown as import('node:child_process').ChildProcess;
        },
    });

    const done = farm.start();
    await waitFor(() => spawned.length === 1);
    await farm.shutdown('SIGINT');
    spawned[0]?.exit(0, 'SIGTERM');

    assert.equal(await done, 0);
    assert.equal(spawned.length, 1);
});

function fakeChild(): FakeChild {
    const child = new EventEmitter() as EventEmitter & FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    child.kill = (signal?: NodeJS.Signals) => {
        child.killed = true;
        child.exit(0, signal ?? 'SIGTERM');
        return true;
    };
    child.exit = (code = 0, signal = null) => {
        if (child.exitCode !== null || child.signalCode) return;
        child.exitCode = signal ? null : code;
        child.signalCode = signal;
        child.emit('exit', child.exitCode, child.signalCode);
    };
    return child;
}

async function waitFor(ready: () => boolean, timeoutMs = 1_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!ready()) {
        if (Date.now() > deadline) throw new Error('timed out waiting for supervisor state');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
