import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface DownloadedFile {
    absolutePath: string;
    size: number;
    sha256: string;
    mimeType: string;
}

const EXTENSION_BY_MIME: Record<string, string> = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
    'video/mp4': '.mp4', 'video/quicktime': '.mov',
};

const MAX_BYTES = Number(process.env.CONTENT_MAX_DOWNLOAD_BYTES ?? 512 * 1024 * 1024);

function extensionFor(mimeType: string, fallback: string): string {
    return EXTENSION_BY_MIME[mimeType] ?? fallback;
}

/**
 * Streams a remote file to disk, hashing as it goes — the same streaming-hash
 * shape the generic asset upload in src/api/app.ts uses, so a partial download
 * never leaves a half-file that looks complete.
 */
export async function downloadTo(
    url: string,
    directory: string,
    baseName: string,
    options: { signal?: AbortSignal; fallbackExtension?: string } = {},
): Promise<DownloadedFile> {
    await mkdir(directory, { recursive: true });
    const timeout = AbortSignal.timeout(Number(process.env.CONTENT_DOWNLOAD_TIMEOUT_MS ?? 120_000));
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await fetch(url, { signal });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) for ${url}`);

    const mimeType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim()
        || (options.fallbackExtension === '.mp4' ? 'video/mp4' : 'image/jpeg');
    const absolutePath = path.join(directory, baseName + extensionFor(mimeType, options.fallbackExtension ?? '.jpg'));

    const hash = createHash('sha256');
    let size = 0;
    const counted = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    counted.on('data', (chunk: Buffer) => {
        size += chunk.length;
        hash.update(chunk);
        if (size > MAX_BYTES) counted.destroy(new Error(`${url} exceeds the ${MAX_BYTES} byte download limit`));
    });

    try {
        await pipeline(counted, createWriteStream(absolutePath, { flags: 'wx' }));
    } catch (error) {
        await rm(absolutePath, { force: true });
        throw error;
    }
    return { absolutePath, size, sha256: hash.digest('hex'), mimeType };
}
