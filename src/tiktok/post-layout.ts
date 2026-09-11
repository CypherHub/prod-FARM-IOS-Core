export interface PickerLayout {
    circleX: number;
    columnStep: number;
    firstY: number;
    trayY: number;
    rowStep: number;
}

export interface PickerTarget {
    x: number;
    y: number;
}

export function pickerCircle(column: number, row: number, layout: PickerLayout): PickerTarget {
    return {
        x: layout.circleX + (column * layout.columnStep),
        y: layout.firstY + (row * layout.rowStep),
    };
}

export function circledPickerCells(layout: PickerLayout, rows = 3): Array<{ column: number; row: number; circle: PickerTarget }> {
    const cells: Array<{ column: number; row: number; circle: PickerTarget }> = [];
    for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < 3; column += 1) {
            cells.push({ column, row, circle: pickerCircle(column, row, layout) });
        }
    }
    return cells;
}

// Finger-up swipe (content moves up) after the first selection. TikTok's
// picked-slide preview covers the newest Recents row; this reveals the rest.
export function pickerScrollSwipe(layout: PickerLayout, direction: 'up' | 'down'): {
    startX: number; startY: number; endX: number; endY: number; durationMs: number;
} {
    const x = Math.round(layout.columnStep * 1.5);
    const lower = layout.firstY + layout.rowStep;
    const upper = layout.firstY;
    if (direction === 'up') {
        return { startX: x, startY: lower, endX: x, endY: upper, durationMs: 400 };
    }
    return { startX: x, startY: upper, endX: x, endY: lower, durationMs: 400 };
}

export function recentPickerTargets(assetCount: number, count: number, layout: PickerLayout): PickerTarget[] {
    if (!Number.isSafeInteger(assetCount) || assetCount < count || count < 1) {
        throw new Error('Photos asset count cannot satisfy the requested media selection');
    }
    // Recents circled grid, newest-first, left-to-right then down.
    // Index 0 is the last imported still (Cover). Index 1 is the one before.
    // Do not tap above firstY — that Recents strip has no circles.
    return Array.from({ length: count }, (_, index) => pickerCircle(index % 3, Math.floor(index / 3), layout));
}
