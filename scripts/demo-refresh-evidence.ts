// pnpm demo:refresh-evidence --persona <key> — adds the persona's fresh
// customer evidence only (SPEC-t17-t18 §2.5). Never attaches to the
// application: the checklist stays blocked until explicit applicant reuse.
import { assertDemoMutable } from "@credit/core";
import { createDb } from "@credit/db/applications";
import { assertFixtureClock, assertManifest, loadManifest } from "./lib/manifest.js";
import { cliCustomerConfig, cliFlags, dbUserDirectory, requireEnv } from "./lib/env.js";
import { refreshDemoEvidence } from "./lib/refresh.js";

const persona = process.argv.find((a) => a.startsWith("--persona="))?.slice("--persona=".length);
if (!persona) throw new Error("usage: bun scripts/demo-refresh-evidence.ts --persona=<key>");

const flags = cliFlags();
assertDemoMutable(flags);
const manifest = loadManifest();
assertFixtureClock(manifest.demoAsOf, process.env.DEMO_AS_OF);
assertManifest(manifest);

const auth = createDb(requireEnv("AUTH_DATABASE_URL"));
const { db: appDb, sql } = createDb(requireEnv("APPLICATIONS_DATABASE_URL"));
try {
	const outcome = await refreshDemoEvidence(manifest, persona, {
		appDb,
		users: dbUserDirectory(auth.db),
		customerConfig: cliCustomerConfig(),
	});
	console.log(
		`demo:refresh-evidence: persona=${persona} created=[${outcome.created.join(",")}] skipped=[${outcome.skipped.join(",")}] (customer only — checklist still blocked until reuse)`,
	);
} finally {
	await auth.sql.end();
	await sql.end();
}
