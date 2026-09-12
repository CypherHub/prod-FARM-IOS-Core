ALTER TABLE "scheduler"."bookmarks" ADD COLUMN "hook" text;--> statement-breakpoint
ALTER TABLE "scheduler"."generations" ADD COLUMN "hook" text;--> statement-breakpoint
ALTER TABLE "scheduler"."generations" ADD COLUMN "prompt" text;