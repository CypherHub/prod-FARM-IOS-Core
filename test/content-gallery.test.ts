import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

// galleryRoot() reads CONTENT_GALLERY_DIR per call, so point it at a scratch
// root before importing anything that resolves against it.
const root = await mkdtemp(path.join(os.tmpdir(), 'pf-gallery-'));
process.env.CONTENT_GALLERY_DIR = root;

const {
    GalleryError, classify, eligibleClips, listGalleries, listGalleryImages, listGalleryVideos,
    probeMedia, resolveGalleryFile, resolveGalleryRoot,
} = await import('../src/content/gallery.js');

// A real container to probe. Synthesized rather than read from gallery/, which
// is git-ignored and therefore absent on a fresh checkout. 1280×720 matches the
// landscape shape of the actual gallery clips.
const REAL_CLIP = path.join(root, 'five-seconds.mp4');
await promisify(execFile)('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=5.005',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', REAL_CLIP,
]);

const fixture = path.join(root, 'mixed');
await mkdir(fixture, { recursive: true });
for (const name of ['b.jpg', 'a.JPG', 'c.jpeg', 'd.png', 'notes.txt', '.DS_Store']) {
    await writeFile(path.join(fixture, name), 'x');
}
await writeFile(path.join(fixture, 'clip.mp4'), 'x');
await writeFile(path.join(fixture, 'clip.MOV'), 'x');

test('classifies gallery files by extension, case-insensitively', () => {
    assert.equal(classify('photo.JPG'), 'image');
    assert.equal(classify('photo.heic'), 'image');
    assert.equal(classify('clip.MOV'), 'video');
    assert.equal(classify('clip.m4v'), 'video');
    assert.equal(classify('notes.txt'), null);
    assert.equal(classify('.DS_Store'), null);
});

test('splits a gallery into images and videos, sorted, ignoring everything else', async () => {
    assert.deepEqual(await listGalleryImages(fixture), ['a.JPG', 'b.jpg', 'c.jpeg', 'd.png']);
    assert.deepEqual(await listGalleryVideos(fixture), ['clip.MOV', 'clip.mp4']);
});

test('lists galleries under the root with their counts', async () => {
    const galleries = await listGalleries();
    const mixed = galleries.find((gallery) => gallery.name === 'mixed');
    assert.ok(mixed, 'expected the mixed gallery to be listed');
    assert.equal(mixed.images, 4);
    assert.equal(mixed.videos, 2);
});

test('refuses gallery names and files that escape the gallery root', () => {
    assert.equal(resolveGalleryRoot('mixed'), path.join(root, 'mixed'));
    assert.equal(resolveGalleryFile('mixed', 'a.JPG'), path.join(root, 'mixed', 'a.JPG'));
    for (const escape of ['../outside', '../../etc', 'mixed/../../etc']) {
        assert.throws(() => resolveGalleryRoot(escape), GalleryError, `expected ${escape} to be rejected`);
    }
    for (const escape of ['../secret.env', '../../etc/passwd', 'sub/../../escape.jpg']) {
        assert.throws(() => resolveGalleryFile('mixed', escape), GalleryError, `expected ${escape} to be rejected`);
    }
});

test('probeMedia reads real dimensions and duration, and degrades on a non-video', async () => {
    const probed = await probeMedia(REAL_CLIP);
    assert.equal(probed.width, 1280);
    assert.equal(probed.height, 720);
    assert.ok(probed.durationSeconds && Math.abs(probed.durationSeconds - 5.005) < 0.05,
        `expected ~5.005s, got ${probed.durationSeconds}`);

    // The fixture "videos" are text files; the probe must not throw.
    assert.deepEqual(await probeMedia(path.join(fixture, 'clip.mp4')), { width: null, height: null, durationSeconds: null });
});

test('eligibleClips keeps only clips at least as long as the reference', async () => {
    const clips = path.join(root, 'clips');
    await mkdir(clips, { recursive: true });
    await copyFile(REAL_CLIP, path.join(clips, 'five.mp4'));

    // 4s fits inside the 5.005s clip.
    const fits = await eligibleClips(clips, 4);
    assert.deepEqual(fits.map((clip) => clip.name), ['five.mp4']);

    // A reference longer than every clip leaves nothing — the real state when
    // only a 1.1s clip is available, which generate.ts reports as an error.
    assert.deepEqual(await eligibleClips(clips, 30), []);
});

const { dropNoiseLines, groupWordsIntoLines, wordScore } = await import('../src/content/overlay-ocr.js');

test('OCR words are regrouped into the visual lines the copy was written as', () => {
    const word = (text: string, x: number, y: number) => ({ text, x, y, width: text.length * 10, height: 30, confidence: 90 });
    // Two lines, given out of order to prove the sort.
    const lines = groupWordsIntoLines([
        word('Ring', 300, 200), word('Health', 10, 100), word('instead', 10, 200),
        word('Trackers', 100, 104), word('of', 200, 205),
    ]);
    assert.deepEqual(lines, ['Health Trackers', 'instead of Ring']);
});

test('noise lines are dropped by symbol ratio, not by length', () => {
    // "me:" is real overlay copy from the worked video; the glyph soup is photo
    // texture Tesseract mistook for type.
    assert.deepEqual(dropNoiseLines(['me:', '¢ ¥ ) 9, & ®', 'Health Trackers', '/ // .', '$179']), [
        'me:', 'Health Trackers', '$179',
    ]);
});

test('wordScore counts real words so the best threshold variant can be picked', () => {
    assert.ok(wordScore(['Health Trackers instead of Oura Ring']) > wordScore(['¢ ¥ ) 9, & ® | /// . |']));
    assert.equal(wordScore(['¢ ¥ ) 9, & ®']), 0);
});

const { assertGalleryName, createGallery, deleteGalleryFile, sanitizeUploadName, uniqueFileName } =
    await import('../src/content/gallery.js');

test('gallery names are whitelisted, not merely traversal-checked', () => {
    assert.equal(assertGalleryName('  product-shots '), 'product-shots');
    assert.equal(assertGalleryName('nub_lifestyle.v2'), 'nub_lifestyle.v2');
    for (const bad of ['', '.hidden', '../escape', 'with/slash', 'a..b', 'sp ace', '-leading', 'x'.repeat(65)]) {
        assert.throws(() => assertGalleryName(bad), GalleryError, `expected "${bad}" to be rejected`);
    }
});

test('upload names are stripped of anything that could steer the write', () => {
    assert.equal(sanitizeUploadName('../../etc/passwd', 'fallback'), 'passwd');
    assert.equal(sanitizeUploadName('my photo (1).JPG', 'fallback'), 'my_photo__1_.JPG');
    assert.equal(sanitizeUploadName('', 'upload-1'), 'upload-1');
    // A name that is only dots would otherwise resolve to the directory itself.
    assert.equal(sanitizeUploadName('...', 'upload-2'), 'upload-2');
});

test('uploading a name that is taken never overwrites the existing file', async () => {
    const directory = await createGallery('uploads-test');
    await writeFile(path.join(directory, 'shot.jpg'), 'first');
    assert.equal(await uniqueFileName(directory, 'shot.jpg'), 'shot-1.jpg');
    await writeFile(path.join(directory, 'shot-1.jpg'), 'second');
    assert.equal(await uniqueFileName(directory, 'shot.jpg'), 'shot-2.jpg');
    assert.equal(await uniqueFileName(directory, 'fresh.jpg'), 'fresh.jpg');
});

test('deleting removes gallery media but refuses non-media and unknown files', async () => {
    const directory = await createGallery('delete-test');
    await writeFile(path.join(directory, 'shot.jpg'), 'bytes');
    await writeFile(path.join(directory, 'notes.txt'), 'bytes');

    await deleteGalleryFile('delete-test', 'shot.jpg');
    assert.deepEqual(await listGalleryImages(directory), []);

    // Not gallery media, so not ours to delete.
    await assert.rejects(() => deleteGalleryFile('delete-test', 'notes.txt'), GalleryError);
    await assert.rejects(() => deleteGalleryFile('delete-test', '../secret.env'), GalleryError);
    await assert.rejects(() => deleteGalleryFile('delete-test', 'gone.jpg'), GalleryError);
});
