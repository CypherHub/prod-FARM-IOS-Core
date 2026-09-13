import { bigint, index, integer, jsonb, pgSchema, primaryKey, real, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import type { JsonObject, ScheduleTiming } from '../types.js';

export const schedulerSchema = pgSchema('scheduler');
export const scheduleStatus = schedulerSchema.enum('schedule_status', ['active', 'paused', 'completed', 'cancelled']);
export const executionStatus = schedulerSchema.enum('execution_status', [
    'queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped', 'stopped',
]);
export const bookmarkStatus = schedulerSchema.enum('bookmark_status', ['pending', 'ingesting', 'ready', 'failed']);
export const bookmarkKind = schedulerSchema.enum('bookmark_kind', ['slideshow', 'video']);
export const bookmarkMediaRole = schedulerSchema.enum('bookmark_media_role', ['slide', 'video', 'cover']);
export const generationStatus = schedulerSchema.enum('generation_status', [
    'pending', 'generating', 'ready', 'failed', 'queued',
]);
export const hookRunStatus = schedulerSchema.enum('hook_run_status', ['pending', 'generating', 'ready', 'failed']);
export const hookAlign = schedulerSchema.enum('hook_align', ['left', 'center', 'right']);

const taskColumns = {
    pluginId: text('plugin_id').notNull(),
    taskType: text('task_type').notNull(),
    taskVersion: integer('task_version').notNull(),
    payload: jsonb('payload').$type<JsonObject>().notNull(),
};

export const schedules = schedulerSchema.table('schedules', {
    id: uuid('id').primaryKey().defaultRandom(), deviceUdid: text('device_udid').notNull(), ...taskColumns,
    timing: jsonb('timing').$type<ScheduleTiming>().notNull(),
    status: scheduleStatus('status').notNull().default('active'),
    runWindowMinutes: integer('run_window_minutes').notNull().default(30),
    nextRunAt: timestamp('next_run_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
    index('schedules_due_idx').on(table.status, table.nextRunAt),
    index('schedules_device_idx').on(table.deviceUdid, table.createdAt),
    index('schedules_plugin_idx').on(table.pluginId, table.taskType, table.taskVersion),
]);

export const executions = schedulerSchema.table('executions', {
    id: uuid('id').primaryKey().defaultRandom(),
    scheduleId: uuid('schedule_id').references(() => schedules.id, { onDelete: 'set null' }),
    deviceUdid: text('device_udid').notNull(), ...taskColumns,
    scheduledFor: timestamp('scheduled_for', { withTimezone: true, mode: 'date' }).notNull(),
    deadlineAt: timestamp('deadline_at', { withTimezone: true, mode: 'date' }).notNull(),
    status: executionStatus('status').notNull().default('queued'), queueJobId: text('queue_job_id'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }), exitCode: integer('exit_code'),
    error: text('error'), stopRequestedAt: timestamp('stop_requested_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
    uniqueIndex('executions_schedule_occurrence_idx').on(table.scheduleId, table.scheduledFor),
    index('executions_device_status_idx').on(table.deviceUdid, table.status),
    index('executions_plugin_idx').on(table.pluginId, table.taskType, table.taskVersion),
]);

export const executionAttempts = schedulerSchema.table('execution_attempts', {
    executionId: uuid('execution_id').notNull().references(() => executions.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }), exitCode: integer('exit_code'), error: text('error'),
}, (table) => [primaryKey({ columns: [table.executionId, table.attempt] })]);

export const executionLogs = schedulerSchema.table('execution_logs', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    executionId: uuid('execution_id').notNull().references(() => executions.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(), line: text('line').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [index('execution_logs_execution_idx').on(table.executionId, table.id)]);

export const assets = schedulerSchema.table('assets', {
    id: uuid('id').primaryKey().defaultRandom(),
    scheduleId: uuid('schedule_id').references(() => schedules.id, { onDelete: 'cascade' }),
    executionId: uuid('execution_id').references(() => executions.id, { onDelete: 'cascade' }),
    relativePath: text('relative_path').notNull().unique(), originalName: text('original_name').notNull(),
    mimeType: text('mime_type').notNull(), size: bigint('size', { mode: 'number' }).notNull(), sha256: text('sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [index('assets_schedule_idx').on(table.scheduleId), index('assets_execution_idx').on(table.executionId)]);

export const bookmarks = schedulerSchema.table('bookmarks', {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceUrl: text('source_url').notNull().unique(), tiktokId: text('tiktok_id'),
    status: bookmarkStatus('status').notNull().default('pending'), kind: bookmarkKind('kind'),
    caption: text('caption'), authorName: text('author_name'), authorNickname: text('author_nickname'),
    musicUrl: text('music_url'), musicName: text('music_name'), musicAuthor: text('music_author'), musicId: text('music_id'),
    playCount: bigint('play_count', { mode: 'number' }), diggCount: bigint('digg_count', { mode: 'number' }),
    commentCount: bigint('comment_count', { mode: 'number' }), shareCount: bigint('share_count', { mode: 'number' }),
    collectCount: bigint('collect_count', { mode: 'number' }),
    hashtags: jsonb('hashtags').$type<string[]>(), mentions: jsonb('mentions').$type<string[]>(),
    raw: jsonb('raw').$type<JsonObject>(), mediaDir: text('media_dir'), error: text('error'),
    /** The template's hook: OCR of the video's first frame, or of slide 1. */
    hook: text('hook'),
    postedAt: timestamp('posted_at', { withTimezone: true, mode: 'date' }),
    ingestedAt: timestamp('ingested_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
    index('bookmarks_status_idx').on(table.status, table.createdAt),
    index('bookmarks_tiktok_idx').on(table.tiktokId),
]);

export const bookmarkMedia = schedulerSchema.table('bookmark_media', {
    id: uuid('id').primaryKey().defaultRandom(),
    bookmarkId: uuid('bookmark_id').notNull().references(() => bookmarks.id, { onDelete: 'cascade' }),
    index: integer('index').notNull(), role: bookmarkMediaRole('role').notNull(),
    relativePath: text('relative_path').notNull().unique(), mimeType: text('mime_type').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(), sha256: text('sha256').notNull(),
    width: integer('width'), height: integer('height'), ocrText: text('ocr_text'),
    /** Video only. The target length a generated video must match. */
    durationSeconds: real('duration_seconds'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [uniqueIndex('bookmark_media_slot_idx').on(table.bookmarkId, table.role, table.index)]);

/** One batch of AI-suggested hooks for a bookmark — step 1 of the create flow. */
export const hookRuns = schedulerSchema.table('hook_runs', {
    id: uuid('id').primaryKey().defaultRandom(),
    bookmarkId: uuid('bookmark_id').notNull().references(() => bookmarks.id, { onDelete: 'cascade' }),
    status: hookRunStatus('status').notNull().default('pending'),
    prompt: text('prompt'), hooks: jsonb('hooks').$type<string[]>(), error: text('error'),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [index('hook_runs_bookmark_idx').on(table.bookmarkId, table.createdAt)]);

export const generations = schedulerSchema.table('generations', {
    id: uuid('id').primaryKey().defaultRandom(),
    bookmarkId: uuid('bookmark_id').notNull().references(() => bookmarks.id, { onDelete: 'cascade' }),
    status: generationStatus('status').notNull().default('pending'),
    galleryDir: text('gallery_dir').notNull(), outputDir: text('output_dir'),
    deviceUdid: text('device_udid'), account: text('account'),
    plan: jsonb('plan').$type<JsonObject>(), caption: text('caption'), musicUrl: text('music_url'),
    /**
     * The hook for this post and any extra steer the operator gave. `hook` is
     * dual-purpose: set at creation it fixes the hook, otherwise the model
     * writes one and it is saved here.
     */
    hook: text('hook'), prompt: text('prompt'),
    /** How the hook is set on screen. */
    hookAlign: hookAlign('hook_align').notNull().default('center'),
    /** Which suggestion batch this came from, and the operator's chosen source clip. */
    hookRunId: uuid('hook_run_id').references(() => hookRuns.id, { onDelete: 'set null' }),
    galleryVideo: text('gallery_video'),
    queuedScheduleId: uuid('queued_schedule_id').references(() => schedules.id, { onDelete: 'set null' }),
    error: text('error'),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
    index('generations_bookmark_idx').on(table.bookmarkId, table.createdAt),
    index('generations_status_idx').on(table.status, table.createdAt),
]);

export const workflowStatus = schedulerSchema.enum('workflow_status', [
    'draft', 'active', 'completed', 'archived',
]);

export const workflowStepType = schedulerSchema.enum('workflow_step_type', [
    'tap', 'swipe', 'wait', 'if_condition', 'app_action', 'home', 'unlock', 'open_url', 'screenshot', 'type_keys',
]);

export const workflows = schedulerSchema.table('workflows', {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    description: text('description'),
    deviceUdid: text('device_udid'),
    status: workflowStatus('status').notNull().default('draft'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
    index('workflows_device_idx').on(table.deviceUdid, table.createdAt),
]);

export const workflowSteps = schedulerSchema.table('workflow_steps', {
    id: uuid('id').primaryKey().defaultRandom(),
    workflowId: uuid('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
    stepOrder: integer('step_order').notNull(),
    stepType: workflowStepType('step_type').notNull(),
    label: text('label'),
    x: integer('x'),
    y: integer('y'),
    endX: integer('end_x'),
    endY: integer('end_y'),
    durationMs: integer('duration_ms'),
    waitMs: integer('wait_ms'),
    aiQuestion: text('ai_question'),
    appBundleId: text('app_bundle_id'),
    appActionType: text('app_action_type'),
    url: text('url'),
    /** Text to type on a type_keys step (e.g. caption text). */
    text: text('text'),
    /** When set on an if_condition step: if AI answers YES, skip this many steps forward. If NO, continue normally (don't stop). */
    skipSteps: integer('skip_steps'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (table) => [
    index('workflow_steps_workflow_idx').on(table.workflowId, table.stepOrder),
]);

export type ScheduleRow = typeof schedules.$inferSelect;
export type ExecutionRow = typeof executions.$inferSelect;
export type WorkflowRow = typeof workflows.$inferSelect;
export type WorkflowStepRow = typeof workflowSteps.$inferSelect;
export type BookmarkRow = typeof bookmarks.$inferSelect;
export type BookmarkMediaRow = typeof bookmarkMedia.$inferSelect;
export type GenerationRow = typeof generations.$inferSelect;
export type HookRunRow = typeof hookRuns.$inferSelect;
