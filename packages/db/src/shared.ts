// @credit/db/shared — the outbox/audit shape every writer DB carries.
// credit_applications and credit_loans each own a physical copy (same DDL,
// applied by their own migration); one table object serves both because the
// client types are schema-agnostic. Columns reference sibling-domain ids as
// plain uuids — never cross-database foreign keys.
import { sql } from "drizzle-orm";
import {
	bigint,
	bigserial,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
// Client utilities re-exported so service code imports one subpath.
export { createDb, withTx, type Db, type Tx } from "./client.js";

export const createdAtColumn = () =>
	timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull();

export const updatedAtColumn = () =>
	timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull();

/** Integer cents — every money column in the repo uses this scale. */
export const moneyColumn = (name: string) => bigint(name, { mode: "number" }).notNull();
export const moneyNullableColumn = (name: string) => bigint(name, { mode: "number" });

export const auditLog = pgTable("audit_log", {
	id: uuid("id").defaultRandom().primaryKey(),
	applicationId: uuid("application_id"),
	loanId: uuid("loan_id"),
	actor: text("actor").notNull(),
	action: text("action").notNull(),
	entity: text("entity").notNull(),
	payload: jsonb("payload").notNull(),
	createdAt: createdAtColumn(),
});

export const outboxEvents = pgTable(
	"outbox_events",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		seq: bigserial("seq", { mode: "number" }).notNull().unique(),
		topic: text("topic").notNull(),
		key: text("key"),
		payload: jsonb("payload").notNull(),
		dedupeKey: text("dedupe_key").notNull().unique(),
		attempts: integer("attempts").notNull().default(0),
		lastError: text("last_error"),
		publishedAt: timestamp("published_at", {
			withTimezone: true,
			mode: "date",
		}),
		deadLetteredAt: timestamp("dead_lettered_at", {
			withTimezone: true,
			mode: "date",
		}),
		createdAt: createdAtColumn(),
		updatedAt: updatedAtColumn(),
	},
	(t) => [
		index("outbox_events_unpublished_idx")
			.on(t.seq)
			.where(sql`${t.publishedAt} IS NULL AND ${t.deadLetteredAt} IS NULL`),
	],
);
