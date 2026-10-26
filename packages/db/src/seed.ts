// pnpm db:seed — idempotent seed of the 7 SPEC §1.3 users (password
// demo1234) into credit_auth. ON CONFLICT DO NOTHING: re-runs never touch
// existing rows, so a changed password is never overwritten.
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({
	path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

import { count } from "drizzle-orm";
import * as authSchema from "./auth.js";
import { createDb } from "./client.js";
import { hashPassword } from "./password.js";

const { users } = authSchema;

const SEED_USERS = [
	{ email: "maria@example.com", fullName: "Maria Demo", role: "applicant" },
	{ email: "alex@example.com", fullName: "Alex Demo", role: "applicant" },
	{ email: "sam@example.com", fullName: "Sam Demo", role: "applicant" },
	{
		email: "tomas@cafe-aurora.example",
		fullName: "Tomás (Café Aurora)",
		role: "applicant",
	},
	{
		email: "lena@bakery.example",
		fullName: "Lena (Bakery)",
		role: "applicant",
	},
	{ email: "officer@example.com", fullName: "Officer Demo", role: "officer" },
	{
		email: "senior.officer@example.com",
		fullName: "Senior Officer Demo",
		role: "officer",
	},
] as const;

const url = process.env.AUTH_DATABASE_URL;
if (!url) throw new Error("db:seed: AUTH_DATABASE_URL is not set (root .env?)");

const { db, sql } = createDb(url);
try {
	const inserted = await db
		.insert(users)
		.values(
			await Promise.all(
				SEED_USERS.map(async (u) => ({
					email: u.email,
					fullName: u.fullName,
					role: u.role,
					passwordHash: await hashPassword("demo1234"),
				})),
			),
		)
		.onConflictDoNothing({ target: users.email })
		.returning({ id: users.id });
	const [{ value: total }] = await db.select({ value: count() }).from(users);
	console.log(
		`db:seed: inserted ${inserted.length}, skipped ${SEED_USERS.length - inserted.length}, users total ${total}`,
	);
} finally {
	await sql.end();
}
