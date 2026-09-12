import sharp from 'sharp';

import { httpJson } from '../content/http.js';
import type { ScreenSize } from '../devices/wda-remote.js';

export const VISION_SCREENS = [
    'feed', 'camera', 'picker', 'editor', 'caption', 'keyboard', 'live', 'blocker', 'unknown',
] as const;
export type VisionScreen = (typeof VISION_SCREENS)[number];

export const VISION_ACTIONS = ['tap', 'wait', 'fail'] as const;
export type VisionAction = (typeof VISION_ACTIONS)[number];

export type VideoVisionGoal =
    | 'reach_post_camera'
    | 'open_gallery'
    | 'pick_newest_video'
    | 'leave_editor'
    | 'fill_caption'
    | 'finish';

export interface VisionDecision {
    screen: VisionScreen;
    goalMet: boolean;
    action: VisionAction;
    nx?: number;
    ny?: number;
    reason: string;
}

export interface DeepSeekConfig {
    apiKey: string;
    model: string;
    baseUrl: string;
}

const SCREENS = new Set<string>(VISION_SCREENS);
const ACTIONS = new Set<string>(VISION_ACTIONS);

export function deepSeekConfig(env: NodeJS.ProcessEnv = process.env): DeepSeekConfig {
    const apiKey = env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is required to post a video');
    const requested = env.DEEPSEEK_MODEL?.trim() || 'deepseek/deepseek-v4-flash-vision-exp';
    // OpenRouter's deepseek/deepseek-v4-flash is text-only. Vision posts always
    // send a screenshot, so use the vision-capable sibling.
    const model = requested === 'deepseek/deepseek-v4-flash'
        ? 'deepseek/deepseek-v4-flash-vision-exp'
        : requested;
    return {
        apiKey,
        model,
        baseUrl: (env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
    };
}

export function parseVisionDecision(raw: string): VisionDecision {
    const json = extractJsonObject(raw);
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        throw new Error(`OpenRouter did not return JSON: ${raw.slice(0, 200)}`);
    }
    if (!parsed || typeof parsed !== 'object') throw new Error('OpenRouter JSON was not an object');
    const body = parsed as Record<string, unknown>;
    let screen = String(body.screen ?? '').trim();
    let action = String(body.action ?? '').trim();
    if (!SCREENS.has(screen)) {
        console.log(`Vision screen fallback unknown from ${JSON.stringify(screen || '(missing)')}`);
        screen = 'unknown';
    }
    if (!ACTIONS.has(action)) {
        console.log(`Vision action fallback wait from ${JSON.stringify(action || '(missing)')}`);
        action = 'wait';
    }
    const decision: VisionDecision = {
        screen: screen as VisionScreen,
        goalMet: Boolean(body.goalMet),
        action: action as VisionAction,
        reason: typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : action,
    };
    if (action === 'tap') {
        const nx = number01(body.nx, 'nx');
        const ny = number01(body.ny, 'ny');
        decision.nx = nx;
        decision.ny = ny;
    }
    return decision;
}

export function pointFromNormalized(nx: number, ny: number, screen: ScreenSize): { x: number; y: number } {
    const x = Math.round(clamp01(nx) * screen.width);
    const y = Math.round(clamp01(ny) * screen.height);
    return {
        x: Math.min(screen.width - 1, Math.max(0, x)),
        y: Math.min(screen.height - 1, Math.max(0, y)),
    };
}

export function acceptGoalMet(goal: VideoVisionGoal, screen: VisionScreen): boolean {
    if (goal === 'reach_post_camera') return screen === 'camera';
    if (goal === 'open_gallery' && screen === 'live') return false;
    if (goal === 'open_gallery') return screen === 'picker';
    if (goal === 'pick_newest_video') return screen === 'editor' || screen === 'caption';
    if (goal === 'leave_editor') return screen === 'caption' || screen === 'keyboard';
    if (goal === 'fill_caption') return screen === 'caption';
    return true;
}

export function forbiddenTapReason(
    goal: VideoVisionGoal,
    nx: number,
    ny: number,
    destination: 'draft' | 'publish' = 'draft',
): string | undefined {
    if ((goal === 'reach_post_camera' || goal === 'open_gallery') && nx > 0.78 && ny > 0.65 && ny < 0.82) {
        return 'LIVE tab';
    }
    if ((goal === 'reach_post_camera' || goal === 'open_gallery') && nx > 0.35 && nx < 0.65 && ny > 0.76 && ny < 0.89) {
        return 'Go Live';
    }
    if (goal === 'leave_editor' && nx < 0.48 && ny > 0.85) return 'Your Story';
    if (goal === 'fill_caption' && ny > 0.85) {
        if (nx > 0.52) return 'Post';
        if (nx < 0.48) return 'Drafts';
    }
    if (goal === 'pick_newest_video') {
        if (ny < 0.12 && nx < 0.18) return 'editor back chevron';
        if (ny < 0.12 && nx > 0.25 && nx < 0.75) return 'Recents header';
        if (ny < 0.20 && nx > 0.32 && nx < 0.55) return 'Photos chip';
    }
    if (goal === 'finish' && destination === 'draft') {
        if (nx > 0.52 && ny > 0.85) return 'Post';
        if (!(nx < 0.48 && ny > 0.85)) return 'not Drafts';
    }
    if (goal === 'finish' && destination === 'publish') {
        if (nx < 0.48 && ny > 0.85) return 'Drafts';
        if (!(nx > 0.52 && ny > 0.85)) return 'not Post';
    }
    return undefined;
}

export async function screenshotToJpeg(png: Buffer): Promise<Buffer> {
    return sharp(png).jpeg({ quality: 75 }).toBuffer();
}

export function visionSystemPrompt(): string {
    return [
        'You guide taps on a current iPhone TikTok screenshot.',
        'This flow only uploads an existing video as a draft or a post. Never go live.',
        'Return ONLY a JSON object with keys: screen, goalMet, action, nx, ny, reason.',
        'screen must be one of: feed, camera, picker, editor, caption, keyboard, live, blocker, unknown.',
        'action must be one of: tap, wait, fail.',
        'nx and ny are fractions of the image from the top-left (0 to 1). Required when action is tap.',
        'goalMet is true only when the current goal is already satisfied on this screenshot.',
        'Never tap LIVE, Go Live, or Check Live.',
        'Never tap Your Story (editor bottom-left).',
        'Never tap Post when the goal is to save a draft (caption bottom-right).',
        'Never tap the Recents album title or the Photos filter when picking a video.',
        'The newest imported video is the last filled thumbnail: the bottom-most row, then the rightmost cell that actually contains a video. That last row may have 1, 2, or 3 cells. Never tap an empty slot.',
        'Editor Next is the pink button on the bottom-right.',
        'Caption Drafts is the bottom-left pill; Post is the pink bottom-right pill.',
        'Dismiss a keyboard by tapping empty body, never the back chevron.',
    ].join(' ');
}

export function visionGoalPrompt(
    goal: VideoVisionGoal,
    destination: 'draft' | 'publish',
    extra?: string,
): string {
    const goals: Record<VideoVisionGoal, string> = {
        reach_post_camera: 'Goal: any create camera that can open the gallery — PHOTO, 15s, 60s, or POST all count as done. Do not tap PHOTO/15s/POST again once that camera is visible. LIVE and TEXT are not done. If you are on For You or Profile, tap +. If LIVE is open (Go Live / practice mode), tap the back chevron — never Go Live.',
        open_gallery: 'Goal: the photo/video gallery picker is open. Tap the small album thumbnail (usually bottom-left), not the record shutter.',
        pick_newest_video: 'Goal: open the newest imported video. Switch to the Videos filter if needed. Turn Select multiple off if it is on. The grid is 3 columns. Look at the bottom-most row that has thumbnails and tap the rightmost filled cell on that row (1, 2, or 3 videos). Do not tap an empty slot, Recents, Photos, or Live Photos. If the editor is already showing the video you just opened, set goalMet true — do not tap the back chevron to re-pick.',
        leave_editor: 'Goal: the caption composer (Add description / Drafts / Post). Tap the pink Next on the bottom-right. Never tap Your Story.',
        fill_caption: 'Goal: the caption field is ready or the keyboard is dismissed so Drafts and Post are visible. Tap Add description if needed. Do not tap Drafts or Post yet.',
        finish: destination === 'publish'
            ? 'Goal: tap the pink Post button (bottom-right). Do not tap Drafts or Your Story.'
            : 'Goal: tap Drafts (bottom-left). Do not tap Post or Your Story.',
    };
    return extra ? `${goals[goal]} ${extra}` : goals[goal];
}

interface ChatCompletion {
    choices?: Array<{ message?: { content?: unknown } }>;
}

export async function askVisionGuide(options: {
    image: Buffer;
    goal: VideoVisionGoal;
    destination?: 'draft' | 'publish';
    extra?: string;
    config?: DeepSeekConfig;
}): Promise<VisionDecision> {
    const config = options.config ?? deepSeekConfig();
    const jpeg = await screenshotToJpeg(options.image);
    const destination = options.destination ?? 'draft';
    const payload = {
        model: config.model,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
        messages: [
            { role: 'system', content: visionSystemPrompt() },
            {
                role: 'user',
                content: [
                    { type: 'text', text: visionGoalPrompt(options.goal, destination, options.extra) },
                    {
                        type: 'image_url',
                        image_url: {
                            url: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
                            detail: 'high',
                        },
                    },
                ],
            },
        ],
    };
    const response = await httpJson<ChatCompletion>(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${config.apiKey}`,
            'content-type': 'application/json',
            'HTTP-Referer': 'https://github.com/CypherHub/prod-FARM-IOS-Core',
            'X-Title': 'phone-farm-core',
        },
        body: JSON.stringify(payload),
        timeoutMs: 60_000,
        retries: 2,
    });
    return parseVisionDecision(messageContent(response));
}

function messageContent(response: ChatCompletion): string {
    const content = response.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text?: unknown }).text ?? '') : ''))
            .join('\n');
    }
    throw new Error('OpenRouter returned an empty completion');
}

function extractJsonObject(raw: string): string {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return fenced[1].trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) return raw.slice(start, end + 1);
    return raw.trim();
}

function number01(value: unknown, name: string): number {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number)) throw new Error(`Missing ${name} for a tap`);
    if (number < 0 || number > 1) throw new Error(`${name} must be between 0 and 1`);
    return number;
}

function clamp01(value: number): number {
    return Math.min(1, Math.max(0, value));
}
