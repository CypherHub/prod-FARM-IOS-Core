import assert from 'node:assert/strict';
import test from 'node:test';

import { findHandleMatch, type OcrWord } from '../src/tiktok/ocr.js';
import { isCaptionComposer, isLiveCamera, isMediaPicker, isTextStoryComposer, isVideoEditorStoryBar, lowestExactWord } from '../src/tiktok/post-camera.js';

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

test('caption composer with open keyboard still counts as leftover caption', () => {
    const keyboardCaption = [
        word('Preview'), word('Edit'), word('cover'), word('Hashtags'), word('Mention'),
        word('q'), word('w'), word('e'), word('space'), word('123'),
    ];
    assert.equal(isCaptionComposer(keyboardCaption), true);
});

test('isLiveCamera detects leftover LIVE composer', () => {
    assert.equal(isLiveCamera([word('Go'), word('LIVE'), word('Check'), word('LIVE'), word('access')]), true);
    assert.equal(isLiveCamera([word('Try'), word('practice'), word('mode'), word('Devicecamera'), word('CREATE'), word('LIVE')]), true);
    assert.equal(isLiveCamera([word('PHOTO'), word('POST')]), false);
});

test('isMediaPicker detects Recents / Select multiple, not the editor', () => {
    assert.equal(isMediaPicker([word('Recents'), word('Videos'), word('Photos'), word('Select'), word('multiple')]), true);
    assert.equal(isMediaPicker([word('Add'), word('sound'), word('AutoCut')]), false);
    assert.equal(isMediaPicker([word('Add'), word('description...'), word('Drafts'), word('Post')]), false);
});

test('findHandleMatch ignores OCR punctuation in a TikTok handle', () => {
    const match = findHandleMatch([word("my_sane_'tea")], '@my_sane_tea');
    assert.equal(match?.text, "my_sane_'tea");
});

test('lowestExactWord prefers the camera-tab POST over an earlier Post', () => {
    const post = lowestExactWord([word('Post', 200), word('POST', 1648), word('PHOTO', 1285)], 'post');
    assert.equal(post?.y, 1648);
    assert.equal(lowestExactWord([word('PHOTO', 1285)], 'photo')?.text, 'PHOTO');
    assert.equal(lowestExactWord([word('Photos', 122)], 'photo'), undefined);
});
