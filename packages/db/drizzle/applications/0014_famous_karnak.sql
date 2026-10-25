CREATE TYPE "public"."fraud_review_severity" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."fraud_review_status" AS ENUM('open', 'cleared', 'confirmed', 'needs_info');--> statement-breakpoint
CREATE TYPE "public"."integrity_candidate_field" AS ENUM('document_type', 'issuer', 'document_date', 'statement_period_start', 'statement_period_end', 'registration_number', 'account_number', 'account_holder_name', 'material_amount', 'other');--> statement-breakpoint
CREATE TYPE "public"."integrity_candidate_status" AS ENUM('candidate', 'validated', 'confirmed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."integrity_consistency_field" AS ENUM('company_name', 'registration_number', 'account_holder_name', 'statement_period', 'material_amount', 'document_date', 'other');--> statement-breakpoint
CREATE TYPE "public"."integrity_consistency_kind" AS ENUM('match', 'mismatch');--> statement-breakpoint
CREATE TYPE "public"."integrity_consistency_status" AS ENUM('candidate', 'confirmed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."integrity_edit_signal" AS ENUM('detected', 'not_detected', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."integrity_run_feature" AS ENUM('document_analysis', 'document_triage');--> statement-breakpoint
CREATE TYPE "public"."integrity_run_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."generated_artifact_type" ADD VALUE 'document_integrity_brief';--> statement-breakpoint
CREATE TABLE "document_consistency_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"field" "integrity_consistency_field" NOT NULL,
	"proposed_kind" "integrity_consistency_kind" NOT NULL,
	"kind" "integrity_consistency_kind",
	"severity" "fraud_review_severity" NOT NULL,
	"comparison_basis" text NOT NULL,
	"left_document_file_id" uuid NOT NULL,
	"left_page_number" integer NOT NULL,
	"left_value" text NOT NULL,
	"left_label" text NOT NULL,
	"left_currency" text,
	"left_quote" text NOT NULL,
	"left_offset_start" integer NOT NULL,
	"left_offset_end" integer NOT NULL,
	"left_quote_hash" text NOT NULL,
	"right_document_file_id" uuid NOT NULL,
	"right_page_number" integer NOT NULL,
	"right_value" text NOT NULL,
	"right_label" text NOT NULL,
	"right_currency" text,
	"right_quote" text NOT NULL,
	"right_offset_start" integer NOT NULL,
	"right_offset_end" integer NOT NULL,
	"right_quote_hash" text NOT NULL,
	"explanation" text,
	"explanation_verified" boolean DEFAULT false NOT NULL,
	"status" "integrity_consistency_status" NOT NULL,
	"reason" text NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"redacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_consistency_candidates_offsets_chk" CHECK ("document_consistency_candidates"."left_page_number" >= 1 AND "document_consistency_candidates"."right_page_number" >= 1
				AND "document_consistency_candidates"."left_offset_start" >= 0 AND "document_consistency_candidates"."right_offset_start" >= 0
				AND "document_consistency_candidates"."left_offset_end" > "document_consistency_candidates"."left_offset_start"
				AND "document_consistency_candidates"."right_offset_end" > "document_consistency_candidates"."right_offset_start")
);
--> statement-breakpoint
CREATE TABLE "document_duplicate_explanations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sha256" text NOT NULL,
	"application_id" uuid NOT NULL,
	"note" text NOT NULL,
	"explained_by" uuid NOT NULL,
	"retention_until" timestamp with time zone NOT NULL,
	"redacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_field_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"document_file_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"field" "integrity_candidate_field" NOT NULL,
	"value" text NOT NULL,
	"normalized_value" text NOT NULL,
	"page_number" integer NOT NULL,
	"offset_start" integer NOT NULL,
	"offset_end" integer NOT NULL,
	"quote" text NOT NULL,
	"quote_hash" text NOT NULL,
	"confidence" real NOT NULL,
	"status" "integrity_candidate_status" NOT NULL,
	"validation_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"redacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_field_candidates_offsets_chk" CHECK ("document_field_candidates"."page_number" >= 1 AND "document_field_candidates"."offset_start" >= 0 AND "document_field_candidates"."offset_end" > "document_field_candidates"."offset_start"),
	CONSTRAINT "document_field_candidates_confidence_chk" CHECK ("document_field_candidates"."confidence" >= 0 AND "document_field_candidates"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "document_fingerprints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_file_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"fingerprint_version" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"mime_type" text NOT NULL,
	"page_count" integer DEFAULT 0 NOT NULL,
	"ocr_confidence" real,
	"producer" text DEFAULT 'unknown' NOT NULL,
	"creator" text DEFAULT 'unknown' NOT NULL,
	"metadata_created_at" timestamp with time zone,
	"metadata_modified_at" timestamp with time zone,
	"metadata_source" text DEFAULT 'unknown' NOT NULL,
	"edit_signal" "integrity_edit_signal" DEFAULT 'unknown' NOT NULL,
	"edit_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"redacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_integrity_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"feature" "integrity_run_feature" NOT NULL,
	"status" "integrity_run_status" DEFAULT 'queued' NOT NULL,
	"input_hash" text NOT NULL,
	"document_sha256" jsonb NOT NULL,
	"fingerprint_version" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"agent_version" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 2 NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"review_version" integer,
	"steps" integer,
	"tool_calls" jsonb,
	"source_refs" jsonb,
	"repair_attempted" boolean DEFAULT false NOT NULL,
	"repair_succeeded" boolean DEFAULT false NOT NULL,
	"usage" jsonb,
	"error_code" text,
	"error_detail" text,
	"requested_by" uuid,
	"fraud_review_id" uuid,
	"artifact_id" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fraud_reviewer_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fraud_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"review_type" text DEFAULT 'document_integrity' NOT NULL,
	"status" "fraud_review_status" DEFAULT 'open' NOT NULL,
	"reason_code" text NOT NULL,
	"severity" "fraud_review_severity" NOT NULL,
	"note" text,
	"assignee_user_id" uuid,
	"signal_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"document_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_hash" text NOT NULL,
	"brief_artifact_id" uuid,
	"brief_stale_at" timestamp with time zone,
	"agent_run_id" uuid,
	"model" text,
	"prompt_version" text,
	"agent_version" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"retention_until" timestamp with time zone NOT NULL,
	"redacted_at" timestamp with time zone,
	CONSTRAINT "fraud_reviews_version_chk" CHECK ("fraud_reviews"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "document_consistency_candidates" ADD CONSTRAINT "document_consistency_candidates_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_consistency_candidates" ADD CONSTRAINT "document_consistency_candidates_left_document_file_id_document_files_id_fk" FOREIGN KEY ("left_document_file_id") REFERENCES "public"."document_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_consistency_candidates" ADD CONSTRAINT "document_consistency_candidates_right_document_file_id_document_files_id_fk" FOREIGN KEY ("right_document_file_id") REFERENCES "public"."document_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_duplicate_explanations" ADD CONSTRAINT "document_duplicate_explanations_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_field_candidates" ADD CONSTRAINT "document_field_candidates_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_field_candidates" ADD CONSTRAINT "document_field_candidates_document_file_id_document_files_id_fk" FOREIGN KEY ("document_file_id") REFERENCES "public"."document_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_fingerprints" ADD CONSTRAINT "document_fingerprints_document_file_id_document_files_id_fk" FOREIGN KEY ("document_file_id") REFERENCES "public"."document_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_fingerprints" ADD CONSTRAINT "document_fingerprints_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_integrity_runs" ADD CONSTRAINT "document_integrity_runs_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_integrity_runs" ADD CONSTRAINT "document_integrity_runs_artifact_id_generated_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."generated_artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fraud_reviews" ADD CONSTRAINT "fraud_reviews_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fraud_reviews" ADD CONSTRAINT "fraud_reviews_brief_artifact_id_generated_artifacts_id_fk" FOREIGN KEY ("brief_artifact_id") REFERENCES "public"."generated_artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fraud_reviews" ADD CONSTRAINT "fraud_reviews_agent_run_id_document_integrity_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."document_integrity_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_consistency_candidates_application_id_idx" ON "document_consistency_candidates" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "document_consistency_candidates_run_id_idx" ON "document_consistency_candidates" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_duplicate_explanations_scope_uniq" ON "document_duplicate_explanations" USING btree ("sha256","application_id");--> statement-breakpoint
CREATE INDEX "document_duplicate_explanations_sha_idx" ON "document_duplicate_explanations" USING btree ("sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "document_field_candidates_evidence_uniq" ON "document_field_candidates" USING btree ("run_id","document_file_id","field","page_number","offset_start","offset_end");--> statement-breakpoint
CREATE INDEX "document_field_candidates_application_id_idx" ON "document_field_candidates" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "document_field_candidates_run_id_idx" ON "document_field_candidates" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_fingerprints_file_uniq" ON "document_fingerprints" USING btree ("document_file_id");--> statement-breakpoint
CREATE INDEX "document_fingerprints_application_id_idx" ON "document_fingerprints" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_integrity_runs_active_uniq" ON "document_integrity_runs" USING btree ("application_id","feature","input_hash") WHERE "document_integrity_runs"."status" IN ('queued','running','succeeded');--> statement-breakpoint
CREATE INDEX "document_integrity_runs_case_feature_created_idx" ON "document_integrity_runs" USING btree ("application_id","feature","created_at");--> statement-breakpoint
CREATE INDEX "document_integrity_runs_status_lease_idx" ON "document_integrity_runs" USING btree ("status","lease_expires_at") WHERE "document_integrity_runs"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "fraud_reviewer_grants_active_uniq" ON "fraud_reviewer_grants" USING btree ("user_id") WHERE "fraud_reviewer_grants"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "fraud_reviews_active_uniq" ON "fraud_reviews" USING btree ("application_id","review_type") WHERE "fraud_reviews"."status" IN ('open','needs_info');--> statement-breakpoint
CREATE INDEX "fraud_reviews_status_created_idx" ON "fraud_reviews" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "fraud_reviews_application_id_idx" ON "fraud_reviews" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "document_files_sha256_ready_idx" ON "document_files" USING btree ("sha256") WHERE "document_files"."status" = 'ready';--> statement-breakpoint
ALTER TABLE "document_field_candidates" ADD CONSTRAINT "document_field_candidates_run_id_document_integrity_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."document_integrity_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_consistency_candidates" ADD CONSTRAINT "document_consistency_candidates_run_id_document_integrity_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."document_integrity_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- EN-04 backfill: existing ready documents get a metadata-unknown fingerprint.
-- Never inferred: producer/creator/dates stay 'unknown'/null until re-read.
INSERT INTO "document_fingerprints" (
	"document_file_id", "application_id", "fingerprint_version", "sha256",
	"size_bytes", "mime_type", "page_count", "ocr_confidence",
	"producer", "creator", "metadata_source", "edit_signal", "edit_codes"
)
SELECT
	f."id", f."application_id", 'document-fingerprint-v1', f."sha256",
	f."size_bytes", f."mime_type", f."page_count", f."ocr_confidence",
	'unknown', 'unknown', 'unknown', 'unknown', '[]'::jsonb
FROM "document_files" f
WHERE f."status" = 'ready'
ON CONFLICT ("document_file_id") DO NOTHING;