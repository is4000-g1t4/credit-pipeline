// @credit/db/portfolio — portfolio service only (credit_portfolio): the
// Kafka read model (activity_feed + processed_events) and dead letters.
// application_id/loan_id are opaque strings here — never FKs (the owning
// databases live elsewhere).
import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAtColumn } from "./shared.js";
// Client utilities re-exported so service code imports one subpath.
export { createDb, withTx, type Db, type Tx } from "./client.js";

export const processedEvents = pgTable("processed_events", {
	eventId: text("event_id").primaryKey(),
	topic: text("topic").notNull(),
	createdAt: createdAtColumn(),
});

export const activityFeed = pgTable(
	"activity_feed",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		eventId: text("event_id").notNull().unique(),
		applicationId: uuid("application_id"),
		loanId: uuid("loan_id"),
		type: text("type").notNull(),
		message: text("message").notNull(),
		payload: jsonb("payload").notNull(),
		occurredAt: timestamp("occurred_at", {
			withTimezone: true,
			mode: "date",
		})
			.defaultNow()
			.notNull(),
		createdAt: createdAtColumn(),
	},
	(t) => [index("activity_feed_application_id_idx").on(t.applicationId)],
);

export const deadLetterEvents = pgTable(
	"dead_letter_events",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		eventId: text("event_id"),
		topic: text("topic").notNull(),
		payload: jsonb("payload").notNull(),
		error: text("error").notNull(),
		createdAt: createdAtColumn(),
	},
	(t) => [
		// Invalid JSON has no event id; `raw` is its identity. A concurrent
		// rebalance or producer retry must not amplify the same poison row.
		uniqueIndex("dead_letter_events_raw_uniq")
			.on(t.topic, sql`md5(${t.payload}->>'raw')`)
			.where(sql`${t.eventId} IS NULL`),
	],
);
