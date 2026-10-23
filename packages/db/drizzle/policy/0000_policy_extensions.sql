-- Policy extensions: pgvector for chunk embeddings, btree_gist for the
-- policy_versions approved-range exclusion constraint. Runs before any
-- policy table exists (CREATE EXTENSION is idempotent on re-provision).
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;
