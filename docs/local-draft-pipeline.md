# Local draft pipeline (Claude Code runbook)

A conversational way to repurpose a bookmarked video into new draft posts on
a different gallery/account: ask two questions, research hooks, get
confirmation, then build drafts on the phone **one at a time**, never
publishing. This doc is written so an agent (or a person) can follow it
without the rest of the conversation history — paste its path into a new
chat and say "follow this."

Everything here talks to the already-running farm (`npm start`,
`http://127.0.0.1:3000`) over its existing HTTP API. No new endpoints, no
code changes — this is a usage pattern, not a feature.

## When to use this

The user has a bookmarked source video (`/library/create?bookmark=<id>`) and
wants variations of it posted as **drafts** — never published automatically —
to one of the accounts on a registered device, using a different footage
folder and a batch of on-screen-text hooks.

## Step 0 — the two questions

Before generating anything, get:

1. **Gallery** — which footage folder backs the new clips. `GET
   /api/gallery` lists what exists (name, image/video counts).
2. **Account** — which TikTok account, and therefore which device. `GET
   /api/devices` lists registered devices and `pluginData["com.git-agni.tiktok"].accounts`
   per device.

Also settle, once, up front:

- **Clip length** (`targetSeconds`) — the doc's worked examples used 5s.
- **How hooks get written** — see Step 1.
- **How many drafts** — the user may want a small taste first, then "build
  them all" once they like the direction.

Do not touch the device until the user has approved the actual hook/caption
list (Step 3) — generating text is free, phone automation is not.

## Step 1 — research the hooks (optional but recommended)

If the target account has an established voice, use the `lightreel` MCP
(`ask_lightreel`) rather than guessing blind:

- First call: give it the source video's TikTok URL, stats, and ask it to
  (a) look up the target account's actual niche/tone, (b) explain why the
  source video is outperforming its baseline, (c) propose one hook+caption
  in that voice. Reuse the returned `conversationId` for every follow-up in
  the same thread — Lightreel keeps account/voice context across calls.
- Ask for a **large option set** (e.g. 50 hook+caption pairs, index-aligned,
  `response_fields: {hooks: array, captions: array}`) rather than one guess.
  Explicitly ask for range across *different rhetorical mechanisms* (POV,
  myth-busting, listicle, confession, direct callout, comparison, news-style,
  challenge, story arc) — one repeated joke reworded fifty times reads as
  "brand voice," not fifty real options.
- If the product/brand has concrete facts sitting in the repo (check
  `contentTemplates/*/README.md`, `*/peers.json`, `*/caption.txt` — e.g. the
  Pixl Nub facts in `contentTemplates/instead-of-king-slideshow/`), ground
  the copy in those instead of inventing claims. Real specs beat generic
  copywriting every time.
- Iterate live on tone with the user ("more authentic," "less ad-copy," "use
  the word X instead of Y for A/B testing") before building anything.

`ask_lightreel` allows **one call per user turn** and each research pass
takes a few minutes — kick it off, tell the user it's running, and poll
`get_conversation` (up to `wait_seconds: 50` per call) rather than blocking.

## Step 2 — ground the music, never invent a URL

Local drafts inherit `musicUrl` from the source bookmark by default. To vary
the sound across a batch, only ever reuse **real, already-known** TikTok
music URLs — pull the pool from `GET /api/bookmarks?limit=500` (dedupe on
`musicUrl`). Never fabricate a `tiktok.com/music/...` URL.

There is no API field to set a custom `musicUrl` on a local draft — the
create and patch routes don't expose it (`src/workflow-plugin.ts`, the
`/api/bookmarks/:id/local-drafts` and `/api/local-drafts/:id` handlers). The
only way in is a direct, narrowly-scoped `UPDATE`:

```sql
UPDATE scheduler.local_drafts SET music_url = $1, updated_at = now() WHERE id = $2;
```

Run it with `pg` against `DATABASE_URL` from `.env`. Touch only the
`music_url` column on drafts you just created.

## Step 3 — confirm, then create the drafts

Present the final hook/caption list and get explicit approval before
creating anything. Once approved, one API call creates the whole batch:

```
POST /api/bookmarks/:id/local-drafts
{
  "hooks": [{ "text": "...", "caption": "..." }, ...],   // up to N, order preserved
  "galleryName": "<gallery from Step 0>",
  "deviceUdid": "<device udid>",
  "account": "@<handle>",
  "targetSeconds": 5
}
```

This auto-picks a random clip per hook from the gallery and a non-overlapping
trim window sized to `targetSeconds` — no need to hand-pick clips. Response
is `{ drafts: [...] }`, one row per hook, same order as the input.

## Step 4 — make sure the phone is on the right account

There's a saved **Account Switcher** workflow (find it via `GET
/api/workflows`, currently id `b21caffc-665c-42e5-a0af-a70eea45e60e` on
device `00008020-000819CA2203002E` / "Nu Work") with a `switch_account` step
and an `if_condition` step ("skip if already on the target"). **Both must be
patched to the current target before every run**, not just the
`switch_account` step:

```
PATCH /api/workflow-steps/<switch_account step id>
{ "text": "<handle, no @>" }

PATCH /api/workflow-steps/<if_condition step id>
{ "aiQuestion": "Is the current TikTok account already @<handle>? If yes, skip the switch." }
```

**Why both:** the `if_condition`'s question is plain static text, not
templated. If you only patch the `switch_account` step and leave the
condition asking about a *different* account, it never recognizes "already
there," always attempts a real switch even when unnecessary, and that
redundant switch can itself time out. Patching both before every replay
makes the whole workflow idempotent — safe to run before every batch, even
back-to-back for the same account.

Then: `POST /api/workflows/<id>/replay`, poll `GET
/api/workflow-runs/<runId>` until `status` is `succeeded` — abort the batch
if it isn't.

Re-run this account check any time the run resumes after a pause (a human
may have picked up and navigated the phone in the meantime — see Step 6).

## Step 5 — queue drafts one at a time, never in parallel

Find the **"Create Draft (clone)"** workflow (currently id
`d33cf27d-a7f9-4581-99cc-bc45d46296a3`, same device) — the one with an
`import_video` step, an `open_url` step pointed at a music page, a
`type_keys` caption step, and a final tap on **"Save Drafts"** (never
"Post"). Confirm that last property by reading its steps
(`GET /api/workflows/<id>`) before trusting it — a similarly-named
"Post from Drafts of @my_sane_tea" on the same device actually **publishes** an existing
draft; do not use it here.

For each draft, strictly sequential — wait for one to finish before starting
the next, even though the server's own per-device queue would serialize
concurrent calls anyway. Going one at a time keeps failures attributable and
keeps you from queuing 50 phone-automation runs before noticing the first
one is broken:

```
POST /api/local-drafts/<id>/queue-via-workflow
{ "workflowId": "<Create Draft (clone) id>" }
```

→ `{ runId, status: "pending" }`. Poll `GET /api/workflow-runs/<runId>`
every ~5s until `status` is `succeeded`, `failed`, or `stopped`, **then**
move to the next draft.

## Step 6 — run it resiliently, in the background

A batch of more than a handful of drafts takes a long time (roughly 1.5–3
min of real phone automation each) and this stack has genuine, recurring
failure modes that are not the user's fault. Build the runner defensively
from the start:

- **Run it with `run_in_background: true`**, log to a file, and poll the log
  — don't block a whole chat turn on a 30–90 minute batch.
- **Never let one draft's failure stop the batch.** Wrap each attempt in its
  own `try/catch`; log the outcome and move on. `failed` and `stopped` are
  normal, expected outcomes (Appium timeouts, or the workflow's own
  vision-check declining to guess at an unexpected screen) — not batch-ending
  errors.
- **Persist progress to a JSON results file** (`{draftId: {status, hook,
  runId}}`) after every single draft, not just at the end. A crash — a
  server restart, a network blip to the (remote) Postgres host, the phone
  dying — should only cost the in-flight draft, never the whole batch.
  Resuming means: reload the results file, skip anything already
  `succeeded`, continue.
- **Do a final retry pass** over everything that didn't succeed on the first
  pass, after the first pass finishes — don't retry inline (that reorders
  the batch and makes progress harder to read).
- **Guard the `pg` client.** A raw `pg.Client` can emit an async `'error'`
  event (e.g. a transient `ETIMEDOUT` on the remote DB) *outside* the
  awaited call chain. Node treats an unheard `'error'` event on an
  `EventEmitter` as fatal and crashes the process — **no surrounding
  try/catch will save you.** Always attach `client.on('error', ...)` before
  using it. Add `process.on('uncaughtException'|'unhandledRejection', ...)`
  as a last-resort net too; this stack hits enough transient infra noise
  (dev-server restarts, remote DB) that a single stray error should never be
  allowed to take down a 50-item batch.
- **Bound every fetch with a timeout/AbortController.** A hung request to a
  restarting dev server otherwise hangs the whole loop.

A known-working runner shape (fill in the constants, run with
`node <file>.mjs`, delete it when the batch is done — treat it as scratch,
not a repo artifact):

```js
const BASE = 'http://127.0.0.1:3000';
// ...BOOKMARK_ID, DEVICE_UDID, ACCOUNT, GALLERY, workflow ids, MUSIC_POOL, HOOKS...

async function j(method, path, body, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + path, {
      method, headers: { 'content-type': 'application/json', origin: BASE },
      body: body ? JSON.stringify(body) : undefined, signal: controller.signal,
    });
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
    return parsed;
  } finally { clearTimeout(timer); }
}

async function waitForRun(runId, label, maxWaitMs = 8 * 60_000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const run = await j('GET', `/api/workflow-runs/${runId}`, undefined, 10000);
      if (['succeeded', 'failed', 'stopped'].includes(run.status)) return run.status;
    } catch (err) { console.log(`${label} poll error (retrying): ${err.message}`); }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return 'timeout';
}

async function setMusicUrl(draftId, musicUrl) {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  client.on('error', (err) => console.log(`pg error (handled): ${err.message}`));
  await client.connect();
  try {
    await client.query('UPDATE scheduler.local_drafts SET music_url = $1, updated_at = now() WHERE id = $2', [musicUrl, draftId]);
  } finally { try { await client.end(); } catch {} }
}

async function attemptDraft(draftId, label, musicUrl, createDraftWorkflowId) {
  try {
    const info = await j('GET', `/api/local-drafts/${draftId}`, undefined, 10000);
    await setMusicUrl(draftId, musicUrl);
    const queued = await j('POST', `/api/local-drafts/${draftId}/queue-via-workflow`, { workflowId: createDraftWorkflowId }, 20000);
    return { status: await waitForRun(queued.runId, label), runId: queued.runId, hook: info.hook };
  } catch (err) {
    return { status: 'error', error: err.message };
  }
}

// main(): patch account-switch steps -> replay -> wait succeeded ->
// create drafts -> pass 1 (attemptDraft per id, save results.json after each)
// -> retry pass over non-succeeded -> print summary. See git history on the
// content-library branch for a complete worked version.
```

## Step 7 — watch the physical device, not just the API

This automates a real iPhone. Things that only show up by looking:

- **Battery.** Screenshot the device (`GET
  /api/devices/<udid>/remote/screenshot`) if a batch stalls or the
  background process dies unexpectedly. A "Low Battery" system dialog blocks
  the whole UI and will cause every subsequent step to fail/time out — pause
  and ask the user to charge it rather than retrying blindly.
- **Account drift.** If a run is paused for any reason (charging, a person
  picking up the phone), don't assume the account/screen state on resume —
  re-run Step 4's account check and look at a screenshot before queuing more
  drafts.
- **A stray screen is usually self-healing.** The `Create Draft (clone)`
  workflow's first real steps (`unlock`, then `open_url` with a TikTok deep
  link) force an app switch regardless of what's currently foregrounded, so
  a leftover Safari sheet or half-finished screen from an interrupted run
  usually clears itself on the next attempt. Still worth a screenshot before
  resuming a batch that died mid-flight, to make sure nothing more unusual
  happened.
- **Never publish.** Every workflow used here ends at "Save to Drafts."
  Verify that by reading a workflow's steps before pointing anything new at
  it — don't trust a name alone (see the "Post from Drafts of @my_sane_tea" trap in Step 5).

## Reference

| Thing | Value (Nu Work device, re-verify if it changes) |
| --- | --- |
| Device UDID | `00008020-000819CA2203002E` |
| Accounts on this device | `@pixl.robotics`, `@my_sane_tea`, `@nikolai_tesla1` |
| Account Switcher workflow | `b21caffc-665c-42e5-a0af-a70eea45e60e` |
| — its `switch_account` step | `109626b2-e55d-4638-841f-25c097a3c813` |
| — its `if_condition` step | `4d48329a-3bfd-4080-9a11-cdf460685e0e` |
| Create Draft (clone) workflow | `d33cf27d-a7f9-4581-99cc-bc45d46296a3` |

Re-discover these with `GET /api/workflows` and `GET
/api/workflows/<id>` (lists steps + ids) if the workflow set changes — don't
assume the ids above are permanent.
