import assert from 'node:assert/strict';
import test from 'node:test';

import {
    acceptGoalMet,
    deepSeekConfig,
    forbiddenTapReason,
    parseVisionDecision,
    pointFromNormalized,
    visionGoalPrompt,
} from '../src/tiktok/vision-guide.js';

test('parseVisionDecision accepts a bare JSON object', () => {
    const decision = parseVisionDecision('{"screen":"picker","goalMet":false,"action":"tap","nx":0.17,"ny":0.26,"reason":"top-left newest video"}');
    assert.equal(decision.screen, 'picker');
    assert.equal(decision.action, 'tap');
    assert.equal(decision.nx, 0.17);
    assert.equal(decision.ny, 0.26);
    assert.equal(decision.goalMet, false);
});

test('parseVisionDecision unwraps a fenced JSON block', () => {
    const decision = parseVisionDecision('Sure.\n```json\n{"screen":"editor","goalMet":true,"action":"wait","reason":"already on Next"}\n```\n');
    assert.equal(decision.screen, 'editor');
    assert.equal(decision.goalMet, true);
    assert.equal(decision.action, 'wait');
    assert.equal(decision.nx, undefined);
});

test('parseVisionDecision rejects a tap without coordinates', () => {
    assert.throws(
        () => parseVisionDecision('{"screen":"picker","goalMet":false,"action":"tap","reason":"video"}'),
        /nx/,
    );
});

test('parseVisionDecision rejects out-of-range nx/ny', () => {
    assert.throws(
        () => parseVisionDecision('{"screen":"picker","goalMet":false,"action":"tap","nx":1.2,"ny":0.2,"reason":"x"}'),
        /nx must be between 0 and 1/,
    );
    assert.throws(
        () => parseVisionDecision('{"screen":"picker","goalMet":false,"action":"tap","nx":0.2,"ny":-0.1,"reason":"y"}'),
        /ny must be between 0 and 1/,
    );
});

test('parseVisionDecision falls back when screen or action is missing', () => {
    const decision = parseVisionDecision('{"goalMet":false,"action":"tap","nx":0.2,"ny":0.3,"reason":"retry"}');
    assert.equal(decision.screen, 'unknown');
    assert.equal(decision.action, 'tap');
    const waited = parseVisionDecision('{"screen":"caption","goalMet":false,"reason":"blank"}');
    assert.equal(waited.action, 'wait');
});

test('pointFromNormalized maps the image center onto XR points', () => {
    assert.deepEqual(pointFromNormalized(0.5, 0.5, { width: 414, height: 896 }), { x: 207, y: 448 });
});

test('forbiddenTapReason blocks LIVE and Go Live on the camera', () => {
    assert.equal(forbiddenTapReason('reach_post_camera', 0.90, 0.73), 'LIVE tab');
    assert.equal(forbiddenTapReason('reach_post_camera', 0.50, 0.82), 'Go Live');
    assert.equal(forbiddenTapReason('open_gallery', 0.50, 0.82), 'Go Live');
    assert.equal(forbiddenTapReason('reach_post_camera', 0.50, 0.92), undefined);
    assert.equal(forbiddenTapReason('open_gallery', 0.10, 0.93), undefined);
});

test('acceptGoalMet refuses LIVE as the post camera', () => {
    assert.equal(acceptGoalMet('reach_post_camera', 'live'), false);
    assert.equal(acceptGoalMet('reach_post_camera', 'camera'), true);
    assert.equal(acceptGoalMet('open_gallery', 'live'), false);
});

test('the post-camera goal prompt accepts PHOTO and forbids LIVE', () => {
    const prompt = visionGoalPrompt('reach_post_camera', 'draft');
    assert.match(prompt, /PHOTO/);
    assert.match(prompt, /never Go Live/);
    assert.match(prompt, /LIVE and TEXT are not done/);
});

test('forbiddenTapReason blocks Your Story on the editor', () => {
    assert.equal(forbiddenTapReason('leave_editor', 0.22, 0.94), 'Your Story');
    assert.equal(forbiddenTapReason('leave_editor', 0.74, 0.93), undefined);
});

test('forbiddenTapReason blocks Photos and Recents when picking a video', () => {
    const photosChip = { nx: 186 / 414, ny: 122 / 896 };
    const recentsHeader = { nx: 0.5, ny: 0.07 };
    const newestVideo = { nx: 68 / 414, ny: 647 / 896 };
    const videosFilter = { nx: 90 / 414, ny: 122 / 896 };
    assert.equal(forbiddenTapReason('pick_newest_video', photosChip.nx, photosChip.ny), 'Photos chip');
    assert.equal(forbiddenTapReason('pick_newest_video', recentsHeader.nx, recentsHeader.ny), 'Recents header');
    assert.equal(forbiddenTapReason('pick_newest_video', newestVideo.nx, newestVideo.ny), undefined);
    assert.equal(forbiddenTapReason('pick_newest_video', videosFilter.nx, videosFilter.ny), undefined);
});

test('forbiddenTapReason blocks Drafts and Post while filling the caption', () => {
    assert.equal(forbiddenTapReason('fill_caption', 0.75, 0.94, 'draft'), 'Post');
    assert.equal(forbiddenTapReason('fill_caption', 0.22, 0.94, 'draft'), 'Drafts');
    assert.equal(forbiddenTapReason('fill_caption', 0.22, 0.14, 'draft'), undefined);
});

test('forbiddenTapReason rejects a profile Drafts:1 tap', () => {
    assert.equal(forbiddenTapReason('finish', 33 / 414, 511 / 896, 'draft'), 'not Drafts');
    assert.equal(forbiddenTapReason('finish', 86 / 414, 413 / 896, 'draft'), 'not Drafts');
});

test('forbiddenTapReason honors draft vs publish on the caption bar', () => {
    assert.equal(forbiddenTapReason('finish', 0.75, 0.94, 'draft'), 'Post');
    assert.equal(forbiddenTapReason('finish', 0.22, 0.94, 'draft'), undefined);
    assert.equal(forbiddenTapReason('finish', 0.22, 0.46, 'draft'), 'not Drafts');
    assert.equal(forbiddenTapReason('finish', 0.08, 0.57, 'draft'), 'not Drafts');
    assert.equal(forbiddenTapReason('finish', 0.22, 0.94, 'publish'), 'Drafts');
    assert.equal(forbiddenTapReason('finish', 0.50, 0.48, 'publish'), 'not Post');
});

test('acceptGoalMet refuses an editor win while still on the picker', () => {
    assert.equal(acceptGoalMet('leave_editor', 'picker'), false);
    assert.equal(acceptGoalMet('leave_editor', 'caption'), true);
    assert.equal(acceptGoalMet('pick_newest_video', 'picker'), false);
    assert.equal(acceptGoalMet('pick_newest_video', 'editor'), true);
});

test('a mocked picker Photos tap is rejected the same way a live model would be', () => {
    const photos = parseVisionDecision(JSON.stringify({
        screen: 'picker',
        goalMet: false,
        action: 'tap',
        nx: 186 / 414,
        ny: 122 / 896,
        reason: 'Photos filter',
    }));
    assert.equal(forbiddenTapReason('pick_newest_video', photos.nx!, photos.ny!), 'Photos chip');
    const recents = parseVisionDecision(JSON.stringify({
        screen: 'picker',
        goalMet: false,
        action: 'tap',
        nx: 0.5,
        ny: 0.08,
        reason: 'Recents',
    }));
    assert.equal(forbiddenTapReason('pick_newest_video', recents.nx!, recents.ny!), 'Recents header');
    assert.equal(forbiddenTapReason('pick_newest_video', 23 / 414, 44 / 896), 'editor back chevron');
});

test('deepSeekConfig requires OpenRouter and defaults to DeepSeek V4 Flash vision', () => {
    assert.throws(() => deepSeekConfig({}), /OPENROUTER_API_KEY/);
    assert.deepEqual(deepSeekConfig({ OPENROUTER_API_KEY: 'sk-or-test' }), {
        apiKey: 'sk-or-test',
        model: 'deepseek/deepseek-v4-flash-vision-exp',
        baseUrl: 'https://openrouter.ai/api/v1',
    });
    assert.equal(
        deepSeekConfig({ OPENROUTER_API_KEY: 'sk-or-test', DEEPSEEK_MODEL: 'deepseek/deepseek-v4-flash' }).model,
        'deepseek/deepseek-v4-flash-vision-exp',
    );
});

test('the newest-video goal prompt forbids Recents and Photos', () => {
    const prompt = visionGoalPrompt('pick_newest_video', 'draft');
    assert.match(prompt, /Videos/);
    assert.match(prompt, /Recents/);
    assert.match(prompt, /Photos/);
    assert.match(prompt, /1, 2, or 3/);
    assert.match(prompt, /rightmost filled cell/);
});
