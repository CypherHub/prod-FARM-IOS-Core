ALTER TYPE "scheduler"."workflow_step_type" ADD VALUE 'type_keys';--> statement-breakpoint
ALTER TABLE "scheduler"."workflow_steps" ADD COLUMN "text" text;