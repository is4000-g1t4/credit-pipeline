-- Drizzle cannot express these: the approved-range exclusion constraint
-- (SPEC §5.4 concurrency backstop) and the FTS GIN index. The partial
-- unique one-active-index constraint is already in 0001 (generated).
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_effective_no_overlap" EXCLUDE USING gist ("policy_id" WITH =, daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[]') WITH &&) WHERE (status = 'approved');--> statement-breakpoint
CREATE INDEX "policy_chunks_tsv_idx" ON "policy_chunks" USING gin ("tsv");
