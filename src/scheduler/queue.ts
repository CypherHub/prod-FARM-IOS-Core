import { PgBoss } from 'pg-boss';
import crypto from 'node:crypto';

import { databaseUrl } from '../database/client.js';

export interface ExecutionJob {
    executionId: string;
}

export function queueNameForDevice(udid: string): string {
    const key = crypto.createHash('sha256').update(udid).digest('hex').slice(0, 20);
    return `ios-device-${key}`;
}

export function createQueue({ migrate = false }: { migrate?: boolean } = {}): PgBoss {
    const boss = new PgBoss({
        connectionString: databaseUrl(),
        schema: 'pgboss',
        schedule: false,
        useListenNotify: true,
        migrate,
        createSchema: migrate,
    });
    boss.on('error', (error) => console.error('pg-boss:', error));
    return boss;
}

export async function ensureDeviceQueue(boss: PgBoss, udid: string): Promise<string> {
    const name = queueNameForDevice(udid);
    if (!await boss.getQueue(name)) {
        await boss.createQueue(name, {
            policy: 'singleton',
            notify: true,
            heartbeatSeconds: 60,
            deleteAfterSeconds: 30 * 24 * 60 * 60,
        });
    }
    return name;
}

export const CONTENT_INGEST_QUEUE = 'content-ingest';
export const CONTENT_GENERATE_QUEUE = 'content-generate';
export const CONTENT_HOOKS_QUEUE = 'content-hooks';

export interface ContentIngestJob { bookmarkId: string }
export interface ContentGenerateJob { generationId: string }
export interface ContentHookJob { hookRunId: string }

/**
 * Content jobs are not bound to a phone, so they deliberately do not use
 * queueNameForDevice: a scrape or an AI generation must never occupy a
 * device's singleton queue and block a real post.
 */
export async function ensureContentQueue(boss: PgBoss, name: string, policy: 'standard' | 'singleton'): Promise<string> {
    if (!await boss.getQueue(name)) {
        await boss.createQueue(name, {
            policy,
            notify: true,
            heartbeatSeconds: 60,
            deleteAfterSeconds: 30 * 24 * 60 * 60,
        });
    }
    return name;
}
