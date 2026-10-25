ALTER TABLE "generated_artifacts" ADD COLUMN "agent_trace" jsonb;--> statement-breakpoint
ALTER TABLE "generated_artifacts" ADD COLUMN "evidence_hash" text;--> statement-breakpoint
CREATE INDEX "generated_artifacts_case_type_evidence_idx" ON "generated_artifacts" USING btree ("application_id","type","evidence_hash");