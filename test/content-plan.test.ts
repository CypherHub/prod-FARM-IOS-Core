import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';

import { PlanValidationError, resolveGalleryAsset, validatePlan, type VideoPlanLimits } from '../src/content/plan.js';
import { normalizeTikTokUrl, ContentStateError } from '../src/content/repository.js';

const goodSlideshow = {
    kind: 'slideshow',
    slides: [
        { index: 1, galleryImage: 'gallery/a.jpg', overlayLines: ['Hook line'], role: 'hook' },
        { index: 2, galleryImage: 'gallery/b.jpg', overlayLines: ['Body line', ''], role: 'product' },
    ],
    caption: 'Title\n\nBody',
    hashtags: ['#fashiontech', 'wearabletech'],
};

// The pan-tilt clip is 5.005s; a 4s reference leaves 1.005s of trim headroom.
const videoLimits: VideoPlanLimits = {
    targetSeconds: 4,
    clipDurations: new Map([['nub-pan-tilt-5s.mp4', 5.005], ['IMG_0431.mov', 42.23]]),
};

const goodVideo = {
    kind: 'video',
    galleryVideo: 'gallery/nub-pan-tilt-5s.mp4',
    trimStartSeconds: 0.5,
    hook: 'Hook line\n',
    caption: 'Title\n\nBody',
    hashtags: ['#pixlnub'],
};

test('accepts a well-formed slideshow plan and strips blank lines and hash prefixes', () => {
    const plan = validatePlan(structuredClone(goodSlideshow), 'slideshow');
    assert.equal(plan.kind, 'slideshow');
    assert.equal(plan.slides.length, 2);
    assert.deepEqual(plan.slides[1]?.overlayLines, ['Body line']);
    assert.deepEqual(plan.hashtags, ['fashiontech', 'wearabletech']);
});

test('accepts a well-formed video plan', () => {
    const plan = validatePlan(structuredClone(goodVideo), 'video', videoLimits);
    assert.equal(plan.kind, 'video');
    assert.equal(plan.galleryVideo, 'gallery/nub-pan-tilt-5s.mp4');
    assert.equal(plan.trimStartSeconds, 0.5);
    assert.equal(plan.hook, 'Hook line');
});

test('rejects slideshow plans the compositor could not render', () => {
    const reject = (plan: unknown, expected: RegExp) => assert.throws(
        () => validatePlan(plan, 'slideshow'),
        (error: Error) => {
            assert.ok(error instanceof PlanValidationError, `expected PlanValidationError, got ${error.name}`);
            assert.match(error.message, expected);
            return true;
        },
    );

    reject({ ...goodSlideshow, slides: [] }, /must not be empty/);
    reject('not an object', /must be a JSON object/);
    // A gap in the indices would silently drop a still.
    reject({ ...goodSlideshow, slides: [{ index: 2, galleryImage: 'gallery/a.jpg', overlayLines: [] }] }, /index must be 1/);
    reject({ ...goodSlideshow, caption: '   ' }, /caption must not be empty/);
    reject({ ...goodSlideshow, caption: 'x'.repeat(2_201) }, /at most 2200/);
    reject({ ...goodSlideshow, slides: Array.from({ length: 7 }, (_, i) => ({ index: i + 1, galleryImage: 'gallery/a.jpg', overlayLines: [] })) }, /at most 6 slides/);
    reject({ ...goodSlideshow, slides: [{ index: 1, galleryImage: 'gallery/a.jpg', overlayLines: ['x'.repeat(201)] }] }, /longer than 200 characters/);
    // Wrong shape for the bookmark's kind.
    reject({ ...goodSlideshow, galleryVideo: 'gallery/x.mp4' }, /must not carry video fields/);
    reject(goodVideo, /plan\.kind must be "slideshow"/);
});

test('rejects video plans whose trim will not fit the clip', () => {
    const reject = (plan: unknown, expected: RegExp) => assert.throws(
        () => validatePlan(plan, 'video', videoLimits),
        (error: Error) => {
            assert.ok(error instanceof PlanValidationError, `expected PlanValidationError, got ${error.name}`);
            assert.match(error.message, expected);
            return true;
        },
    );

    // 2s + 4s target runs past the 5.005s clip.
    reject({ ...goodVideo, trimStartSeconds: 2 }, /runs past nub-pan-tilt-5s\.mp4/);
    reject({ ...goodVideo, trimStartSeconds: -1 }, /zero or greater/);
    reject({ ...goodVideo, trimStartSeconds: 'early' }, /must be a number of seconds/);
    // A clip the model was never offered — it was filtered out for being too short.
    reject({ ...goodVideo, galleryVideo: 'gallery/IMG_0432.mov' }, /not one of the offered gallery clips/);
    reject({ ...goodVideo, slides: [] }, /must not carry slides/);
    reject({ ...goodVideo, hook: '   ' }, /hook must not be empty/);
    reject({ ...goodVideo, hook: 'x'.repeat(221) }, /hook must be at most 220/);
    reject(goodSlideshow, /plan\.kind must be "video"/);
});

test('a trim ending exactly at the clip end is allowed', () => {
    // 1.005 + 4 === 5.005, the clip's full length. Floating-point noise in the
    // probed duration must not make this a failure.
    const plan = validatePlan({ ...goodVideo, trimStartSeconds: 1.005 }, 'video', videoLimits);
    assert.equal(plan.trimStartSeconds, 1.005);
});

test('refuses gallery references that escape the workspace', () => {
    const workspace = path.resolve('/tmp/workspace');
    assert.equal(resolveGalleryAsset(workspace, 'gallery/a.jpg'), path.join(workspace, 'gallery', 'a.jpg'));
    for (const escape of ['../../../etc/passwd', 'gallery/../../secret.env', '/etc/passwd', 'bookmark/slide-1.jpg']) {
        assert.throws(() => resolveGalleryAsset(workspace, escape), PlanValidationError, `expected ${escape} to be rejected`);
    }
});

test('normalizes TikTok URLs so re-bookmarking is idempotent', () => {
    assert.equal(
        normalizeTikTokUrl('https://www.tiktok.com/t/ZTUDXaRvQ/?is_from_webapp=1&sender_device=pc'),
        'https://www.tiktok.com/t/ZTUDXaRvQ',
    );
    assert.equal(normalizeTikTokUrl('http://vm.tiktok.com/abc#x'), 'https://vm.tiktok.com/abc');
    for (const bad of ['not a url', 'https://example.com/video/1', 'ftp://tiktok.com/x', 'https://nottiktok.com/x']) {
        assert.throws(() => normalizeTikTokUrl(bad), ContentStateError, `expected ${bad} to be rejected`);
    }
});
