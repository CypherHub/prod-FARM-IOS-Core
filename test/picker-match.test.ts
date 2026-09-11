import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import { assignTopSlideMatches, matchSlidesInPicker, slideCropTemplates } from '../src/tiktok/picker-match.js';
import { newestPickerCell, pickerCircle, pickerScrollSwipe, circledPickerCells, type PickerLayout } from '../src/tiktok/post-layout.js';

const layout: PickerLayout = { circleX: 122, columnStep: 138, firstY: 270, trayY: 270, rowStep: 139 };

test('assignTopSlideMatches keeps the topmost cell for each slide', () => {
    // 3x3 grid, row-major. Slide 1 appears in cell 3 then 7; first wins.
    const cellMaes = [
        [80, 20, 80, 80],
        [80, 80, 20, 80],
        [80, 80, 80, 20],
        [20, 80, 80, 80],
        [80, 22, 80, 80],
        [80, 80, 22, 80],
        [80, 80, 80, 22],
        [22, 80, 80, 80],
        [80, 80, 80, 80],
    ];
    assert.deepEqual(assignTopSlideMatches(cellMaes, 4), [3, 0, 1, 2]);
});

test('pickerScrollSwipe moves the finger up to reveal covered Recents', () => {
    const up = pickerScrollSwipe(layout, 'up');
    assert.equal(up.startX, up.endX);
    assert.ok(up.startY > up.endY);
    const down = pickerScrollSwipe(layout, 'down');
    assert.deepEqual([down.startX, down.startY, down.endX, down.endY], [up.endX, up.endY, up.startX, up.startY]);
});

test('pickerCircle is the top-right selection mark on a Recents cell', () => {
    assert.deepEqual(pickerCircle(0, 1, layout), { x: 122, y: 409 });
    assert.equal(circledPickerCells(layout, 3).length, 9);
    assert.equal(circledPickerCells(layout, 4).length, 12);
    assert.deepEqual(newestPickerCell(layout), { x: 70, y: 230 });
});

test('matchSlidesInPicker finds the newest copy of each still', async () => {
    const colors = ['#c94c4c', '#3d8c4a', '#d4a017', '#2a2a2a'];
    const slides = await Promise.all(colors.map((background) => (
        sharp({ create: { width: 180, height: 320, channels: 3, background } }).jpeg().toBuffer()
    )));
    const scale = 2;
    const composites = [
        { slide: 3, column: 0, row: 0 },
        { slide: 2, column: 1, row: 0 },
        { slide: 1, column: 2, row: 0 },
        { slide: 0, column: 0, row: 1 },
    ].map(({ slide, column, row }) => {
        const left = Math.round((column * layout.columnStep * scale) + (8 * scale));
        const top = Math.round(((layout.firstY + (row * layout.rowStep)) * scale) + (8 * scale));
        const width = Math.round((layout.columnStep * scale) - (22 * scale));
        const height = Math.round((layout.rowStep * scale) - (18 * scale));
        return { input: slides[slide]!, left, top, width, height };
    });
    const resized = await Promise.all(composites.map(async (item) => ({
        input: await sharp(item.input).resize(item.width, item.height, { fit: 'fill' }).png().toBuffer(),
        left: item.left,
        top: item.top,
    })));
    const screenshot = await sharp({
        create: { width: 828, height: 1792, channels: 3, background: '#f2f2f2' },
    }).composite(resized).png().toBuffer();
    const templates = await Promise.all(slides.map((slide) => slideCropTemplates(slide)));
    const matches = await matchSlidesInPicker(screenshot, templates, layout, scale);
    assert.deepEqual(matches.map((match) => match && { x: match.target.x, y: match.target.y }), [
        pickerCircle(0, 1, layout),
        pickerCircle(2, 0, layout),
        pickerCircle(1, 0, layout),
        pickerCircle(0, 0, layout),
    ]);
});
