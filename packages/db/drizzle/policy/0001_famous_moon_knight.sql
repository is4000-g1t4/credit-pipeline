CREATE TYPE "public"."approval_action" AS ENUM('draft_created', 'submitted', 'approved', 'retired', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."index_status" AS ENUM('building', 'active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."policy_acl_permission" AS ENUM('read', 'case_explain', 'admin');--> statement-breakpoint
CREATE TYPE "public"."policy_acl_principal" AS ENUM('role', 'user', 'service');--> statement-breakpoint
CREATE TYPE "public"."policy_budget_class" AS ENUM('navigator', 'case');--> statement-breakpoint
CREATE TYPE "public"."policy_created_via" AS ENUM('cli_editor', 'demo_seed', 'api');--> statement-breakpoint
CREATE TYPE "public"."policy_domain" AS ENUM('credit');--> statement-breakpoint
CREATE TYPE "public"."policy_family" AS ENUM('underwriting', 'affordability', 'documentation', 'exceptions', 'pricing', 'servicing');--> statement-breakpoint
CREATE TYPE "public"."policy_grant_via" AS ENUM('bootstrap', 'ops_cli');--> statement-breakpoint
CREATE TYPE "public"."policy_query_mode" AS ENUM('navigator', 'case_explain');--> statement-breakpoint
CREATE TYPE "public"."policy_query_status" AS ENUM('succeeded', 'no_match', 'needs_policy_owner', 'out_of_scope', 'identifier_blocked', 'rate_limited', 'budget_exceeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."policy_role" AS ENUM('policy_owner', 'compliance');--> statement-breakpoint
CREATE TYPE "public"."product_scope" AS ENUM('individual', 'sme', 'all');--> statement-breakpoint
CREATE TYPE "public"."version_status" AS ENUM('draft', 'approved', 'retired');--> statement-breakpoint
CREATE TABLE "policy_acl" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid NOT NULL,
	"principal_type" "policy_acl_principal" NOT NULL,
	"principal" text NOT NULL,
	"permission" "policy_acl_permission" NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "policy_acl_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid NOT NULL,
	"principal" text NOT NULL,
	"permission" "policy_acl_permission" NOT NULL,
	"action" text NOT NULL,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_actor_spend" (
	"day" date NOT NULL,
	"actor_id" uuid NOT NULL,
	"reserved_usd" numeric DEFAULT '0' NOT NULL,
	"spent_usd" numeric DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_actor_spend_day_actor_id_pk" PRIMARY KEY("day","actor_id")
);
--> statement-breakpoint
CREATE TABLE "policy_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"actor_id" uuid,
	"actor_principal" text NOT NULL,
	"actor_role" text NOT NULL,
	"action" "approval_action" NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_case_token_uses" (
	"jti" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"index_version" text NOT NULL,
	"version_id" uuid NOT NULL,
	"section_id" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"heading" text NOT NULL,
	"text" text NOT NULL,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"token_count" integer NOT NULL,
	"content_hash" text NOT NULL,
	"chunking_version" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"embedding_model" text NOT NULL,
	"embedding_dimensions" integer NOT NULL,
	"embedding_version" text NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', heading || ' ' || text)) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_daily_spend" (
	"day" date NOT NULL,
	"budget_class" "policy_budget_class" NOT NULL,
	"reserved_usd" numeric DEFAULT '0' NOT NULL,
	"spent_usd" numeric DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_daily_spend_day_budget_class_pk" PRIMARY KEY("day","budget_class")
);
--> statement-breakpoint
CREATE TABLE "policy_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_key" text NOT NULL,
	"title" text NOT NULL,
	"domain" "policy_domain" NOT NULL,
	"policy_family" "policy_family" NOT NULL,
	"product_scope" "product_scope" NOT NULL,
	"jurisdiction" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_documents_policy_key_unique" UNIQUE("policy_key")
);
--> statement-breakpoint
CREATE TABLE "policy_index_meta" (
	"index_version" text PRIMARY KEY NOT NULL,
	"embedding_model" text NOT NULL,
	"embedding_dimensions" integer NOT NULL,
	"chunking_version" text NOT NULL,
	"status" "index_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "policy_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL,
	"actor_role" text NOT NULL,
	"mode" "policy_query_mode" NOT NULL,
	"budget_class" "policy_budget_class" NOT NULL,
	"application_id" uuid,
	"run_id" uuid,
	"question_hmac" text,
	"domain" "policy_domain" NOT NULL,
	"as_of" date NOT NULL,
	"status" "policy_query_status" NOT NULL,
	"error_code" text,
	"retrieved_section_ids" jsonb,
	"usage_cost" numeric DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_query_citations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"query_id" uuid NOT NULL,
	"item_ref" text,
	"segment_index" integer NOT NULL,
	"policy_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"section_id" text NOT NULL,
	"quote" text NOT NULL,
	"quote_start" integer NOT NULL,
	"quote_end" integer NOT NULL,
	"content_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "policy_role" NOT NULL,
	"granted_by" uuid,
	"granted_via" "policy_grant_via" NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "policy_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"section_id" text NOT NULL,
	"parent_section_id" text,
	"heading" text NOT NULL,
	"body" text NOT NULL,
	"order_index" integer NOT NULL,
	"page_number" integer,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"content_hash" text NOT NULL,
	CONSTRAINT "policy_sections_section_id_chk" CHECK ("policy_sections"."section_id" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "policy_spend_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" date NOT NULL,
	"budget_class" "policy_budget_class" NOT NULL,
	"actor_id" uuid NOT NULL,
	"amount_usd" numeric NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "policy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid NOT NULL,
	"version" text NOT NULL,
	"status" "version_status" DEFAULT 'draft' NOT NULL,
	"effective_from" date,
	"effective_to" date,
	"created_by_principal" text NOT NULL,
	"created_by_user_id" uuid,
	"created_via" "policy_created_via" NOT NULL,
	"source_commit" text,
	"source_author" text,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"content_hash" text NOT NULL,
	"source_uri" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_versions_approved_needs_from_chk" CHECK ("policy_versions"."status" <> 'approved' OR "policy_versions"."effective_from" IS NOT NULL),
	CONSTRAINT "policy_versions_effective_range_chk" CHECK ("policy_versions"."effective_to" IS NULL OR "policy_versions"."effective_to" >= "policy_versions"."effective_from")
);
--> statement-breakpoint
ALTER TABLE "policy_acl" ADD CONSTRAINT "policy_acl_policy_id_policy_documents_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policy_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_acl_audit" ADD CONSTRAINT "policy_acl_audit_policy_id_policy_documents_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policy_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_approvals" ADD CONSTRAINT "policy_approvals_version_id_policy_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."policy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_chunks" ADD CONSTRAINT "policy_chunks_index_version_policy_index_meta_index_version_fk" FOREIGN KEY ("index_version") REFERENCES "public"."policy_index_meta"("index_version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_chunks" ADD CONSTRAINT "policy_chunks_version_id_policy_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."policy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_query_citations" ADD CONSTRAINT "policy_query_citations_query_id_policy_queries_id_fk" FOREIGN KEY ("query_id") REFERENCES "public"."policy_queries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_query_citations" ADD CONSTRAINT "policy_query_citations_policy_id_policy_documents_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policy_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_query_citations" ADD CONSTRAINT "policy_query_citations_version_id_policy_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."policy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_sections" ADD CONSTRAINT "policy_sections_version_id_policy_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."policy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_policy_id_policy_documents_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policy_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "policy_acl_active_policy_principal_permission_uniq" ON "policy_acl" USING btree ("policy_id","principal_type","principal","permission") WHERE "policy_acl"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "policy_acl_audit_policy_time_idx" ON "policy_acl_audit" USING btree ("policy_id","created_at");--> statement-breakpoint
CREATE INDEX "policy_approvals_version_time_idx" ON "policy_approvals" USING btree ("version_id","created_at");--> statement-breakpoint
CREATE INDEX "policy_case_token_uses_run_idx" ON "policy_case_token_uses" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_chunks_generation_section_chunk_uniq" ON "policy_chunks" USING btree ("index_version","version_id","section_id","chunk_index");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_index_meta_active_uniq" ON "policy_index_meta" USING btree ("status") WHERE "policy_index_meta"."status" = 'active';--> statement-breakpoint
CREATE INDEX "policy_queries_actor_created_idx" ON "policy_queries" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "policy_queries_status_created_idx" ON "policy_queries" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "policy_query_citations_query_idx" ON "policy_query_citations" USING btree ("query_id");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_roles_active_user_role_uniq" ON "policy_roles" USING btree ("user_id","role") WHERE "policy_roles"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "policy_sections_version_section_uniq" ON "policy_sections" USING btree ("version_id","section_id");--> statement-breakpoint
CREATE INDEX "policy_spend_reservations_day_class_idx" ON "policy_spend_reservations" USING btree ("day","budget_class") WHERE "policy_spend_reservations"."settled_at" IS NULL;--> statement-breakpoint
CREATE INDEX "policy_spend_reservations_day_actor_idx" ON "policy_spend_reservations" USING btree ("day","actor_id") WHERE "policy_spend_reservations"."settled_at" IS NULL;--> statement-breakpoint
CREATE INDEX "policy_spend_reservations_expiry_idx" ON "policy_spend_reservations" USING btree ("expires_at") WHERE "policy_spend_reservations"."settled_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "policy_versions_policy_version_uniq" ON "policy_versions" USING btree ("policy_id","version");