CREATE TYPE "scheduler"."local_draft_status" AS ENUM('draft', 'saved', 'queued');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scheduler"."local_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bookmark_id" uuid NOT NULL,
	"hook_run_id" uuid,
	"gallery_name" text NOT NULL,
	"gallery_video" text NOT NULL,
	"trim_start_seconds" real DEFAULT 0 NOT NULL,
	"trim_end_seconds" real,
	"duration_seconds" real,
	"hook" text NOT NULL,
	"hook_align" "scheduler"."hook_align" DEFAULT 'left' NOT NULL,
	"caption" text DEFAULT '' NOT NULL,
	"device_udid" text,
	"account" text,
	"status" "scheduler"."local_draft_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS "scheduler"."local_drafts_bookmark_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "local_drafts_bookmark_idx" ON "scheduler"."local_drafts" USING btree ("bookmark_id" text_ops,"created_at" timestamptz_ops);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduler"."local_drafts" ADD CONSTRAINT "local_drafts_bookmark_id_bookmarks_id_fk" FOREIGN KEY ("bookmark_id") REFERENCES "scheduler"."bookmarks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scheduler"."local_drafts" ADD CONSTRAINT "local_drafts_hook_run_id_hook_runs_id_fk" FOREIGN KEY ("hook_run_id") REFERENCES "scheduler"."hook_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;