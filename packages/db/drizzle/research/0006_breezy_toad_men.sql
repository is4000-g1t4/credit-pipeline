CREATE TYPE "public"."policy_status" AS ENUM('not_applicable', 'running', 'succeeded', 'no_match', 'needs_policy_owner', 'budget_exceeded', 'failed', 'skipped');--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "policy_status" "policy_status" DEFAULT 'not_applicable' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "policy_brief" jsonb;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "policy_validation" jsonb;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "policy_usage" jsonb;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "policy_error_code" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "policy_model" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "policy_prompt_version" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "policy_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "policy_finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "policy_timeout_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "policy_heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "context_document_findings" jsonb;--> statement-breakpoint
CREATE INDEX "agent_runs_policy_status_timeout_idx" ON "agent_runs" USING btree ("policy_status","policy_timeout_at");