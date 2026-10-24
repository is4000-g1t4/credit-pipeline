// pnpm db:init — creates the six service databases (plus the Temporal
// pair, belt-and-braces) if missing, so existing clusters/volumes
// self-provision without wiping data. Runs after db:wait, before migrate.
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({
	path: fileURLToPath(new URL("../../.env", import.meta.url)),
});

import postgres from "postgres";

const adminUrl =
	process.env.ADMIN_DATABASE_URL ?? "postgres://credit:credit@localhost:5432/postgres";

const DATABASES = [
	"credit_auth",
	"credit_applications",
	"credit_loans",
	"credit_portfolio",
	"credit_research",
	"credit_policy",
	"temporal",
	"temporal_visibility",
];

const admin = postgres(adminUrl, { max: 1 });
try {
	for (const name of DATABASES) {
		const rows = (await admin`SELECT 1 AS ok FROM pg_database WHERE datname = ${name}`) as Array<{
			ok: number;
		}>;
		if (rows[0]) {
			console.log(`db:init: ${name} exists`);
			continue;
		}
		// Names are fixed constants above — safe to interpolate quoted.
		await admin.unsafe(`CREATE DATABASE "${name}"`);
		console.log(`db:init: created ${name}`);
	}
} finally {
	await admin.end();
}
