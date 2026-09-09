import type { Browser } from 'webdriverio';

/** Capabilities that attach to TikTok without killing its process. */
export function tiktokAppiumCapabilities(
    udid: string,
    bundleId: string,
    extras: Record<string, unknown> = {},
): WebdriverIO.Capabilities & Record<string, unknown> {
    return {
        platformName: 'iOS',
        'appium:automationName': 'XCUITest',
        'appium:udid': udid,
        'appium:bundleId': bundleId,
        'appium:noReset': true,
        // forceAppLaunch terminates a running TikTok and relaunches it.
        // shouldTerminateApp SIGKILLs it when the Appium session ends.
        // TikTok treats those as crashes and shows welcome / choose-your-interests.
        'appium:forceAppLaunch': false,
        'appium:shouldTerminateApp': false,
        'appium:dontStopAppOnReset': true,
        'appium:waitForIdleTimeout': 0,
        ...extras,
    };
}

export async function foregroundTikTok(driver: Browser, bundleId: string): Promise<void> {
    await driver.activateApp(bundleId);
    console.log(`Foregrounded ${bundleId}`);
}

// Home (or backgroundApp on phones without a hardware button mapping) is a
// normal iOS suspend. The process stays alive; the next activateApp is a
// warm start, not a crash recovery.
export async function backgroundTikTok(driver: Browser): Promise<void> {
    try {
        await driver.execute('mobile: pressButton', { name: 'home' });
        console.log('Sent TikTok to background (Home)');
    } catch {
        await driver.execute('mobile: backgroundApp', { seconds: 0.5 });
        console.log('Sent TikTok to background (backgroundApp)');
    }
    await driver.pause(800);
}
