import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';

import { annotateTap } from '../src/tiktok/vision-debug.js';

test('annotateTap draws a crosshair on the tapped point', async () => {
    const blank = await sharp({
        create: { width: 200, height: 300, channels: 3, background: { r: 20, g: 20, b: 20 } },
    }).png().toBuffer();
    const tap = { x: 50, y: 80 };
    const marked = await annotateTap(blank, tap, { scale: 1, label: 'pick 50,80' });
    const { data, info } = await sharp(marked).raw().toBuffer({ resolveWithObject: true });

    const index = (x: number, y: number) => (y * info.width + x) * info.channels;
    const center = index(tap.x, tap.y);
    // Yellow center fill from the crosshair.
    assert.ok(data[center] > 200 && data[center + 1] > 200 && data[center + 2] < 80);

    const ring = index(tap.x + 24, tap.y);
    assert.ok(data[ring] > 180 || data[ring + 1] > 180, 'ring pixels should be red or yellow');

    const far = index(10, 10);
    assert.ok(data[far] < 40 && data[far + 1] < 40 && data[far + 2] < 40);
});
