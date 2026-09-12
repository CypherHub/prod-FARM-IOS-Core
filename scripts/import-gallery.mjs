#!/usr/bin/env node
// Copies a folder of your own photos and clips into gallery/<name>/ so the
// content library can build posts from them and the web app can show them.
//
//   npm run gallery:import                       # the configured defaults
//   npm run gallery:import -- <source> <name>    # one specific folder
//
// gallery/ is git-ignored, so this is how a checkout gets its media back.

import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v']);

// The folders this repo's worked example was built from. Override by passing
// <source> <name>, or by setting GALLERY_SOURCES to "src:name,src:name".
const DEFAULT_SOURCES = [
    { source: '/Users/nuzairnuwais/Developer/GitHub/pixlRobotics/public/images/nub_photoshoot/lifestyle', name: 'nub-lifestyle' },
    { source: '/Users/nuzairnuwais/Developer/GitHub/pixlRobotics/hd_video/clips', name: 'nub-clips' },
];

function configuredSources() {
    const [source, name] = process.argv.slice(2);
    if (source && name) return [{ source, name }];
    if (source) throw new Error('Pass both a source folder and a gallery name');
    if (process.env.GALLERY_SOURCES) {
        return process.env.GALLERY_SOURCES.split(',').map((entry) => {
            const index = entry.lastIndexOf(':');
            if (index < 1) throw new Error(`GALLERY_SOURCES entry "${entry}" must be "<source>:<name>"`);
            return { source: entry.slice(0, index).trim(), name: entry.slice(index + 1).trim() };
        });
    }
    return DEFAULT_SOURCES;
}

const classify = (file) => {
    const extension = path.extname(file).toLowerCase();
    if (IMAGE_EXTENSIONS.has(extension)) return 'image';
    if (VIDEO_EXTENSIONS.has(extension)) return 'video';
    return null;
};

/** Skips a file that is already there at the same size — reruns stay cheap. */
async function alreadyCopied(source, target) {
    try {
        const [from, to] = await Promise.all([stat(source), stat(target)]);
        return from.size === to.size;
    } catch {
        return false;
    }
}

async function importOne({ source, name }, root) {
    const target = path.join(root, name);
    let entries;
    try {
        entries = await readdir(source, { withFileTypes: true });
    } catch (error) {
        console.warn(`! skipping ${name}: cannot read ${source} (${error.code ?? error.message})`);
        return { name, images: 0, videos: 0, skipped: 0 };
    }
    await mkdir(target, { recursive: true });

    const counts = { name, images: 0, videos: 0, skipped: 0 };
    for (const entry of entries) {
        // retouched/ holds alternate edits of images already in the parent
        // folder; importing both would give the model near-duplicates.
        if (!entry.isFile()) continue;
        const kind = classify(entry.name);
        if (!kind) continue;
        const from = path.join(source, entry.name);
        const to = path.join(target, entry.name);
        if (await alreadyCopied(from, to)) { counts.skipped += 1; continue; }
        await copyFile(from, to);
        counts[kind === 'image' ? 'images' : 'videos'] += 1;
    }
    return counts;
}

const root = path.resolve(process.env.CONTENT_GALLERY_DIR ?? 'gallery');
await mkdir(root, { recursive: true });

for (const entry of configuredSources()) {
    const counts = await importOne(entry, root);
    console.log(
        `${counts.name}: ${counts.images} image(s), ${counts.videos} video(s) copied`
        + (counts.skipped ? `, ${counts.skipped} already present` : ''),
    );
}
console.log(`Gallery root: ${root}`);
