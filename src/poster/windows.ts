export const POSTER_HANDLES = ['@pixl.robotics', '@my_sane_tea'] as const;
export type PosterHandle = (typeof POSTER_HANDLES)[number];

export const POSTER_WINDOW_IDS = ['9am-noon', 'noon-3pm', '3pm-6pm', '6pm-9pm', '9pm-midnight'] as const;
export type PosterWindowId = (typeof POSTER_WINDOW_IDS)[number];

export interface PosterSlot {
    id: PosterWindowId;
    label: string;
    startMin: number;
    endMin: number;
}

export const POSTER_SLOTS: readonly PosterSlot[] = [
    { id: '9am-noon', label: '9am–noon', startMin: 9 * 60, endMin: 12 * 60 },
    { id: 'noon-3pm', label: 'Noon–3pm', startMin: 12 * 60, endMin: 15 * 60 },
    { id: '3pm-6pm', label: '3pm–6pm', startMin: 15 * 60, endMin: 18 * 60 },
    { id: '6pm-9pm', label: '6pm–9pm', startMin: 18 * 60, endMin: 21 * 60 },
    { id: '9pm-midnight', label: '9pm–midnight', startMin: 21 * 60, endMin: 24 * 60 },
];

/** Old shared Schedule-page ids, mapped onto the NYC slots. */
const LEGACY_WINDOW_IDS: Record<string, PosterWindowId> = {
    morning: '9am-noon',
    afternoon: 'noon-3pm',
    evening: '3pm-6pm',
};

export function coercePosterWindowId(value: string): PosterWindowId | undefined {
    if ((POSTER_WINDOW_IDS as readonly string[]).includes(value)) return value as PosterWindowId;
    return LEGACY_WINDOW_IDS[value];
}

export const POST_DURATION_BUFFER_MS = 12 * 60_000;
export const DEFAULT_TIMEZONE = 'America/New_York';

export function switchWorkflowName(handle: string): string {
    return `Switch Account to ${handle}`;
}

export function postWorkflowName(handle: string): string {
    return `Post from Drafts of ${handle}`;
}

export function slotKey(date: string, windowId: string, handle: string): string {
    return `${date}:${windowId}:${handle}`;
}

export function normalizeHandle(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return trimmed;
    return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

export function isPosterHandle(value: string): value is PosterHandle {
    return (POSTER_HANDLES as readonly string[]).includes(value);
}

export function isPosterWindowId(value: string): value is PosterWindowId {
    return (POSTER_WINDOW_IDS as readonly string[]).includes(value);
}

export interface ZonedClock {
    date: string;
    minutes: number;
    year: number;
    month: number;
    day: number;
}

export function zonedClock(now: Date, timezone: string): ZonedClock {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        }).formatToParts(now).map((part) => [part.type, part.value]),
    );
    const year = Number(parts.year);
    const month = Number(parts.month);
    const day = Number(parts.day);
    const hour = Number(parts.hour);
    const minute = Number(parts.minute);
    return {
        year, month, day, minutes: hour * 60 + minute,
        date: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    };
}

/** Milliseconds to add to UTC to get the zone's wall-clock as if it were UTC. */
export function timezoneOffsetMs(date: Date, timezone: string): number {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
    );
    const asUtc = Date.UTC(
        Number(parts.year), Number(parts.month) - 1, Number(parts.day),
        Number(parts.hour), Number(parts.minute), Number(parts.second),
    );
    return asUtc - date.getTime();
}

export function wallTimeToUtc(
    timezone: string, year: number, month: number, day: number, hour: number, minute: number,
): Date {
    const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
    const first = new Date(wallAsUtc - timezoneOffsetMs(new Date(wallAsUtc), timezone));
    return new Date(wallAsUtc - timezoneOffsetMs(first, timezone));
}

export interface OpenWindow {
    id: PosterWindowId;
    date: string;
    start: Date;
    end: Date;
}

export function openWindows(now: Date, timezone: string, selected: readonly PosterWindowId[]): OpenWindow[] {
    const clock = zonedClock(now, timezone);
    const chosen = new Set(selected);
    const open: OpenWindow[] = [];
    for (const slot of POSTER_SLOTS) {
        if (!chosen.has(slot.id)) continue;
        if (clock.minutes < slot.startMin || clock.minutes >= slot.endMin) continue;
        const startHour = Math.floor(slot.startMin / 60);
        const startMinute = slot.startMin % 60;
        const endHour = Math.floor(slot.endMin / 60);
        const endMinute = slot.endMin % 60;
        open.push({
            id: slot.id,
            date: clock.date,
            start: wallTimeToUtc(timezone, clock.year, clock.month, clock.day, startHour, startMinute),
            end: wallTimeToUtc(timezone, clock.year, clock.month, clock.day, endHour, endMinute),
        });
    }
    return open;
}

export function planTime(
    now: Date, windowEnd: Date, random: () => number = Math.random, bufferMs = POST_DURATION_BUFFER_MS,
): Date | null {
    const latest = windowEnd.getTime() - bufferMs;
    if (now.getTime() >= latest) return null;
    const span = latest - now.getTime();
    return new Date(now.getTime() + Math.floor(Math.max(0, random()) * span));
}

export function nextRetryAt(now: Date, attempts: number): Date {
    const shift = Math.max(0, attempts - 1);
    const minutes = Math.min(15, 2 * (2 ** shift));
    return new Date(now.getTime() + minutes * 60_000);
}
