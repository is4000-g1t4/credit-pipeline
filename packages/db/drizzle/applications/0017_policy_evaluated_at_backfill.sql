-- Backfill the policy evaluation timestamp for rows created before the
-- column existed. New/upserted rows set evaluated_at in the worker.
UPDATE "policy_evaluations"
SET "evaluated_at" = "created_at"
WHERE "evaluated_at" IS NULL;
