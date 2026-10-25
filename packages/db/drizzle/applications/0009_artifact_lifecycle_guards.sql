CREATE OR REPLACE FUNCTION "public"."generated_artifacts_guard"() RETURNS trigger AS $$
BEGIN
	IF OLD.status = 'deleted' THEN
		RAISE EXCEPTION 'generated_artifact_deleted_immutable';
	END IF;
	IF NEW.status <> OLD.status AND NOT (
		(OLD.status = 'draft' AND NEW.status IN ('approved', 'deleted')) OR
		(OLD.status = 'approved' AND NEW.status IN ('superseded', 'deleted')) OR
		(OLD.status = 'superseded' AND NEW.status = 'deleted')
	) THEN
		RAISE EXCEPTION 'generated_artifact_invalid_status_transition';
	END IF;
	IF NEW.status = 'deleted' THEN
		IF NEW.application_id IS DISTINCT FROM OLD.application_id OR
			NEW.type IS DISTINCT FROM OLD.type OR
			NEW.version IS DISTINCT FROM OLD.version OR
			NEW.revision IS DISTINCT FROM OLD.revision OR
			NEW.created_by IS DISTINCT FROM OLD.created_by OR
			NEW.created_at IS DISTINCT FROM OLD.created_at
		THEN
			RAISE EXCEPTION 'generated_artifact_delete_identity_change';
		END IF;
		IF NEW.content <> '{}'::jsonb OR NEW.citations <> '[]'::jsonb THEN
			RAISE EXCEPTION 'generated_artifact_delete_must_purge';
		END IF;
		IF EXISTS (
			SELECT 1 FROM generated_artifact_holds
			WHERE artifact_id = OLD.id AND released_at IS NULL
		) OR EXISTS (
			SELECT 1 FROM document_legal_holds
			WHERE application_id = OLD.application_id
				AND document_file_id IS NULL
				AND released_at IS NULL
		) THEN
			RAISE EXCEPTION 'generated_artifact_legal_hold';
		END IF;
	END IF;
	IF OLD.status IN ('approved', 'superseded') AND (
		NEW.approved_by IS DISTINCT FROM OLD.approved_by OR
		NEW.approved_at IS DISTINCT FROM OLD.approved_at
	) THEN
		RAISE EXCEPTION 'generated_artifact_approver_immutable';
	END IF;
	-- Retention/delete tombstones may purge content; every other update of a
	-- frozen row is rejected.
	IF OLD.status IN ('approved', 'superseded') AND NEW.status <> 'deleted' AND (
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
CREATE OR REPLACE FUNCTION "public"."generated_artifacts_insert_guard"() RETURNS trigger AS $$
BEGIN
	IF NEW.status <> 'draft' THEN
		RAISE EXCEPTION 'generated_artifact_insert_must_be_draft';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "generated_artifacts_insert_guard" BEFORE INSERT ON "generated_artifacts"
FOR EACH ROW EXECUTE FUNCTION "public"."generated_artifacts_insert_guard"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."generated_artifacts_delete_guard"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'generated_artifact_hard_delete_forbidden';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "generated_artifacts_delete_guard" BEFORE DELETE ON "generated_artifacts"
FOR EACH ROW EXECUTE FUNCTION "public"."generated_artifacts_delete_guard"();--> statement-breakpoint
