// Lazy singleton DB handle (same shape as the monolith's db.ts).
import { createDb } from "@credit/db";
import { env } from "./env.js";

let cached: ReturnType<typeof createDb> | null = null;

export function getDb(): ReturnType<typeof createDb> {
	if (!cached) {
		cached = createDb(env.databaseUrl);
	}
	return cached;
}

export async function closeDb(): Promise<void> {
	if (cached) {
		await cached.sql.end({ timeout: 5 });
		cached = null;
	}
}
