import sharp from 'sharp';

export interface TapPoint {
    x: number;
    y: number;
}

export async function annotateTap(
    image: Buffer,
    tap: TapPoint,
    options: { scale?: number; label?: string } = {},
): Promise<Buffer> {
    const meta = await sharp(image).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (!width || !height) return image;
    const scale = options.scale ?? (width >= 600 ? 2 : 1);
    const cx = Math.round(Math.min(width - 1, Math.max(0, tap.x * scale)));
    const cy = Math.round(Math.min(height - 1, Math.max(0, tap.y * scale)));
    const radius = Math.max(18, Math.round(Math.min(width, height) * 0.035));
    const label = escapeXml(options.label ?? `${tap.x},${tap.y}`);
    const labelY = Math.max(28, cy - radius - 26);
    const svg = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
        `<circle cx="${cx}" cy="${cy}" r="${radius + 6}" fill="none" stroke="#ff2d2d" stroke-width="6"/>`,
        `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="#fff200" stroke-width="4"/>`,
        `<line x1="${cx - radius - 14}" y1="${cy}" x2="${cx + radius + 14}" y2="${cy}" stroke="#ff2d2d" stroke-width="4"/>`,
        `<line x1="${cx}" y1="${cy - radius - 14}" x2="${cx}" y2="${cy + radius + 14}" stroke="#ff2d2d" stroke-width="4"/>`,
        `<circle cx="${cx}" cy="${cy}" r="6" fill="#fff200"/>`,
        `<rect x="${Math.max(8, cx - 90)}" y="${Math.max(8, labelY - 20)}" width="180" height="28" rx="6" fill="#000000cc"/>`,
        `<text x="${cx}" y="${labelY}" fill="#fff200" font-size="20" font-family="sans-serif" text-anchor="middle">${label}</text>`,
        '</svg>',
    ].join('');
    return sharp(image).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer();
}

function escapeXml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
