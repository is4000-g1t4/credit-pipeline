CREATE TYPE "public"."ews_status" AS ENUM('open', 'acknowledged', 'closed');--> statement-breakpoint
CREATE TYPE "public"."ews_type" AS ENUM('payment_overdue');--> statement-breakpoint
CREATE TYPE "public"."installment_status" AS ENUM('scheduled', 'paid', 'overdue');--> statement-breakpoint
CREATE TYPE "public"."loan_status" AS ENUM('active', 'overdue', 'closed');--> statement-breakpoint
CREATE TYPE "public"."payment_source" AS ENUM('operator', 'simulated');--> statement-breakpoint
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
CREATE TABLE "ews_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_id" uuid NOT NULL,
	"installment_id" uuid,
	"type" "ews_type" NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"status" "ews_status" DEFAULT 'open' NOT NULL,
	"details" jsonb,
	"acknowledged_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "installments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"due_date" date NOT NULL,
	"principal_cents" bigint NOT NULL,
	"interest_cents" bigint NOT NULL,
	"total_cents" bigint NOT NULL,
	"paid_cents" bigint DEFAULT 0 NOT NULL,
	"status" "installment_status" DEFAULT 'scheduled' NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"application_reference" text NOT NULL,
	"applicant_user_id" uuid NOT NULL,
	"product" text NOT NULL,
	"principal_cents" bigint NOT NULL,
	"term_months" integer NOT NULL,
	"rate_bps" integer NOT NULL,
	"monthly_payment_cents" bigint NOT NULL,
	"status" "loan_status" DEFAULT 'active' NOT NULL,
	"disbursed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outstanding_cents" bigint NOT NULL,
	"next_due_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loans_application_id_unique" UNIQUE("application_id")
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
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installment_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"paid_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" "payment_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_installment_id_unique" UNIQUE("installment_id")
);
--> statement-breakpoint
ALTER TABLE "ews_alerts" ADD CONSTRAINT "ews_alerts_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ews_alerts" ADD CONSTRAINT "ews_alerts_installment_id_installments_id_fk" FOREIGN KEY ("installment_id") REFERENCES "public"."installments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installments" ADD CONSTRAINT "installments_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_installment_id_installments_id_fk" FOREIGN KEY ("installment_id") REFERENCES "public"."installments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ews_alerts_installment_id_type_uniq" ON "ews_alerts" USING btree ("installment_id","type") WHERE "ews_alerts"."installment_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "installments_loan_id_number_uniq" ON "installments" USING btree ("loan_id","number");--> statement-breakpoint
CREATE INDEX "installments_status_due_date_idx" ON "installments" USING btree ("status","due_date");--> statement-breakpoint
CREATE INDEX "loans_status_idx" ON "loans" USING btree ("status");--> statement-breakpoint
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events" USING btree ("seq") WHERE "outbox_events"."published_at" IS NULL AND "outbox_events"."dead_lettered_at" IS NULL;