import assert from 'node:assert/strict';
import test from 'node:test';

import { checkboxOnFromAttributes } from '../src/tiktok/checkbox.js';
import { splitComposerCopy } from '../src/tiktok/post-compose.js';
import { recentPickerTargets } from '../src/tiktok/post-layout.js';

test('checkboxOnFromAttributes reads XCUITest selected/value flags', () => {
    assert.equal(checkboxOnFromAttributes('true', ''), true);
    assert.equal(checkboxOnFromAttributes(null, '1'), true);
    assert.equal(checkboxOnFromAttributes('', 'selected'), true);
    assert.equal(checkboxOnFromAttributes('false', null), false);
    assert.equal(checkboxOnFromAttributes(undefined, '0'), false);
    assert.equal(checkboxOnFromAttributes('', ''), undefined);
    assert.equal(checkboxOnFromAttributes(null, null), undefined);
});

test('splitComposerCopy uses a short first line as the title', () => {
    assert.deepEqual(
        splitComposerCopy('Wellness trackers I\'d use instead of Oura\n\nWhat do you guys think?'),
        { title: 'Wellness trackers I\'d use instead of Oura', caption: 'What do you guys think?' },
    );
    assert.deepEqual(splitComposerCopy('just a caption'), { caption: 'just a caption' });
    assert.deepEqual(splitComposerCopy(undefined), {});
});

test('recentPickerTargets taps circled cells left-to-right so reverse-imported slide 1 is Cover', () => {
    const layout = { circleX: 122, columnStep: 138, firstY: 270, trayY: 190, rowStep: 139 };
    assert.deepEqual(recentPickerTargets(12, 1, layout), [{ x: 122, y: 270 }]);
    assert.deepEqual(recentPickerTargets(12, 2, layout), [
        { x: 122, y: 270 },
        { x: 260, y: 270 },
    ]);
    assert.deepEqual(recentPickerTargets(12, 4, layout), [
        { x: 122, y: 270 },
        { x: 260, y: 270 },
        { x: 398, y: 270 },
        { x: 122, y: 409 },
    ]);
    assert.deepEqual(recentPickerTargets(12, 6, layout), [
        { x: 122, y: 270 },
        { x: 260, y: 270 },
        { x: 398, y: 270 },
        { x: 122, y: 409 },
        { x: 260, y: 409 },
        { x: 398, y: 409 },
    ]);
});
