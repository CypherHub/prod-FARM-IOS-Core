import assert from 'node:assert/strict';
import test from 'node:test';

import { tiktokAppiumCapabilities } from '../src/tiktok/appium-session.js';

test('TikTok Appium sessions attach without terminating the app', () => {
    const capabilities = tiktokAppiumCapabilities('udid', 'com.zhiliaoapp.musically', {
        'appium:newCommandTimeout': 180,
    });
    assert.equal(capabilities['appium:noReset'], true);
    assert.equal(capabilities['appium:forceAppLaunch'], false);
    assert.equal(capabilities['appium:shouldTerminateApp'], false);
    assert.equal(capabilities['appium:dontStopAppOnReset'], true);
    assert.equal(capabilities['appium:newCommandTimeout'], 180);
});
