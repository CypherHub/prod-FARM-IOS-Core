import path from 'node:path';

// `dataRoot` is resolved independently in several core files already
// (api/app.ts, tiktok-plugin.ts, scheduler/repository.ts). Centralize it here
// for content so the traversal guard has one definition to agree with.
export function dataRoot(): string {
    return path.resolve(process.env.SCHEDULER_DATA_DIR ?? '.scheduler-data');
}

export function bookmarkRoot(): string {
    return path.join(dataRoot(), 'bookmarks');
}

export function bookmarkDirectory(bookmarkId: string): string {
    return path.join(bookmarkRoot(), bookmarkId);
}

/**
 * Resolves a stored relative path against the data root and refuses anything
 * that escapes it. Mirrors the guard in SchedulerRepository.purgeAssetIds —
 * relative paths come out of the database and feed a byte-serving HTTP route,
 * so `..` must never resolve outside the root.
 */
export function resolveWithinDataRoot(relativePath: string): string {
    const root = dataRoot();
    const resolved = path.resolve(root, relativePath);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        throw new Error(`Refusing to resolve ${relativePath} outside the scheduler data directory`);
    }
    return resolved;
}

export function toRelative(absolutePath: string): string {
    return path.relative(dataRoot(), absolutePath);
}
