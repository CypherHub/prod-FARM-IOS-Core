import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { musicPermalink, normalizeApifyItem } from '../src/content/apify.js';

// contentTemplates/instead-of-king-slideshow/source/source.json was produced by
// hand from this same actor. The normalizer's job is to land on that shape, so
// the worked example is the fixture.
const fixturePath = path.resolve('contentTemplates/instead-of-king-slideshow/source/source.json');
const expected = JSON.parse(await readFile(fixturePath, 'utf8')) as Record<string, never>;

// Shaped the way the actor actually emits a slideshow: counters at the top
// level, hashtags as objects, author under authorMeta, music under musicMeta.
const actorItem = {
    id: '7665104701272132878',
    webVideoUrl: 'https://www.tiktok.com/@fashion.technically/video/7665104701272132878',
    submittedVideoUrl: 'https://www.tiktok.com/t/ZTUDXaRvQ/',
    text: 'What do you guys think?',
    createTimeISO: '2026-07-21T22:01:27.000Z',
    authorMeta: { name: 'fashion.technically', nickName: 'fashiontechy', fans: 223, heart: 36900 },
    playCount: 605300, diggCount: 36400, shareCount: 3677, collectCount: 14393, commentCount: 163,
    mentions: ['@wearlumia', 'incorahealth'],
    detailedMentions: [{ name: 'wearlumia', nickName: 'wearlumia' }],
    hashtags: [{ name: 'fashiontech' }, { name: '#wearabletech' }],
    musicMeta: { musicName: 'som original', musicAuthor: 'elvz', musicOriginal: true, musicId: '7649903858499734279' },
    slideshowImageLinks: [{ downloadLink: 'https://cdn.example/1.jpg' }, { downloadLink: 'https://cdn.example/2.jpg' }],
    videoMeta: { coverUrl: 'https://cdn.example/cover.jpg' },
};

test('normalizes an actor slideshow item onto the worked-example shape', () => {
    const post = normalizeApifyItem(actorItem, 'https://www.tiktok.com/t/ZTUDXaRvQ/');

    assert.equal(post.id, expected.id);
    assert.equal(post.webVideoUrl, expected.webVideoUrl);
    assert.equal(post.isSlideshow, true);
    assert.equal(post.author.name, (expected.author as Record<string, string>).name);
    // profileUrl is absent from the actor payload and derived from the handle.
    assert.equal(post.author.profileUrl, (expected.author as Record<string, string>).profileUrl);
    assert.equal(post.stats.playCount, 605300);
    assert.equal(post.stats.commentCount, 163);
    assert.equal(post.music.musicUrl, (expected.music as Record<string, string>).musicUrl);
    assert.deepEqual(post.hashtags, ['fashiontech', 'wearabletech']);
    // Bare handles get the @ the fixture stores.
    assert.deepEqual(post.mentions, ['@wearlumia', '@incorahealth']);
    assert.equal(post.slideUrls.length, 2);
    assert.equal(post.videoUrl, null);
});

test('reads counters nested under stats as well as at the top level', () => {
    const post = normalizeApifyItem({ ...actorItem, playCount: undefined, stats: { playCount: 42 } }, 'https://www.tiktok.com/t/x');
    assert.equal(post.stats.playCount, 42);
});

test('treats an item with no slideshow links as a video', () => {
    const post = normalizeApifyItem(
        { ...actorItem, slideshowImageLinks: undefined, mediaUrls: ['https://cdn.example/v.mp4'] },
        'https://www.tiktok.com/t/x',
    );
    assert.equal(post.isSlideshow, false);
    assert.equal(post.videoUrl, 'https://cdn.example/v.mp4');
});

// Recorded from one real Apify run on https://www.tiktok.com/t/ZTUaNch1A/ so
// the video path is asserted against the actor's actual payload, not a guess.
const videoFixture = JSON.parse(
    await readFile(path.resolve('test/fixtures/video-post.json'), 'utf8'),
) as Record<string, never>;

test('normalizes the recorded video post', () => {
    const post = normalizeApifyItem(videoFixture, 'https://www.tiktok.com/t/ZTUaNch1A/');

    assert.equal(post.isSlideshow, false);
    assert.deepEqual(post.slideUrls, []);
    assert.ok(post.videoUrl, 'expected a downloadable video URL');
    assert.ok(post.coverUrl, 'expected a cover URL');
    // Drives the length of a generated video, so it must survive normalization.
    assert.equal(post.durationSeconds, 5);
    assert.equal(post.author.name, 'nomad_founder');
    assert.equal(post.stats.playCount, 3093);
    assert.equal(post.stats.diggCount, 18);
    // The actor emits hashtags as objects; the fixture proves the unwrapping.
    assert.ok(post.hashtags.includes('techtok'));
    assert.ok(post.hashtags.every((tag) => typeof tag === 'string' && !tag.startsWith('#')));
    assert.match(post.music.musicUrl ?? '', /^https:\/\/www\.tiktok\.com\/music\/.*-7611027491582659344$/);
});

test('a slideshow carries no duration and a video carries no slides', () => {
    const video = normalizeApifyItem(videoFixture, 'https://www.tiktok.com/t/ZTUaNch1A/');
    const slideshow = normalizeApifyItem(actorItem, 'https://www.tiktok.com/t/ZTUDXaRvQ/');
    assert.equal(slideshow.durationSeconds, null);
    assert.equal(slideshow.videoUrl, null);
    assert.equal(video.slideUrls.length, 0);
});

test('rebuilds the shareable music permalink from name and id', () => {
    assert.equal(musicPermalink('som original', '7649903858499734279'),
        'https://www.tiktok.com/music/som-original-7649903858499734279');
    assert.equal(musicPermalink('Déjà Vu!! (remix)', '123'), 'https://www.tiktok.com/music/deja-vu-remix-123');
    assert.equal(musicPermalink('anything', ''), null);
});
