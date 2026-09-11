import type { OcrWord } from './ocr.js';

function composerText(words: Array<{ text: string }>): string {
    return words.map((word) => word.text.toLowerCase().replace(/[’]/g, "'")).join(' ');
}

// TEXT mode's share sheet defaults to Your Story. The calibrated PHOTO point
// sits on TEXT when the camera already opened in PHOTO (the pill shifts left).
export function isTextStoryComposer(words: Array<{ text: string }>): boolean {
    if (isVideoEditorStoryBar(words)) return false;
    const text = composerText(words);
    return text.includes('type something')
        || (text.includes('your story') && text.includes('post to feed'))
        || (text.includes('post to feed') && text.includes('story'));
}

// Single-video editor: Your Story (left) | Next (right). Tapping Drafts coords here posts a story.
export function isVideoEditorStoryBar(words: Array<{ text: string }>): boolean {
    const text = composerText(words);
    if (text.includes('everyone can view') || text.includes('add description') || text.includes('catchy')) return false;
    if (text.includes('post to feed') || text.includes('type something')) return false;
    return text.includes('your story') || text.includes('autocut');
}

export function isCaptionComposer(words: Array<{ text: string }>): boolean {
    const text = composerText(words);
    if (text.includes('your story')) return false;
    return text.includes('everyone can view')
        || text.includes('add description')
        || text.includes('catchy')
        || (text.includes('drafts') && text.includes('post'));
}

export function isLiveCamera(words: Array<{ text: string }>): boolean {
    const text = composerText(words);
    return text.includes('go live') || text.includes('check live');
}

// Bottom-most exact match so "POST" the camera tab wins over a stray "Post".
export function lowestExactWord(words: OcrWord[], needle: string): OcrWord | undefined {
    const want = needle.toLowerCase();
    const matches = words.filter((word) => word.text.toLowerCase().replace(/[’]/g, "'") === want);
    if (!matches.length) return undefined;
    return matches.reduce((lowest, word) => (word.y > lowest.y ? word : lowest));
}
