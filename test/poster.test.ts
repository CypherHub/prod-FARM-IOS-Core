import assert from 'node:assert/strict';
import test from 'node:test';

import {
    PosterConfigError, defaultPosterConfig, emptyPosterState, parsePosterState, validatePosterConfig,
} from '../src/poster/config.js';
import { applyPlan, applyRunFinish, nextPosterAction, slotSucceeded } from '../src/poster/tick.js';
import {
    DEFAULT_TIMEZONE, POST_DURATION_BUFFER_MS, POSTER_WINDOW_IDS, nextRetryAt, openWindows, planTime, postWorkflowName,
    slotKey, switchWorkflowName, wallTimeToUtc, zonedClock,
} from '../src/poster/windows.js';
import { createPosterHttpClient, findWorkflowByName } from '../src/poster/client.js';

const TZ = DEFAULT_TIMEZONE;
const ALL = [...POSTER_WINDOW_IDS];

test('zonedClock and openWindows follow New York wall time', () => {
    // 2026-09-19 is EDT (UTC-4).
    const nineThirty = new Date('2026-09-19T13:30:00.000Z'); // 9:30am
    assert.equal(zonedClock(nineThirty, TZ).date, '2026-09-19');
    assert.equal(zonedClock(nineThirty, TZ).minutes, 9 * 60 + 30);
    assert.deepEqual(openWindows(nineThirty, TZ, ALL).map((window) => window.id), ['9am-noon']);

    const noon = new Date('2026-09-19T16:00:00.000Z'); // 12:00pm
    assert.deepEqual(openWindows(noon, TZ, ALL).map((window) => window.id), ['noon-3pm']);

    const three = new Date('2026-09-19T19:00:00.000Z'); // 3:00pm
    assert.deepEqual(openWindows(three, TZ, ALL).map((window) => window.id), ['3pm-6pm']);

    const six = new Date('2026-09-19T22:00:00.000Z'); // 6:00pm
    assert.deepEqual(openWindows(six, TZ, ALL).map((window) => window.id), ['6pm-9pm']);

    const ninePm = new Date('2026-09-20T01:00:00.000Z'); // 9:00pm
    assert.deepEqual(openWindows(ninePm, TZ, ALL).map((window) => window.id), ['9pm-midnight']);

    const midnight = new Date('2026-09-20T04:00:00.000Z'); // 12:00am
    assert.deepEqual(openWindows(midnight, TZ, ALL), []);

    assert.deepEqual(openWindows(nineThirty, TZ, ['6pm-9pm']), []);
});

test('wallTimeToUtc round-trips a New York 9am slot start and midnight end', () => {
    const start = wallTimeToUtc(TZ, 2026, 9, 19, 9, 0);
    const clock = zonedClock(start, TZ);
    assert.equal(clock.date, '2026-09-19');
    assert.equal(clock.minutes, 9 * 60);

    const end = wallTimeToUtc(TZ, 2026, 9, 19, 24, 0);
    assert.equal(zonedClock(end, TZ).date, '2026-09-20');
    assert.equal(zonedClock(end, TZ).minutes, 0);
});

test('planTime stays inside the remaining window and leaves a duration buffer', () => {
    const now = new Date('2026-09-19T13:00:00.000Z'); // 9:00am EDT
    const end = wallTimeToUtc(TZ, 2026, 9, 19, 12, 0);
    const latest = end.getTime() - POST_DURATION_BUFFER_MS;

    const early = planTime(now, end, () => 0);
    assert.ok(early);
    assert.equal(early.getTime(), now.getTime());

    const late = planTime(now, end, () => 1);
    assert.ok(late);
    assert.equal(late.getTime(), latest);
    assert.ok(late.getTime() < end.getTime());

    const tooLate = new Date(latest + 1);
    assert.equal(planTime(tooLate, end, () => 0.5), null);
});

test('nextRetryAt doubles from 2 minutes and caps at 15', () => {
    const now = new Date('2026-09-19T13:00:00.000Z');
    assert.equal(nextRetryAt(now, 1).getTime() - now.getTime(), 2 * 60_000);
    assert.equal(nextRetryAt(now, 2).getTime() - now.getTime(), 4 * 60_000);
    assert.equal(nextRetryAt(now, 3).getTime() - now.getTime(), 8 * 60_000);
    assert.equal(nextRetryAt(now, 4).getTime() - now.getTime(), 15 * 60_000);
});

test('validatePosterConfig rejects unknown windows and accounts, and locks NYC time', () => {
    assert.throws(() => validatePosterConfig({ windows: ['night'] }), PosterConfigError);
    assert.throws(() => validatePosterConfig({ accounts: { '@nobody': { enabled: true } } }), PosterConfigError);
    const merged = validatePosterConfig({
        enabled: true, timezone: 'Not/A_Zone', windows: ['noon-3pm'],
    }, defaultPosterConfig());
    assert.equal(merged.enabled, true);
    assert.equal(merged.timezone, 'America/New_York');
    assert.deepEqual(merged.accounts['@pixl.robotics'].windows, ['noon-3pm']);
    assert.deepEqual(merged.accounts['@my_sane_tea'].windows, ['noon-3pm']);
    const disabled = validatePosterConfig({
        accounts: { 'my_sane_tea': { enabled: false } },
    });
    assert.equal(disabled.accounts['@my_sane_tea'].enabled, false);
    assert.equal(disabled.accounts['@pixl.robotics'].enabled, true);
    assert.deepEqual(disabled.accounts['@pixl.robotics'].windows, ['9am-noon', '6pm-9pm']);
    const legacy = validatePosterConfig({ windows: ['morning', 'evening'] });
    assert.deepEqual(legacy.accounts['@pixl.robotics'].windows, ['9am-noon', '3pm-6pm']);
});

test('each account can keep its own posting windows', () => {
    const config = validatePosterConfig({
        enabled: true,
        accounts: {
            '@pixl.robotics': { windows: ['9am-noon'] },
            '@my_sane_tea': { windows: ['6pm-9pm'] },
        },
    });
    assert.deepEqual(config.accounts['@pixl.robotics'].windows, ['9am-noon']);
    assert.deepEqual(config.accounts['@my_sane_tea'].windows, ['6pm-9pm']);

    const morning = new Date('2026-09-19T13:30:00.000Z');
    const pixlPlan = nextPosterAction(config, emptyPosterState(), morning, [], () => 0);
    assert.equal(pixlPlan.type, 'plan');
    if (pixlPlan.type !== 'plan') throw new Error('expected plan');
    assert.equal(pixlPlan.handle, '@pixl.robotics');
    assert.equal(pixlPlan.windowId, '9am-noon');

    const evening = new Date('2026-09-19T22:00:00.000Z'); // 6pm NYC
    const teaPlan = nextPosterAction(config, emptyPosterState(), evening, [], () => 0);
    assert.equal(teaPlan.type, 'plan');
    if (teaPlan.type !== 'plan') throw new Error('expected plan');
    assert.equal(teaPlan.handle, '@my_sane_tea');
    assert.equal(teaPlan.windowId, '6pm-9pm');

    const patched = validatePosterConfig({
        accounts: { '@pixl.robotics': { windows: ['noon-3pm'] } },
    }, config);
    assert.deepEqual(patched.accounts['@pixl.robotics'].windows, ['noon-3pm']);
    assert.deepEqual(patched.accounts['@my_sane_tea'].windows, ['6pm-9pm']);
    assert.equal(patched.accounts['@my_sane_tea'].enabled, true);
});

test('nextPosterAction plans then runs one post per account per window and skips successes', () => {
    const now = new Date('2026-09-19T13:30:00.000Z');
    const config = validatePosterConfig({
        enabled: true,
        windows: ['9am-noon', '6pm-9pm'],
    });
    let state = emptyPosterState();

    assert.equal(nextPosterAction(config, state, now, [], () => 0).type, 'plan');
    const plan = nextPosterAction(config, state, now, [], () => 0);
    assert.equal(plan.type, 'plan');
    if (plan.type !== 'plan') throw new Error('expected plan');
    assert.equal(plan.handle, '@pixl.robotics');
    assert.equal(plan.windowId, '9am-noon');
    state = applyPlan(state, plan.key, plan.plannedAt);

    const due = nextPosterAction(config, state, now, []);
    assert.equal(due.type, 'run');
    if (due.type !== 'run') throw new Error('expected run');
    assert.equal(due.handle, '@pixl.robotics');

    state = applyRunFinish(state, due, { status: 'succeeded' }, now);
    assert.equal(slotSucceeded(state.slots[plan.key]), true);

    const nextAccount = nextPosterAction(config, state, now, [], () => 0);
    assert.equal(nextAccount.type, 'plan');
    if (nextAccount.type !== 'plan') throw new Error('expected plan');
    assert.equal(nextAccount.handle, '@my_sane_tea');

    const paused = nextPosterAction({ ...config, enabled: false }, state, now);
    assert.deepEqual(paused, { type: 'idle', reason: 'poster is paused' });
});

test('a failed post is not complete and retries after backoff, not immediately', () => {
    const now = new Date('2026-09-19T13:30:00.000Z');
    const config = validatePosterConfig({
        enabled: true,
        windows: ['9am-noon'],
        accounts: { '@my_sane_tea': { enabled: false } },
    });
    const key = slotKey('2026-09-19', '9am-noon', '@pixl.robotics');
    let state = applyPlan(emptyPosterState(), key, now.toISOString());
    const run = { type: 'run' as const, key, handle: '@pixl.robotics' as const, windowId: '9am-noon' as const };
    state = applyRunFinish(state, run, { status: 'failed', error: 'timeout' }, now);

    assert.equal(state.slots[key]?.status, 'failed');
    assert.equal(nextPosterAction(config, state, now).type, 'idle');

    const later = new Date(now.getTime() + 3 * 60_000);
    const retry = nextPosterAction(config, state, later);
    assert.equal(retry.type, 'run');
    if (retry.type !== 'run') throw new Error('expected run');
    assert.equal(retry.handle, '@pixl.robotics');
});

test('run-now posts immediately even when paused, using the open window when one exists', () => {
    const now = new Date('2026-09-19T13:30:00.000Z');
    const paused = validatePosterConfig({ enabled: false, windows: ['9am-noon'] });
    const action = nextPosterAction(paused, emptyPosterState(), now, [
        { handle: '@my_sane_tea', requestedAt: now.toISOString() },
    ]);
    assert.equal(action.type, 'run');
    if (action.type !== 'run') throw new Error('expected run');
    assert.equal(action.handle, '@my_sane_tea');
    assert.equal(action.windowId, 'now');

    const live = validatePosterConfig({ enabled: true, windows: ['9am-noon'] });
    const inWindow = nextPosterAction(live, emptyPosterState(), now, [
        { handle: '@pixl.robotics', requestedAt: now.toISOString() },
    ]);
    assert.equal(inWindow.type, 'run');
    if (inWindow.type !== 'run') throw new Error('expected run');
    assert.equal(inWindow.windowId, '9am-noon');
});

test('workflow names match the live farm workflows and findWorkflowByName keeps the latest clone', () => {
    assert.equal(switchWorkflowName('@pixl.robotics'), 'Switch Account to @pixl.robotics');
    assert.equal(postWorkflowName('@my_sane_tea'), 'Post from Drafts of @my_sane_tea');
    const found = findWorkflowByName([
        { id: 'old', name: 'Switch Account to @pixl.robotics' },
        { id: 'new', name: 'Switch Account to @pixl.robotics' },
    ], 'Switch Account to @pixl.robotics');
    assert.equal(found?.id, 'new');
});

test('parsePosterState ignores corrupt payloads', () => {
    assert.deepEqual(parsePosterState(null).slots, {});
    assert.deepEqual(parsePosterState('nope').history, []);
});

test('poster HTTP client posts {} so Fastify accepts replay without a payload', async () => {
    const calls: RequestInit[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push(init ?? {});
        return new Response(JSON.stringify({ runId: 'r1' }), {
            status: 202, headers: { 'content-type': 'application/json' },
        });
    }) as typeof fetch;
    try {
        await createPosterHttpClient('http://127.0.0.1:3000').post('/api/workflows/abc/replay');
        assert.equal(calls[0]?.body, '{}');
        assert.equal((calls[0]?.headers as Record<string, string>)['content-type'], 'application/json');
    } finally {
        globalThis.fetch = original;
    }
});
