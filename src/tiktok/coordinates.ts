export interface Point { x: number; y: number }
export interface TikTokCoordinates {
    passcodeKeypad: { columnX: [number, number, number]; rowY: [number, number, number, number] };
    tiktok: {
        profileTab: Point; homeTab: Point; accountSwitcher: Point; create: Point; upload: Point;
        photoMode: Point; photosAlbum: Point; selectMultiple: Point; useLayout: Point; title: Point;
        picker: { circleX: number; columnStep: number; firstY: number; trayY: number; rowStep: number; cellX: number; cellStep: number; cellY: number };
        pickerNext: Point; editorNext: Point; caption: Point; keyboardBack: Point; draft: Point; finish: Point;
        like: Point; save: Point; swipe: { x: number; startY: number; endY: number; durationMs: number };
    };
}

export const DEVICE_COORDINATES = {
    iphone8: {
        passcodeKeypad: { columnX: [103, 191, 275], rowY: [220, 347, 425, 506] },
        tiktok: {
            profileTab: { x: 338, y: 656 }, homeTab: { x: 38, y: 653 }, accountSwitcher: { x: 185, y: 158 },
            create: { x: 187, y: 640 }, upload: { x: 300, y: 545 }, photoMode: { x: 243, y: 485 }, photosAlbum: { x: 190, y: 88 }, selectMultiple: { x: 24, y: 618 },
            useLayout: { x: 24, y: 489 }, title: { x: 82, y: 175 },
            picker: { circleX: 106, columnStep: 126, firstY: 482, trayY: 360, rowStep: 125, cellX: 62, cellStep: 125, cellY: 526 },
            pickerNext: { x: 277, y: 617 }, editorNext: { x: 277, y: 637 }, caption: { x: 120, y: 236 },
            keyboardBack: { x: 22, y: 42 }, draft: { x: 98, y: 630 }, finish: { x: 277, y: 630 },
            like: { x: 345, y: 313 }, save: { x: 345, y: 444 }, swipe: { x: 187, startY: 550, endY: 150, durationMs: 450 },
        },
    },
    // iPhone XR / 11 (414 × 896 pt). Keep in sync with src/devices/coordinates.ts.
    iphonexr: {
        passcodeKeypad: { columnX: [92, 206, 322], rowY: [370, 471, 572, 672] },
        tiktok: {
            profileTab: { x: 373, y: 824 }, homeTab: { x: 41, y: 824 }, accountSwitcher: { x: 207, y: 212 },
            create: { x: 207, y: 824 }, upload: { x: 40, y: 832 }, photoMode: { x: 268, y: 652 }, photosAlbum: { x: 186, y: 122 }, selectMultiple: { x: 26, y: 830 },
            useLayout: { x: 26, y: 657 }, title: { x: 91, y: 235 },
            picker: { circleX: 122, columnStep: 138, firstY: 270, trayY: 270, rowStep: 139, cellX: 68, cellStep: 168, cellY: 707 },
            pickerNext: { x: 306, y: 829 }, editorNext: { x: 306, y: 856 }, caption: { x: 160, y: 276 },
            keyboardBack: { x: 24, y: 56 }, draft: { x: 108, y: 846 }, finish: { x: 306, y: 846 },
            like: { x: 380, y: 480 }, save: { x: 380, y: 605 }, swipe: { x: 207, startY: 720, endY: 200, durationMs: 450 },
        },
    },
} satisfies Record<string, TikTokCoordinates>;

export type CoordinateProfile = keyof typeof DEVICE_COORDINATES;
export function coordinatesForProfile(profile = 'iphone8'): TikTokCoordinates {
    if (!(profile in DEVICE_COORDINATES)) throw new Error(`Unknown TikTok coordinate profile "${profile}"`);
    return DEVICE_COORDINATES[profile as CoordinateProfile];
}
