#!/usr/bin/env node
// Syncs iCloud Shared Albums into gallery/<album-name>/ using Apple's
// sharedstreams API (icloudpd cannot access shared albums directly).
//
// Set your album URLs in .env:
//   SHARED_ALBUM_THASAN_PIXL=https://www.icloud.com/sharedalbum/#TOKEN
//   SHARED_ALBUM_PIXL_ROBOTICS=https://www.icloud.com/sharedalbum/#TOKEN
//   SHARED_ALBUM_NOMAD_FOUNDER=https://www.icloud.com/sharedalbum/#TOKEN
//
// To get the URL: open icloud.com/photos → Shared Albums → click an album →
// share icon → "Copy Link"
//
// Runs incrementally — already-downloaded files are skipped by checksum.

import { mkdir, stat, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';

const DEFAULT_HOST = 'p23-sharedstreams.icloud.com';
const ROOT = path.resolve(process.env.CONTENT_GALLERY_DIR ?? 'gallery');
const STATE_FILE = path.join(ROOT, '.shared-album-state.json');

/** Cache of resolved hosts per album token: token → host. */
const hostCache = new Map();

// ── Album configuration ──────────────────────────────────────────────────────
const ALBUMS = [
  { name: 'Thasan Pixl',            env: 'SHARED_ALBUM_THASAN_PIXL' },
  { name: 'Pixl Robotics Footage',  env: 'SHARED_ALBUM_PIXL_ROBOTICS' },
  { name: 'Nomad Founder Footage',   env: 'SHARED_ALBUM_NOMAD_FOUNDER' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function getToken(envName) {
  const url = process.env[envName];
  if (!url) return null;
  // Token is the part after # in the shared album URL
  const hash = url.split('#')[1];
  if (!hash) return null;
  return hash.split('/')[0].split('?')[0];
}

async function postJSON(url, body, host) {
  const fullUrl = `https://${host}${url}`;
  const res = await fetch(fullUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  // Apple responds with 330 + X-Apple-MMe-Host when the album lives on
  // a different sharedstreams host. Retry against the correct host.
  if (res.status === 330) {
    const correctHost = res.headers.get('X-Apple-MMe-Host');
    if (!correctHost) {
      throw new Error(`POST ${fullUrl} returned 330 but no X-Apple-MMe-Host header`);
    }
    // Cache the resolved host keyed by the album's token (first path segment)
    const token = url.split('/')[1];
    if (token) hostCache.set(token, correctHost);
    return postJSON(url, body, correctHost);
  }

  if (!res.ok) {
    throw new Error(`POST ${fullUrl} returned ${res.status}: ${await res.text().catch(() => '')}`);
  }
  return res.json();
}

/** Read state file for album — a Set of already-downloaded checksums. */
async function loadState(albumName) {
  try {
    const raw = await readFile(STATE_FILE, 'utf-8');
    const map = JSON.parse(raw);
    return new Set(map[albumName] || []);
  } catch { return new Set(); }
}

/** Persist state for this album. */
async function saveState(albumName, checksums) {
  let map = {};
  try {
    const raw = await readFile(STATE_FILE, 'utf-8');
    map = JSON.parse(raw);
  } catch {}
  map[albumName] = [...checksums];
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(map, null, 2));
}

/** Download a file from URL → local path, skip if already downloaded. */
async function downloadFile(url, targetFile, checksum, downloadedSet) {
  if (downloadedSet.has(checksum)) return 'skipped';

  // Also check if the file physically exists (supports manual cleanup)
  try {
    await stat(targetFile);
    downloadedSet.add(checksum);
    return 'skipped';
  } catch { /* doesn't exist, proceed */ }

  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`    ⚠ HTTP ${res.status} for ${checksum}`);
    return 'failed';
  }

  // Try to get filename from Content-Disposition header
  const cd = res.headers.get('content-disposition');
  let filename = null;
  if (cd) {
    const m = cd.match(/filename["*]?\s*=\s*"?([^";\n]+)"?/i);
    if (m) filename = m[1];
  }
  if (!filename) {
    // Guess extension from content-type
    const ct = res.headers.get('content-type') || '';
    const ext = ct.startsWith('video/') ? '.mov' : '.jpg';
    filename = `${checksum}${ext}`;
  }

  const resolved = path.join(path.dirname(targetFile), filename);
  const file = createWriteStream(resolved);
  await new Promise((resolve, reject) => {
    // @ts-ignore - Node 22 web stream → native stream
    Readable.fromWeb(res.body).pipe(file).on('finish', resolve).on('error', reject);
  });

  downloadedSet.add(checksum);
  return 'downloaded';
}

// ── Sync one album ───────────────────────────────────────────────────────────

async function syncAlbum(album) {
  const token = getToken(album.env);
  if (!token) {
    console.log(`  ⏭ "${album.name}": no URL configured (set ${album.env})`);
    return { name: album.name, downloaded: 0, skipped: 0, failed: 0 };
  }

  const targetDir = path.join(ROOT, album.name);
  await mkdir(targetDir, { recursive: true });

  let host = hostCache.get(token) || DEFAULT_HOST;
  const api = `/${token}/sharedstreams`;
  const downloadedSet = await loadState(album.name);

  console.log(`\n  📂 "${album.name}"`);

  // Step 1 — fetch the album's photo list (postJSON handles 330 redirect)
  const stream = await postJSON(`${api}/webstream`, { streamCtag: null }, host);
  if (!stream?.photos?.length) {
    console.log(`     → 0 photos`);
    return { name: album.name, downloaded: 0, skipped: 0, failed: 0 };
  }

  const total = stream.photos.length;
  console.log(`     → ${total} item(s) in album`);

  // Step 2 — get download URLs for all items
  const guids = stream.photos.map((p) => p.photoGuid);
  const assets = await postJSON(`${api}/webasseturls`, { photoGuids: guids }, host);

  if (!assets?.items) {
    console.warn(`    ⚠ failed to get asset URLs`);
    return { name: album.name, downloaded: 0, skipped: 0, failed: 0 };
  }

  // Step 3 — download the largest derivative of each item
  let downloaded = 0, skipped = 0, failed = 0;

  for (const photo of stream.photos) {
    // Derivatives is an object keyed by quality label (e.g. "720p", "Original", "PosterFrame").
    // Pick the one with the largest fileSize.
    const derivs = Object.values(photo.derivatives || {});
    if (!derivs.length) continue;

    const largest = derivs.reduce((a, b) => ((a.fileSize || 0) > (b.fileSize || 0) ? a : b));
    const checksum = largest.checksum;
    if (!checksum) continue;

    // assets.items is keyed by checksum, NOT by photoGuid
    const item = assets.items[checksum];
    if (!item) {
      console.warn(`    ⚠ no download URL for checksum ${checksum}`);
      failed++;
      continue;
    }

    // Build the download URL
    const downloadUrl = `https://${item.url_location}${item.url_path}`;

    // Determine extension from media type
    const mt = (photo.mediaAssetType || '').toLowerCase();
    const ext = mt.startsWith('video') ? '.mp4' : '.jpg';
    const baseFile = path.join(targetDir, `${checksum}${ext}`);

    const result = await downloadFile(downloadUrl, baseFile, checksum, downloadedSet);
    if (result === 'downloaded') downloaded++;
    else if (result === 'skipped') skipped++;
    else failed++;
  }

  // Persist state
  await saveState(album.name, downloadedSet);

  return { name: album.name, downloaded, skipped, failed };
}

// ── Main ─────────────────────────────────────────────────────────────────────

console.log('── Sync iCloud Shared Albums ──\n');

const results = await Promise.all(ALBUMS.map(syncAlbum));

console.log(`\n── Done ──`);
for (const r of results) {
  const parts = [];
  if (r.downloaded) parts.push(`${r.downloaded} downloaded`);
  if (r.skipped) parts.push(`${r.skipped} up-to-date`);
  if (r.failed) parts.push(`${r.failed} failed`);
  console.log(`  ${r.name}: ${parts.join(', ') || 'nothing to do'}`);
}
console.log(`Gallery root: ${ROOT}`);