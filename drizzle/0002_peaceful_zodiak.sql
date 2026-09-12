CREATE TYPE "scheduler"."bookmark_kind" AS ENUM('slideshow', 'video');--> statement-breakpoint
CREATE TYPE "scheduler"."bookmark_media_role" AS ENUM('slide', 'video', 'cover');--> statement-breakpoint
CREATE TYPE "scheduler"."bookmark_status" AS ENUM('pending', 'ingesting', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "scheduler"."generation_status" AS ENUM('pending', 'generating', 'ready', 'failed', 'queued');--> statement-breakpoint
CREATE TABLE "scheduler"."bookmark_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bookmark_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"role" "scheduler"."bookmark_media_role" NOT NULL,
	"relative_path" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"width" integer,
	"height" integer,
	"ocr_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookmark_media_relative_path_unique" UNIQUE("relative_path")
);
--> statement-breakpoint
CREATE TABLE "scheduler"."bookmarks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_url" text NOT NULL,
	"tiktok_id" text,
	"status" "scheduler"."bookmark_status" DEFAULT 'pending' NOT NULL,
	"kind" "scheduler"."bookmark_kind",
	"caption" text,
	"author_name" text,
	"author_nickname" text,
	"music_url" text,
	"music_name" text,
	"music_author" text,
	"music_id" text,
	"play_count" bigint,
	"digg_count" bigint,
	"comment_count" bigint,
	"share_count" bigint,
	"collect_count" bigint,
	"hashtags" jsonb,
	"mentions" jsonb,
	"raw" jsonb,
	"media_dir" text,
	"error" text,
	"posted_at" timestamp with time zone,
	"ingested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookmarks_source_url_unique" UNIQUE("source_url")
);
--> statement-breakpoint
CREATE TABLE "scheduler"."generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bookmark_id" uuid NOT NULL,
	"status" "scheduler"."generation_status" DEFAULT 'pending' NOT NULL,
	"gallery_dir" text NOT NULL,
	"output_dir" text,
	"device_udid" text,
	"account" text,
	"plan" jsonb,
	"caption" text,
	"music_url" text,
	"queued_schedule_id" uuid,
	"error" text,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scheduler"."bookmark_media" ADD CONSTRAINT "bookmark_media_bookmark_id_bookmarks_id_fk" FOREIGN KEY ("bookmark_id") REFERENCES "scheduler"."bookmarks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler"."generations" ADD CONSTRAINT "generations_bookmark_id_bookmarks_id_fk" FOREIGN KEY ("bookmark_id") REFERENCES "scheduler"."bookmarks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduler"."generations" ADD CONSTRAINT "generations_queued_schedule_id_schedules_id_fk" FOREIGN KEY ("queued_schedule_id") REFERENCES "scheduler"."schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bookmark_media_slot_idx" ON "scheduler"."bookmark_media" USING btree ("bookmark_id","role","index");--> statement-breakpoint
CREATE INDEX "bookmarks_status_idx" ON "scheduler"."bookmarks" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "bookmarks_tiktok_idx" ON "scheduler"."bookmarks" USING btree ("tiktok_id");--> statement-breakpoint
CREATE INDEX "generations_bookmark_idx" ON "scheduler"."generations" USING btree ("bookmark_id","created_at");--> statement-breakpoint
CREATE INDEX "generations_status_idx" ON "scheduler"."generations" USING btree ("status","created_at");