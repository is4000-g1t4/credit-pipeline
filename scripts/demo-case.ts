// pnpm demo:case --persona <key> — deterministic fixture draft (SPEC-t17-t18
// §2.5). Same guards as seed; creates the draft through the D1 invariants
// (locks, caps, confirmations, audits) with no workflow/outbox, attaches
// initial fresh evidence via the real reuse path, and seeds stale app
// copies for BreadTalk so the checklist blocks. Never touches a touched draft.
import { assertDemoMutable } from "@credit/core";
import { createDb } from "@credit/db/applications";
import { assertFixtureClock, assertManifest, loadManifest } from "./lib/manifest.js";
import {
	cliAppDocConfig,
	cliCustomerConfig,
	cliFlags,
	dbUserDirectory,
	requireEnv,
} from "./lib/env.js";
import { ensureDemoCase } from "./lib/case.js";

const persona = process.argv.find((a) => a.startsWith("--persona="))?.slice("--persona=".length);
if (!persona) throw new Error("usage: bun scripts/demo-case.ts --persona=<key>");

const flags = cliFlags();
assertDemoMutable(flags);
const manifest = loadManifest();
assertFixtureClock(manifest.demoAsOf, process.env.DEMO_AS_OF);
assertManifest(manifest);

const auth = createDb(requireEnv("AUTH_DATABASE_URL"));
const { db: appDb, sql } = createDb(requireEnv("APPLICATIONS_DATABASE_URL"));
try {
	const outcome = await ensureDemoCase(manifest, persona, {
		appDb,
		users: dbUserDirectory(auth.db),
		customerConfig: cliCustomerConfig(),
		appDocConfig: cliAppDocConfig(),
		confirmationKey: requireEnv("INTERNAL_SECRET"),
		demoMode: flags.demoMode,
	});
	console.log(
		`demo:case: persona=${persona} draft=${outcome.draftId} ref=${outcome.reference} ` +
			`created=${outcome.created} attached=${outcome.attached.length} stale=${outcome.staleCopies.length}`,
	);
} finally {
	await auth.sql.end();
	await sql.end();
}
