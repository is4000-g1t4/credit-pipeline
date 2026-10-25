CREATE OR REPLACE FUNCTION "public"."generated_artifacts_guard"() RETURNS trigger AS $$
BEGIN
	IF OLD.status = 'deleted' THEN
		RAISE EXCEPTION 'generated_artifact_deleted_immutable';
	END IF;
	IF NEW.status <> OLD.status AND NOT (
		(OLD.status = 'draft' AND NEW.status IN ('approved', 'superseded', 'deleted')) OR
		(OLD.status = 'approved' AND NEW.status IN ('superseded', 'deleted')) OR
		(OLD.status = 'superseded' AND NEW.status = 'deleted')
	) THEN
		RAISE EXCEPTION 'generated_artifact_invalid_status_transition';
	END IF;
	IF OLD.status = 'draft' AND NEW.status = 'approved' AND (
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
		NEW.retention_until IS DISTINCT FROM OLD.retention_until OR
		NEW.document_derived IS DISTINCT FROM OLD.document_derived
	) THEN
		RAISE EXCEPTION 'generated_artifact_approval_must_not_change_content';
	END IF;
	IF NEW.status = 'deleted' THEN
		IF NEW.application_id IS DISTINCT FROM OLD.application_id OR
			NEW.type IS DISTINCT FROM OLD.type OR
			NEW.version IS DISTINCT FROM OLD.version OR
			NEW.revision IS DISTINCT FROM OLD.revision OR
			NEW.created_by IS DISTINCT FROM OLD.created_by OR
			NEW.created_at IS DISTINCT FROM OLD.created_at OR
			NEW.document_derived IS DISTINCT FROM OLD.document_derived
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
	IF OLD.status IN ('approved', 'superseded') AND NEW.status <> 'deleted' AND (
		NEW.application_id IS DISTINCT FROM OLD.application_id OR
		NEW.type IS DISTINCT FROM OLD.type OR
		NEW.version IS DISTINCT FROM OLD.version OR
		NEW.revision IS DISTINCT FROM OLD.revision OR
		NEW.created_by IS DISTINCT FROM OLD.created_by OR
		NEW.created_at IS DISTINCT FROM OLD.created_at OR
		NEW.retention_until IS DISTINCT FROM OLD.retention_until OR
		NEW.document_derived IS DISTINCT FROM OLD.document_derived
	) THEN
		RAISE EXCEPTION 'generated_artifact_approved_immutable';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
