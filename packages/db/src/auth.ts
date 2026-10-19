// @credit/db/auth — gateway only: users (SPEC Wave P2: credit_auth).
import { pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const createdAt = () =>
	timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull();

// ponytail: updated_at is client-set ($onUpdate) rather than a DB trigger;
// single-node demo scale, no concurrent-writer clock skew to worry about.
const updatedAt = () =>
	timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull();

export const userRole = pgEnum("user_role", ["applicant", "officer"]);
// Client utilities re-exported so service code imports one subpath.
export { createDb, withTx, type Db, type Tx } from "./client.js";

export const users = pgTable("users", {
	id: uuid("id").defaultRandom().primaryKey(),
	email: text("email").notNull().unique(),
	passwordHash: text("password_hash").notNull(),
	fullName: text("full_name").notNull(),
	role: userRole("role").notNull(),
	createdAt: createdAt(),
	updatedAt: updatedAt(),
});
