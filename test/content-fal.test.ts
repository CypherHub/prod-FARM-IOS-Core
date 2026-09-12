import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

import { slideTextPrompt, falModel } from '../src/content/fal.js';
import { renderSlide } from '../src/content/generate.js';
import { SLIDE_HEIGHT, SLIDE_WIDTH } from '../src/content/composite.js';
import type { PlanSlide } from '../src/content/plan.js';

const slide: PlanSlide = {
    index: 1, galleryImage: 'gallery/a.jpg', role: 'hook',
    overlayLines: ["Wellness trackers I'd use instead of Oura Ring", 'no wearable. no subscription.'],
};

async function landscapeSource(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'pf-fal-'));
    const source = path.join(directory, 'source.jpg');
    await sharp({ create: { width: 2048, height: 1536, channels: 3, background: '#cc3344' } }).jpeg().toFile(source);
    return source;
}

test('the prompt carries the exact copy and forbids touching the photo', () => {
    const prompt = slideTextPrompt(slide.overlayLines, true);
    for (const line of slide.overlayLines) assert.ok(prompt.includes(line), `expected the prompt to quote "${line}"`);
    assert.match(prompt, /Do not change the photograph/);
    // The letterbox bars must survive, or the no-crop guarantee is lost.
    assert.match(prompt, /black letterbox bars/);
    assert.match(prompt, /hook slide/);
    assert.doesNotMatch(slideTextPrompt(slide.overlayLines, false), /hook slide/);
});

test('the model is the runbook default and is overridable', () => {
    assert.equal(falModel(), 'fal-ai/nano-banana-pro/edit');
    process.env.CONTENT_FAL_MODEL = 'fal-ai/other/edit';
    assert.equal(falModel(), 'fal-ai/other/edit');
    delete process.env.CONTENT_FAL_MODEL;
});

test('a successful Fal render is written straight out', async () => {
    process.env.FAL_API_KEY = 'test-key';
    const source = await landscapeSource();
    const output = path.join(path.dirname(source), 'slide-1.jpg');
    const rendered = await sharp({ create: { width: SLIDE_WIDTH, height: SLIDE_HEIGHT, channels: 3, background: '#00ff00' } })
        .jpeg().toBuffer();

    let calls = 0;
    await renderSlide({
        sourceImage: source, slide, outputPath: output, log: () => {},
        renderWithFal: async () => { calls += 1; return rendered; },
    });

    assert.equal(calls, 1);
    // The green stand-in proves the Fal bytes were used, not a local composite.
    const { data } = await sharp(await readFile(output)).raw().toBuffer({ resolveWithObject: true });
    assert.ok(data[1]! > 200 && data[0]! < 60, 'expected the Fal image on disk');
    delete process.env.FAL_API_KEY;
});

test('Fal is retried once, then the local renderer produces the slide', async () => {
    process.env.FAL_API_KEY = 'test-key';
    const source = await landscapeSource();
    const output = path.join(path.dirname(source), 'slide-fallback.jpg');

    let calls = 0;
    const logged: string[] = [];
    await renderSlide({
        sourceImage: source, slide, outputPath: output, log: (line) => logged.push(line),
        renderWithFal: async () => { calls += 1; throw new Error('queue exploded'); },
    });

    assert.equal(calls, 2, 'expected exactly one retry before falling back');
    assert.ok(logged.some((line) => line.includes('Falling back to the local renderer')), logged.join('\n'));
    // The slide still exists, still 1080×1920, still uncropped.
    const metadata = await sharp(output).metadata();
    assert.equal(metadata.width, SLIDE_WIDTH);
    assert.equal(metadata.height, SLIDE_HEIGHT);
});

test('with no Fal key, or with CONTENT_SLIDE_TEXT=local, Fal is never called', async () => {
    const source = await landscapeSource();
    const output = path.join(path.dirname(source), 'slide-local.jpg');
    let calls = 0;
    const never = async () => { calls += 1; throw new Error('should not be called'); };

    delete process.env.FAL_API_KEY;
    delete process.env.FAL_KEY;
    await renderSlide({ sourceImage: source, slide, outputPath: output, log: () => {}, renderWithFal: never });

    process.env.FAL_API_KEY = 'test-key';
    process.env.CONTENT_SLIDE_TEXT = 'local';
    await renderSlide({ sourceImage: source, slide, outputPath: output, log: () => {}, renderWithFal: never });

    assert.equal(calls, 0);
    delete process.env.CONTENT_SLIDE_TEXT;
    delete process.env.FAL_API_KEY;
});

test('a slide with no copy skips Fal entirely — there is nothing to letter', async () => {
    process.env.FAL_API_KEY = 'test-key';
    const source = await landscapeSource();
    const output = path.join(path.dirname(source), 'slide-bare.jpg');
    let calls = 0;
    await renderSlide({
        sourceImage: source, outputPath: output, log: () => {},
        slide: { ...slide, overlayLines: [] },
        renderWithFal: async () => { calls += 1; throw new Error('should not be called'); },
    });
    assert.equal(calls, 0);
    delete process.env.FAL_API_KEY;
});
