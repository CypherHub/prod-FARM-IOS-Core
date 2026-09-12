CREATE TYPE "scheduler"."hook_run_status" AS ENUM('pending', 'generating', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "scheduler"."hook_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bookmark_id" uuid NOT NULL,
	"status" "scheduler"."hook_run_status" DEFAULT 'pending' NOT NULL,
	"prompt" text,
	"hooks" jsonb,
	"error" text,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scheduler"."generations" ADD COLUMN "hook_run_id" uuid;--> statement-breakpoint
ALTER TABLE "scheduler"."generations" ADD COLUMN "gallery_video" text;--> statement-breakpoint
ALTER TABLE "scheduler"."hook_runs" ADD CONSTRAINT "hook_runs_bookmark_id_bookmarks_id_fk" FOREIGN KEY ("bookmark_id") REFERENCES "scheduler"."bookmarks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hook_runs_bookmark_idx" ON "scheduler"."hook_runs" USING btree ("bookmark_id","created_at");--> statement-breakpoint
ALTER TABLE "scheduler"."generations" ADD CONSTRAINT "generations_hook_run_id_hook_runs_id_fk" FOREIGN KEY ("hook_run_id") REFERENCES "scheduler"."hook_runs"("id") ON DELETE set null ON UPDATE no action;