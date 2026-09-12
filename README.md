# Phone Farm iOS

An open-source, standalone application for operating physical iOS devices and running scheduled TikTok workflows. It includes guided device registration, WDA/Appium supervision, live video and remote input, PostgreSQL-backed scheduling, recurring jobs, uploads, execution history, the dashboard/API server, and a built-in TikTok automation plugin.

It runs locally as-is; authentication is optional on a loopback bind. Harden it for a shared or exposed deployment by supplying your own `AuthProvider` (`PHONE_FARM_AUTH_PLUGIN`) and process supervision — no fork required. Tasks are persisted as `pluginId`, `taskType`, `taskVersion`, and a JSON payload, so an old schedule can never silently execute a new contract.

> Live demo and setup walkthrough: **[gethandler.ai/ios-farm](https://gethandler.ai/ios-farm)**
>
> The full engineering writeup, TikTok on 9 real iPhones reverse engineered from the screen up (Apple's test daemon, the two WebDriverAgent patches, pixel-level UI detection, OCR account switching, never posting twice): **[gethandler.ai/tiktok-iphone-farm](https://gethandler.ai/tiktok-iphone-farm)**

## Documentation

- [docs/getting-started.md](docs/getting-started.md) — install, configure, run, register a device
- [docs/architecture.md](docs/architecture.md) — the four processes, data stores, task model, source map
- [docs/plugins.md](docs/plugins.md) — write a plugin: tasks, execution context, versioning, panels, routes
- [docs/coordinates.md](docs/coordinates.md) — tap-layout profiles and how to add one
- [PLUGIN_DEVELOPMENT.md](PLUGIN_DEVELOPMENT.md) — plugin trust and compatibility rules
- [SECURITY.md](SECURITY.md) — before exposing the dashboard beyond loopback

## Run the standalone application

Requirements are Node 22+, PostgreSQL, Xcode, a signed real-device WebDriverAgent, and Appium's XCUITest driver.

```sh
npm install
cp .env.example .env
npm run appium:install-driver
npm run db:up
npm run db:migrate
npm run wda:prepare
```

Run the four long-lived processes in one terminal. `npm start` restarts a crashed process with backoff until a crash-loop failsafe trips (5 exits in 60s, or 10 consecutive short-lived exits). Ctrl+C stops the farm. For an always-on host, wrap each process in a `launchd` agent or systemd unit instead.

```sh
npm start
```

Or run them separately:

```sh
npm run appium
npm run wda:service
npm run worker
npm run web
```

TikTok support is enabled by default. Set `PHONE_FARM_PLUGINS` to comma-separated ESM package names to add more task plugins. Set `PHONE_FARM_AUTH_PLUGIN` to an ESM authentication provider before binding `WEB_HOST` outside loopback; startup deliberately fails otherwise.

## Content library

`/library` turns a TikTok URL into a reusable reference. Paste a link and the
farm scrapes it through Apify in the background, downloads the slides (or the
video plus its cover), OCRs the on-screen text, and stores the caption, sound,
hashtags, and view/like counts.

The library is four pages: `/library` lists your bookmarks,
`/library/bookmarks/:id` is one template in full, `/library/create` is the
create flow, and `/library/gallery` manages your own media.

Creating content is a three-step flow. Ask Claude for five hook suggestions
(steered by your own instructions if you like), tick the ones worth building or
type your own, choose the source clip and the account, and every chosen hook
becomes its own post in one batch. A hook you picked or typed is burned in
**exactly** — the model is told to copy it and the code overrides it anyway.

**The generated post matches the bookmark's kind**:

- A bookmarked **slideshow** produces a slideshow with the same number of slides.
  The installed `claude` CLI picks and orders images from your gallery and writes
  the overlay copy; `sharp` renders 1080×1920 stills.
- A bookmarked **video** produces a video of the same length. Claude picks one
  gallery clip and a trim offset inside it; ffmpeg cuts that trim, letterboxes it
  to 1080×1920, and burns the hook over it.

Every bookmark keeps the **hook** its own first frame (or slide 1) opened with,
read by OCR. A generated post always gets a fresh AI-written hook that rhymes
with it, and you can add free-text instructions to steer the result. On video the
hook is drawn TikTok-style — heavy white type with a hard black outline, no
background plate — and sits on the picture rather than on a letterbox bar.

Nothing is ever cropped to fit — a landscape source is padded with black, so the
whole frame survives. Output lands in `generatedPosts/{YYYY-MM-DD}/post_NNN/`.
Review it on the page, edit the caption, then queue it to a phone — always as a
**draft**, never a direct publish.

Your own photos and clips live in `gallery/<name>/`, which is git-ignored. Add
and remove them from the Gallery panel on `/library` — create a gallery, drop
files in, delete individual items — or bulk-load a folder from disk:

```sh
npm run gallery:import                    # the configured default folders
npm run gallery:import -- <source> <name> # any other folder
```

Set `APIFY_API_TOKEN` in `.env`; without a token the page loads but ingestion
returns 503. Ingestion and generation run on their own pg-boss queues in the
`worker` process and never occupy a device.

## Plugin contract

`src/plugin.ts` defines the stable interfaces. A plugin can provide versioned tasks, registration checks, device-page panels, namespaced HTTP routes, and declared WDA extensions. Task execution receives the exact device, that plugin's own per-device data, resolved assets, a temporary workspace, cancellation, durable logging, safe device primitives, and an observed subprocess runner.

See `PLUGIN_DEVELOPMENT.md` for compatibility and trust rules.

`src/example-plugin.ts` is a minimal open-app plugin. Production plugins should be separate packages and should never require changes to core routing or scheduler code.

## Repository policy

This repository uses GitHub-hosted CI only. Never connect production devices, Apple signing material, production databases, self-hosted runners, or deployment credentials to workflows triggered by pull requests. See `SECURITY.md`.

```sh
npm run check
```
