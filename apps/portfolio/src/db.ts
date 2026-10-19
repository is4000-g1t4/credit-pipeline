// Lazy singleton DB handle (same shape as the monolith's db.ts).
import { createDb } from "@credit/db";

let cached: ReturnType<typeof createDb> | null = null;

export function getDb(): ReturnType<typeof createDb> {
	if (!cached) {
		const url = process.env.PORTFOLIO_DATABASE_URL;
		if (!url) throw new Error("portfolio db: PORTFOLIO_DATABASE_URL is not set (root .env?)");
		cached = createDb(url);
	}
	return cached;
}

export async function closeDb(): Promise<void> {
	if (cached) {
		await cached.sql.end();
		cached = null;
	}
}
