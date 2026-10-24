// @credit/db — connection factory. Takes the database URL; env loading is
// the caller's job (root .env via migrate/seed, apps via index). Db/Tx stay
// schema-agnostic (`any`) so the shared outbox/audit writers work unchanged
// against every service DB.
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

export type Db = PostgresJsDatabase<any>;

export function createDb(url: string): { db: Db; sql: Sql } {
	// postgres-js maps int8 to BigInt; drizzle bigint mode "number" converts
	// back via Number() on read and String() on write, so cents stay exact
	// (≤ 9e15 per SPEC FR-10.7, well under Number.MAX_SAFE_INTEGER).
	const sql = postgres(url, { max: 10 });
	const db: Db = drizzle(sql);
	return { db, sql };
}

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// Thin alias so call sites read `withTx(db, (tx) => ...)` instead of
// reaching for driver specifics.
export function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
	return db.transaction(fn);
}
