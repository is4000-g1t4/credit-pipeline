-- credit_loans mirrors credit_applications' append-only audit guarantee.
-- shared.ts declares one DDL contract for both writer DBs; without this
-- trigger the loans audit_log (written by loans + the worker booking saga)
-- was mutable.
CREATE OR REPLACE FUNCTION "public"."reject_audit_log_mutation"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "audit_log_no_update_delete" BEFORE UPDATE OR DELETE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION "public"."reject_audit_log_mutation"();
