// XCUITest exposes TikTok's picker toggles inconsistently: sometimes
// `selected`, sometimes `value` (0/1/true/false/selected). Color sampling
// is the fallback when both are empty — it cannot be trusted for "already
// on" by itself, because a red record button on the camera screen sits near
// the same coordinates as "Select multiple".
export function checkboxOnFromAttributes(
    selected?: string | null,
    value?: string | null,
): boolean | undefined {
    const flags = [selected, value].map((item) => String(item ?? '').trim().toLowerCase());
    if (flags.some((flag) => flag === 'true' || flag === '1' || flag === 'selected')) return true;
    if (flags.some((flag) => flag === 'false' || flag === '0' || flag === 'unselected')) return false;
    return undefined;
}

export const SELECT_MULTIPLE_SELECTORS = [
    '~Select multiple',
    '-ios predicate string:(label CONTAINS[c] "Select multiple") OR (name CONTAINS[c] "Select multiple")',
];
