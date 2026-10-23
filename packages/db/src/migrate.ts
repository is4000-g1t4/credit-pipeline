// pnpm db:migrate — applies each service's generated migrations to its own
// database; safe to re-run (drizzle tracks applied migrations per DB in
// __drizzle_migrations).
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({
	path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const TARGETS = [
	{ name: "auth", env: "AUTH_DATABASE_URL", folder: "drizzle/auth" },
	{ name: "applications", env: "APPLICATIONS_DATABASE_URL", folder: "drizzle/applications" },
	{ name: "loans", env: "LOANS_DATABASE_URL", folder: "drizzle/loans" },
	{ name: "portfolio", env: "PORTFOLIO_DATABASE_URL", folder: "drizzle/portfolio" },
	{ name: "research", env: "RESEARCH_DATABASE_URL", folder: "drizzle/research" },
	{ name: "policy", env: "POLICY_DATABASE_URL", folder: "drizzle/policy" },
] as const;

for (const target of TARGETS) {
	const url = process.env[target.env];
	// Phase 1 checkout without research configured: the research database is
	// optional until Phase 2 is enabled (see docs/getting-started.md). Skip
	// it with a clear log; the other databases still fail fast.
	if (!url && target.name === "research") {
		console.log(
			`db:migrate: skipping research (${target.env} is not set) — set it to enable Phase 2 agentic research`,
		);
		continue;
	}
	if (!url) throw new Error(`db:migrate: ${target.env} is not set (root .env?)`);
	const sql = postgres(url, { max: 1 });
	try {
		await migrate(drizzle(sql), {
			migrationsFolder: fileURLToPath(new URL(`../${target.folder}`, import.meta.url)),
		});
		console.log(`db:migrate: ${target.name} done`);
	} finally {
		await sql.end();
	}
}
