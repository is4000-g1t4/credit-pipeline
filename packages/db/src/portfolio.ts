// @credit/db/portfolio — portfolio service only (credit_portfolio): the
// Kafka read model (activity_feed + processed_events) and dead letters.
// application_id/loan_id are opaque strings here — never FKs (the owning
// databases live elsewhere).
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
// Client utilities re-exported so service code imports one subpath.
export { createDb, withTx, type Db, type Tx } from "./client.js";

const createdAt = () =>
	timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull();

export const processedEvents = pgTable("processed_events", {
	eventId: text("event_id").primaryKey(),
	topic: text("topic").notNull(),
	createdAt: createdAt(),
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
		createdAt: createdAt(),
	},
	(t) => [index("activity_feed_application_id_idx").on(t.applicationId)],
);

export const deadLetterEvents = pgTable("dead_letter_events", {
	id: uuid("id").defaultRandom().primaryKey(),
	eventId: text("event_id"),
	topic: text("topic").notNull(),
	payload: jsonb("payload").notNull(),
	error: text("error").notNull(),
	createdAt: createdAt(),
});
