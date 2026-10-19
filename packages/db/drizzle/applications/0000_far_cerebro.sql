CREATE TYPE "public"."application_product" AS ENUM('personal_loan', 'sme_term_loan');--> statement-breakpoint
CREATE TYPE "public"."application_status" AS ENUM('submitted', 'processing', 'pending_review', 'booked', 'declined', 'expired', 'failed');--> statement-breakpoint
CREATE TYPE "public"."application_type" AS ENUM('individual', 'sme');--> statement-breakpoint
CREATE TYPE "public"."decided_by" AS ENUM('system', 'officer');--> statement-breakpoint
CREATE TYPE "public"."decision_outcome" AS ENUM('approved', 'declined');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('required', 'verified');--> statement-breakpoint
CREATE TYPE "public"."kyc_check_status" AS ENUM('passed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."report_kind" AS ENUM('bureau', 'bank');--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"applicant_user_id" uuid NOT NULL,
	"type" "application_type" NOT NULL,
	"product" "application_product" NOT NULL,
	"status" "application_status" DEFAULT 'submitted' NOT NULL,
	"amount_cents" bigint NOT NULL,
	"term_months" integer NOT NULL,
	"purpose" text NOT NULL,
	"identity" jsonb NOT NULL,
	"financial" jsonb,
	"business" jsonb,
	"consents" jsonb NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"workflow_started_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"failed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applications_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid,
	"loan_id" uuid,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"outcome" "decision_outcome" NOT NULL,
	"decided_by" "decided_by" NOT NULL,
	"officer_user_id" uuid,
	"request_id" text,
	"approved_amount_cents" bigint,
	"term_months" integer,
	"rate_bps" integer,
	"reasons" jsonb NOT NULL,
	"notes" text,
	"snapshot" jsonb NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decisions_application_id_unique" UNIQUE("application_id"),
	CONSTRAINT "decisions_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" "document_status" DEFAULT 'required' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"kind" "report_kind" NOT NULL,
	"version" text NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"application_id" uuid,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
CREATE TABLE "kyc_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" "kyc_check_status" NOT NULL,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"topic" text NOT NULL,
	"key" text,
	"payload" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"published_at" timestamp with time zone,
	"dead_lettered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_events_seq_unique" UNIQUE("seq"),
	CONSTRAINT "outbox_events_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "policy_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"policy_version" text NOT NULL,
	"outcome" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"max_amount_cents" bigint NOT NULL,
	"inputs" jsonb NOT NULL,
	"input_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"model_version" text NOT NULL,
	"score" integer NOT NULL,
	"grade" text NOT NULL,
	"components" jsonb,
	"factors" jsonb NOT NULL,
	"affordability" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_reports" ADD CONSTRAINT "external_reports_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_checks" ADD CONSTRAINT "kyc_checks_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_evaluations" ADD CONSTRAINT "policy_evaluations_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "applications_status_idx" ON "applications" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_application_id_kind_uniq" ON "documents" USING btree ("application_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "external_reports_application_provider_kind_uniq" ON "external_reports" USING btree ("application_id","provider","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "kyc_checks_application_id_type_uniq" ON "kyc_checks" USING btree ("application_id","type");--> statement-breakpoint
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events" USING btree ("seq") WHERE "outbox_events"."published_at" IS NULL AND "outbox_events"."dead_lettered_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "policy_evaluations_application_id_policy_version_uniq" ON "policy_evaluations" USING btree ("application_id","policy_version");--> statement-breakpoint
CREATE UNIQUE INDEX "scores_application_id_model_version_uniq" ON "scores" USING btree ("application_id","model_version");