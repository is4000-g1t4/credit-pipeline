CREATE TYPE "public"."generated_artifact_status" AS ENUM('draft', 'approved', 'superseded', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."generated_artifact_type" AS ENUM('credit_memo', 'policy_exception_memo', 'adverse_action_letter');--> statement-breakpoint
CREATE TABLE "generated_artifact_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "generated_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"type" "generated_artifact_type" NOT NULL,
	"version" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" "generated_artifact_status" DEFAULT 'draft' NOT NULL,
	"content" jsonb NOT NULL,
	"citations" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"created_by" uuid NOT NULL,
	"approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"retention_until" timestamp with time zone NOT NULL,
	CONSTRAINT "generated_artifacts_version_revision_chk" CHECK ("generated_artifacts"."version" > 0 AND "generated_artifacts"."revision" > 0),
	CONSTRAINT "generated_artifacts_approved_actor_chk" CHECK ("generated_artifacts"."status" <> 'approved' OR "generated_artifacts"."approved_by" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "generated_artifact_holds" ADD CONSTRAINT "generated_artifact_holds_artifact_id_generated_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."generated_artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_artifact_holds" ADD CONSTRAINT "generated_artifact_holds_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_artifacts" ADD CONSTRAINT "generated_artifacts_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "generated_artifact_holds_artifact_idx" ON "generated_artifact_holds" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "generated_artifact_holds_active_idx" ON "generated_artifact_holds" USING btree ("artifact_id") WHERE "generated_artifact_holds"."released_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "generated_artifacts_case_type_version_uniq" ON "generated_artifacts" USING btree ("application_id","type","version");--> statement-breakpoint
CREATE UNIQUE INDEX "generated_artifacts_active_draft_uniq" ON "generated_artifacts" USING btree ("application_id","type") WHERE "generated_artifacts"."status" = 'draft';--> statement-breakpoint
CREATE INDEX "generated_artifacts_case_type_created_idx" ON "generated_artifacts" USING btree ("application_id","type","created_at");--> statement-breakpoint
CREATE INDEX "generated_artifacts_retention_idx" ON "generated_artifacts" USING btree ("retention_until") WHERE "generated_artifacts"."status" <> 'deleted';--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."generated_artifacts_guard"() RETURNS trigger AS $$
BEGIN
	IF OLD.status = 'deleted' THEN
		RAISE EXCEPTION 'generated_artifact_deleted_immutable';
	END IF;
	IF NEW.status <> OLD.status AND NOT (
		(OLD.status = 'draft' AND NEW.status IN ('approved', 'deleted')) OR
		(OLD.status = 'approved' AND NEW.status IN ('superseded', 'deleted'))
	) THEN
		RAISE EXCEPTION 'generated_artifact_invalid_status_transition';
	END IF;
	IF OLD.status = 'approved' AND (
		NEW.application_id IS DISTINCT FROM OLD.application_id OR
		NEW.type IS DISTINCT FROM OLD.type OR
		NEW.version IS DISTINCT FROM OLD.version OR
		NEW.revision IS DISTINCT FROM OLD.revision OR
		NEW.content IS DISTINCT FROM OLD.content OR
		NEW.citations IS DISTINCT FROM OLD.citations OR
		NEW.content_hash IS DISTINCT FROM OLD.content_hash OR
		NEW.model IS DISTINCT FROM OLD.model OR
		NEW.prompt_version IS DISTINCT FROM OLD.prompt_version OR
		NEW.created_by IS DISTINCT FROM OLD.created_by OR
		NEW.created_at IS DISTINCT FROM OLD.created_at OR
		NEW.retention_until IS DISTINCT FROM OLD.retention_until
	) THEN
		RAISE EXCEPTION 'generated_artifact_approved_immutable';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "generated_artifacts_guard" BEFORE UPDATE ON "generated_artifacts"
FOR EACH ROW EXECUTE FUNCTION "public"."generated_artifacts_guard"();