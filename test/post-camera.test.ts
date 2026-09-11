import assert from 'node:assert/strict';
import test from 'node:test';

import { isCaptionComposer, isLiveCamera, isTextStoryComposer, isVideoEditorStoryBar, lowestExactWord } from '../src/tiktok/post-camera.js';
import type { OcrWord } from '../src/tiktok/ocr.js';

function word(text: string, y = 0): OcrWord {
    return { text, x: 0, y, width: 10, height: 10, confidence: 90 };
}

test('isTextStoryComposer detects TEXT canvas and Your Story share sheet', () => {
    assert.equal(isTextStoryComposer([word('Type'), word('something...')]), true);
    assert.equal(isTextStoryComposer([word('Your'), word('Story'), word('Post'), word('to'), word('feed')]), true);
    assert.equal(isTextStoryComposer([word('PHOTO'), word('POST'), word('LIVE')]), false);
});

test('video editor Your Story | Next is not the TEXT share sheet', () => {
    const editor = [word('Your'), word('Story'), word('Next'), word('AutoCut')];
    assert.equal(isVideoEditorStoryBar(editor), true);
    assert.equal(isTextStoryComposer(editor), false);
    assert.equal(isCaptionComposer(editor), false);
    assert.equal(isVideoEditorStoryBar([word('AutoCut')]), true);
});

test('caption composer is Drafts/Post, not Your Story', () => {
    const caption = [word('Add'), word('description...'), word('Everyone'), word('can'), word('view'), word('Drafts'), word('Post')];
    assert.equal(isCaptionComposer(caption), true);
    assert.equal(isVideoEditorStoryBar(caption), false);
});

test('isLiveCamera detects leftover LIVE composer', () => {
    assert.equal(isLiveCamera([word('Go'), word('LIVE'), word('Check'), word('LIVE'), word('access')]), true);
    assert.equal(isLiveCamera([word('PHOTO'), word('POST')]), false);
});

test('lowestExactWord prefers the camera-tab POST over an earlier Post', () => {
    const post = lowestExactWord([word('Post', 200), word('POST', 1648), word('PHOTO', 1285)], 'post');
    assert.equal(post?.y, 1648);
    assert.equal(lowestExactWord([word('PHOTO', 1285)], 'photo')?.text, 'PHOTO');
    assert.equal(lowestExactWord([word('Photos', 122)], 'photo'), undefined);
});
