import assert from 'node:assert/strict';
import test from 'node:test';

import { PluginRegistry } from '../src/registry.js';
import { createTikTokPlugin } from '../src/tiktok-plugin.js';

const plugin = createTikTokPlugin({ doomscrollEntrypoint: '/example/doomscroll.js', postEntrypoint: '/example/post.js' });

test('built-in TikTok plugin validates versioned doomscroll tasks', () => {
    const registry = new PluginRegistry([plugin]);
    const value = registry.validate({
        deviceUdid: 'device-12345678',
        task: {
            pluginId: plugin.id, taskType: 'doomscroll', taskVersion: 1,
            payload: { durationMinutes: 5, personality: 'casual', likeEnabled: true, saveEnabled: false },
        },
        timing: { kind: 'daily', localTime: '09:00', timezone: 'Asia/Kolkata' },
    });
    assert.equal(value.task.payload.durationMinutes, 5);
});

test('recurring public posts require confirmation', () => {
    const registry = new PluginRegistry([plugin]);
    assert.throws(() => registry.validate({
        deviceUdid: 'device-12345678',
        task: {
            pluginId: plugin.id, taskType: 'post', taskVersion: 1,
            payload: {
                media: [{ assetId: 'asset-1', name: 'video.mp4', mimeType: 'video/mp4' }],
                destination: 'publish', account: '@internal',
            },
        },
        timing: { kind: 'weekly', localTime: '10:00', timezone: 'Asia/Kolkata', weekdays: [1] },
    }), /explicit confirmation/);
});

function slideshowMedia(count: number) {
    return Array.from({ length: count }, (_, index) => ({
        assetId: `asset-${index + 1}`,
        name: `slide-${index + 1}.jpg`,
        mimeType: 'image/jpeg',
    }));
}

function postInput(media: Array<{ assetId: string; name: string; mimeType: string }>) {
    return {
        deviceUdid: 'device-12345678',
        task: {
            pluginId: plugin.id, taskType: 'post' as const, taskVersion: 1,
            payload: { media, destination: 'draft', account: '@internal' },
        },
        timing: { kind: 'now' as const },
    };
}

test('post task accepts six slideshow images', () => {
    const registry = new PluginRegistry([plugin]);
    const value = registry.validate(postInput(slideshowMedia(6)));
    const media = value.task.payload.media;
    assert.ok(Array.isArray(media));
    assert.equal(media.length, 6);
});

test('post task rejects seven slideshow images', () => {
    const registry = new PluginRegistry([plugin]);
    assert.throws(() => registry.validate(postInput(slideshowMedia(7))), /one to six media files/);
});

test('post task rejects mixed video and images', () => {
    const registry = new PluginRegistry([plugin]);
    assert.throws(() => registry.validate(postInput([
        { assetId: 'asset-1', name: 'video.mp4', mimeType: 'video/mp4' },
        { assetId: 'asset-2', name: 'slide-1.jpg', mimeType: 'image/jpeg' },
    ])), /exactly one video, or upload only slideshow images/);
});
