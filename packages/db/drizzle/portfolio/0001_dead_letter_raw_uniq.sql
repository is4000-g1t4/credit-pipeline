-- Invalid-JSON dead letters have no event id; the raw payload is their
-- identity. Deduplicate concurrent redelivery/rebalance at the DB so the
-- at-least-once consumer cannot amplify the same poison row.
DELETE FROM "dead_letter_events" a
USING "dead_letter_events" b
WHERE a."event_id" IS NULL
	AND b."event_id" IS NULL
	AND a."topic" = b."topic"
	AND md5(a."payload"->>'raw') = md5(b."payload"->>'raw')
	AND a."ctid" < b."ctid";--> statement-breakpoint
CREATE UNIQUE INDEX "dead_letter_events_raw_uniq" ON "dead_letter_events" USING btree ("topic", (md5(payload->>'raw'))) WHERE "dead_letter_events"."event_id" IS NULL;
