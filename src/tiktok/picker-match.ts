import sharp from 'sharp';

import { circledPickerCells, type PickerLayout, type PickerTarget } from './post-layout.js';

const THUMB = 32;
export const PICKER_MATCH_MAE_MAX = 48;

export function mae(a: Buffer, b: Buffer): number {
    if (a.length !== b.length) throw new Error('MAE buffers must be the same length');
    let sum = 0;
    for (let i = 0; i < a.length; i += 1) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
    return sum / a.length;
}

// First (topmost) cell whose best slide is under the MAE cap wins that slide.
export function assignTopSlideMatches(cellMaes: number[][], slideCount: number, maxMae = PICKER_MATCH_MAE_MAX): Array<number | undefined> {
    const found: Array<number | undefined> = Array.from({ length: slideCount }, () => undefined);
    for (let cell = 0; cell < cellMaes.length; cell += 1) {
        const scores = cellMaes[cell];
        if (!scores?.length) continue;
        let best = 0;
        for (let slide = 1; slide < scores.length; slide += 1) {
            if ((scores[slide] ?? Infinity) < (scores[best] ?? Infinity)) best = slide;
        }
        if ((scores[best] ?? Infinity) <= maxMae && found[best] === undefined) found[best] = cell;
    }
    return found;
}

async function toThumb(image: Buffer, extract?: sharp.Region): Promise<Buffer> {
    const pipeline = extract ? sharp(image).extract(extract) : sharp(image);
    const { data } = await pipeline
        .resize(THUMB, THUMB, { fit: 'fill' })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    return data;
}

// Recents shows a square-ish crop of each 9:16 still, not always the same
// vertical band, so keep several square windows per slide.
export async function slideCropTemplates(image: Buffer): Promise<Buffer[]> {
    const meta = await sharp(image).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width < 8 || height < 8) throw new Error('Slide image is too small to match in the picker');
    const side = Math.min(width, height);
    const maxTop = Math.max(0, height - side);
    const tops = [...new Set([0, Math.round(maxTop * 0.25), Math.round(maxTop * 0.5), Math.round(maxTop * 0.75), maxTop])];
    const crops: Buffer[] = [];
    for (const top of tops) {
        crops.push(await toThumb(image, { left: 0, top, width: side, height: side }));
    }
    return crops;
}

async function cellThumb(
    screenshot: Buffer,
    column: number,
    row: number,
    layout: PickerLayout,
    scale: number,
): Promise<Buffer | undefined> {
    const meta = await sharp(screenshot).metadata();
    const imageWidth = meta.width ?? 0;
    const imageHeight = meta.height ?? 0;
    const left = Math.round((column * layout.columnStep * scale) + (8 * scale));
    const top = Math.round(((layout.firstY + (row * layout.rowStep)) * scale) + (8 * scale));
    const width = Math.round((layout.columnStep * scale) - (22 * scale));
    const height = Math.round((layout.rowStep * scale) - (18 * scale));
    if (left < 0 || top < 0 || left + width > imageWidth || top + height > imageHeight || width < 16 || height < 16) {
        return undefined;
    }
    return toThumb(screenshot, { left, top, width, height });
}

export async function matchSlidesInPicker(
    screenshot: Buffer,
    slideTemplates: Buffer[][],
    layout: PickerLayout,
    scale: number,
    rows = 4,
): Promise<Array<{ target: PickerTarget; column: number; row: number; mae: number } | undefined>> {
    const cells = circledPickerCells(layout, rows);
    const cellMaes: number[][] = [];
    for (const cell of cells) {
        const thumb = await cellThumb(screenshot, cell.column, cell.row, layout, scale);
        if (!thumb) {
            cellMaes.push(slideTemplates.map(() => Infinity));
            continue;
        }
        cellMaes.push(slideTemplates.map((crops) => Math.min(...crops.map((crop) => mae(thumb, crop)))));
    }
    const found = assignTopSlideMatches(cellMaes, slideTemplates.length);
    return found.map((cellIndex, slideIndex) => {
        if (cellIndex === undefined) return undefined;
        const cell = cells[cellIndex];
        if (!cell) return undefined;
        const score = cellMaes[cellIndex]?.[slideIndex] ?? Infinity;
        console.log(
            `Picker matched slide ${slideIndex + 1} at row ${cell.row} col ${cell.column} mae=${score.toFixed(1)}`,
        );
        return { target: cell.circle, column: cell.column, row: cell.row, mae: score };
    });
}
