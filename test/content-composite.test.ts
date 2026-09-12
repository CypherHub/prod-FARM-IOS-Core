import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';

import {
    compositeSlide, compositeVideo, contentBoxFor, escapeXml, hookSvg, overlaySvg, renderHookPng, renderOverlayPng,
    SLIDE_HEIGHT, SLIDE_WIDTH, videoCompositeArguments, wrapLine,
} from '../src/content/composite.js';

const run = promisify(execFile);

test('wraps a long line to fit the slide width', () => {
    assert.deepEqual(wrapLine('short', 34, 936), ['short']);
    const wrapped = wrapLine('word '.repeat(40).trim(), 34, 936);
    assert.ok(wrapped.length > 1, 'expected the line to wrap');
    // Every word survives the wrap.
    assert.equal(wrapped.join(' ').split(' ').length, 40);
});

test('escapes overlay copy so an apostrophe or ampersand cannot break the SVG', () => {
    assert.equal(escapeXml(`Trackers I'd use & <love>`), 'Trackers I&apos;d use &amp; &lt;love&gt;');
    const svg = overlaySvg({ index: 1, galleryImage: 'gallery/a.jpg', overlayLines: ['A & B'], role: 'hook' });
    assert.ok(svg.includes('A &amp; B'));
    assert.ok(!svg.includes('A & B'));
});

test('composites a slide at exactly 1080x1920', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pf-composite-'));
    // A source with the wrong aspect ratio, to prove the resize happens.
    const source = path.join(directory, 'source.jpg');
    await sharp({ create: { width: 800, height: 600, channels: 3, background: '#334455' } }).jpeg().toFile(source);

    const output = path.join(directory, 'slide-1.jpg');
    await compositeSlide(source, {
        index: 1, galleryImage: 'gallery/source.jpg', role: 'hook',
        overlayLines: ["Wellness trackers I'd use instead of Oura Ring", 'no wearable. no subscription.'],
    }, output);

    const metadata = await sharp(output).metadata();
    assert.equal(metadata.width, SLIDE_WIDTH);
    assert.equal(metadata.height, SLIDE_HEIGHT);
    assert.equal(metadata.format, 'jpeg');
});

test('a 4:3 landscape source is black-padded, never cropped', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pf-composite-pad-'));
    // The real photoshoot shape. A cover-crop would discard most of it.
    const source = path.join(directory, 'landscape.jpg');
    await sharp({ create: { width: 2048, height: 1536, channels: 3, background: '#cc3344' } }).jpeg().toFile(source);

    const output = path.join(directory, 'slide-1.jpg');
    // No overlay, so the only thing in the frame is the photo and the padding.
    await compositeSlide(source, { index: 1, galleryImage: 'gallery/landscape.jpg', overlayLines: [], role: 'product' }, output);

    const { data, info } = await sharp(output).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => {
        const offset = (y * info.width + x) * info.channels;
        return [data[offset], data[offset + 1], data[offset + 2]];
    };
    const near = (actual: number[], expected: number[]) => actual.every((value, index) => Math.abs(value - (expected[index] ?? 0)) <= 12);

    // 2048×1536 fitted to 1080 wide is 810 tall, leaving ~555px of black above
    // and below. Top and bottom are padding; the middle is the photo.
    assert.ok(near(pixel(SLIDE_WIDTH / 2, 20), [0, 0, 0]), `expected black padding at the top, got ${pixel(SLIDE_WIDTH / 2, 20)}`);
    assert.ok(near(pixel(SLIDE_WIDTH / 2, SLIDE_HEIGHT - 20), [0, 0, 0]), 'expected black padding at the bottom');
    assert.ok(near(pixel(SLIDE_WIDTH / 2, SLIDE_HEIGHT / 2), [204, 51, 68]), 'expected the photo in the middle');
    // The full width of the photo survives — nothing cropped off the sides.
    assert.ok(near(pixel(2, SLIDE_HEIGHT / 2), [204, 51, 68]), 'expected the photo to reach the left edge');
    assert.ok(near(pixel(SLIDE_WIDTH - 3, SLIDE_HEIGHT / 2), [204, 51, 68]), 'expected the photo to reach the right edge');
});

test('the overlay rasterizes to a transparent 1080x1920 PNG for ffmpeg', async () => {
    // This ffmpeg is built without libfreetype, so it has no drawtext filter —
    // video text has to arrive as an image.
    const png = await renderOverlayPng(['Meet the Nub']);
    const metadata = await sharp(png).metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, SLIDE_WIDTH);
    assert.equal(metadata.height, SLIDE_HEIGHT);
    assert.equal(metadata.hasAlpha, true);
});

test('the video filter graph letterboxes, overlays, and drops audio', () => {
    const withOverlay = videoCompositeArguments({
        clipPath: '/clips/a.mp4', trimStartSeconds: 1.5, durationSeconds: 4,
        overlayPng: '/tmp/overlay.png', outputPath: '/out/post.mp4',
    });
    const joined = withOverlay.join(' ');
    // -ss must precede -i so the seek applies to the input, not the output.
    assert.ok(joined.indexOf('-ss') < joined.indexOf('-i'), 'expected -ss before -i');
    assert.match(joined, /-t 4 /);
    assert.match(joined, /force_original_aspect_ratio=decrease/);
    assert.match(joined, /pad=1080:1920:\(ow-iw\)\/2:\(oh-ih\)\/2:black/);
    assert.match(joined, /\[base\]\[1:v\]overlay=0:0/);
    // TikTok and the Photos import path both need yuv420p, and the sound comes
    // from the bookmarked TikTok track, not the gallery clip.
    assert.ok(withOverlay.includes('yuv420p'));
    assert.ok(withOverlay.includes('-an'));

    // With no overlay there is no second input and no overlay filter.
    const plain = videoCompositeArguments({
        clipPath: '/clips/a.mp4', trimStartSeconds: 0, durationSeconds: 2,
        overlayPng: null, outputPath: '/out/post.mp4',
    }).join(' ');
    assert.doesNotMatch(plain, /overlay=/);
    assert.equal((plain.match(/-i /g) ?? []).length, 1);
});

test('composites a real clip to a 1080x1920 video of the requested length', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pf-composite-video-'));
    const clip = path.join(directory, 'source.mp4');
    // Landscape, like the real gallery clips, and longer than the trim.
    await run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=5',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip,
    ]);

    const output = path.join(directory, 'post.mp4');
    await compositeVideo({
        clipPath: clip, trimStartSeconds: 1, durationSeconds: 3,
        hook: 'Meet the Nub\nno wearable. no subscription.',
        outputPath: output,
    });

    const { stdout } = await run('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,pix_fmt:format=duration', '-of', 'json', output,
    ]);
    const probed = JSON.parse(stdout) as { streams: Array<{ width: number; height: number; pix_fmt: string }>; format: { duration: string } };
    assert.equal(probed.streams[0]?.width, SLIDE_WIDTH);
    assert.equal(probed.streams[0]?.height, SLIDE_HEIGHT);
    assert.equal(probed.streams[0]?.pix_fmt, 'yuv420p');
    const duration = Number(probed.format.duration);
    assert.ok(Math.abs(duration - 3) < 0.2, `expected ~3s, got ${duration}`);
});

test('renders a slide with no overlay copy as a plain resized still', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pf-composite-plain-'));
    const source = path.join(directory, 'source.jpg');
    await sharp({ create: { width: 400, height: 400, channels: 3, background: '#112233' } }).jpeg().toFile(source);
    const output = path.join(directory, 'slide-2.jpg');
    await compositeSlide(source, { index: 2, galleryImage: 'gallery/source.jpg', overlayLines: [], role: 'product' }, output);
    const metadata = await sharp(output).metadata();
    assert.equal(metadata.width, SLIDE_WIDTH);
    assert.equal(metadata.height, SLIDE_HEIGHT);
});

test('the hook renders in TikTok style: white fill, black outline, no background', async () => {
    const svg = hookSvg('how do you track your focus?\nme:');
    // White fill with a black stroke painted behind it — no plate, no scrim.
    assert.match(svg, /fill="#ffffff"/);
    assert.match(svg, /stroke="#000000"/);
    assert.match(svg, /paint-order="stroke fill"/);
    assert.doesNotMatch(svg, /<rect/, 'the hook must not draw any background');

    const png = await renderHookPng('how do you track your focus?\nme:');
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, SLIDE_WIDTH);
    assert.equal(info.height, SLIDE_HEIGHT);

    let transparent = 0;
    let white = 0;
    let black = 0;
    for (let i = 0; i < data.length; i += info.channels) {
        if (data[i + 3]! < 10) { transparent += 1; continue; }
        if (data[i]! > 200 && data[i + 1]! > 200 && data[i + 2]! > 200) white += 1;
        else if (data[i]! < 50 && data[i + 1]! < 50 && data[i + 2]! < 50) black += 1;
    }
    // Overwhelmingly transparent proves there is no background plate.
    assert.ok(transparent / (info.width * info.height) > 0.9, `expected a mostly transparent layer, got ${transparent}`);
    assert.ok(white > 2_000, `expected white letterforms, got ${white}`);
    assert.ok(black > 2_000, `expected a black outline, got ${black}`);
});

test('the hook wraps long copy and keeps every word', () => {
    const long = 'this is a deliberately long hook line that has to wrap onto several rows to stay on screen';
    const svg = hookSvg(long);
    const rendered = [...svg.matchAll(/>([^<]+)<\/text>/g)].map((match) => match[1]);
    assert.ok(rendered.length > 1, 'expected the hook to wrap');
    assert.equal(rendered.join(' ').split(/\s+/).length, long.split(/\s+/).length);
});

test('a blank hook produces no overlay input for ffmpeg', () => {
    // compositeVideo skips the PNG entirely, so the graph has one input.
    const plain = videoCompositeArguments({
        clipPath: '/clips/a.mp4', trimStartSeconds: 0, durationSeconds: 2,
        overlayPng: null, outputPath: '/out/post.mp4',
    });
    assert.equal(plain.filter((arg) => arg === '-i').length, 1);
});

test('the hook is placed on the picture, not on the letterbox bars', () => {
    // A 1280x720 clip letterboxed into 1080x1920 leaves the picture in the middle.
    const box = contentBoxFor(1280, 720);
    assert.equal(box.top, 656);
    assert.equal(box.height, 608);
    // Already 9:16, so it fills the frame.
    assert.deepEqual(contentBoxFor(1080, 1920), { top: 0, height: 1920 });
    // Unknown dimensions fall back to the whole frame rather than throwing.
    assert.deepEqual(contentBoxFor(null, null), { top: 0, height: SLIDE_HEIGHT });

    // The baseline y of the first line must land inside the picture band.
    const svg = hookSvg('one line', SLIDE_WIDTH, SLIDE_HEIGHT, box);
    const firstY = Number(/<text[^>]*\sy="(\d+)"/.exec(svg)?.[1]);
    assert.ok(firstY > box.top && firstY < box.top + box.height,
        `expected the hook inside ${box.top}..${box.top + box.height}, got ${firstY}`);
});
