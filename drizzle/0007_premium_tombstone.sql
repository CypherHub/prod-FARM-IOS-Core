CREATE TYPE "scheduler"."workflow_status" AS ENUM('draft', 'active', 'completed', 'archived');--> statement-breakpoint
CREATE TYPE "scheduler"."workflow_step_type" AS ENUM('tap', 'swipe', 'wait', 'if_condition', 'app_action', 'home', 'unlock', 'open_url', 'screenshot');--> statement-breakpoint
CREATE TABLE "scheduler"."workflow_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"step_order" integer NOT NULL,
	"step_type" "scheduler"."workflow_step_type" NOT NULL,
	"label" text,
	"x" integer,
	"y" integer,
	"end_x" integer,
	"end_y" integer,
	"duration_ms" integer,
	"wait_ms" integer,
	"ai_question" text,
	"app_bundle_id" text,
	"app_action_type" text,
	"url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduler"."workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"device_udid" text,
	"status" "scheduler"."workflow_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scheduler"."workflow_steps" ADD CONSTRAINT "workflow_steps_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "scheduler"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_steps_workflow_idx" ON "scheduler"."workflow_steps" USING btree ("workflow_id","step_order");--> statement-breakpoint
CREATE INDEX "workflows_device_idx" ON "scheduler"."workflows" USING btree ("device_udid","created_at");