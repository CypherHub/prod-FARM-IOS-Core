export const TIKTOK_TITLE_MAX = 90;

export function splitComposerCopy(raw?: string): { title?: string; caption?: string } {
    if (!raw?.trim()) return {};
    const text = raw.replace(/^\uFEFF/, '').trim();
    const blankLine = text.match(/^(.{1,90})\n[ \t]*\n([\s\S]+)$/);
    if (blankLine) {
        return { title: blankLine[1]!.trim(), caption: blankLine[2]!.trim() };
    }
    return { caption: text };
}
