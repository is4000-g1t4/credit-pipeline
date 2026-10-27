// pnpm demo:seed — idempotent, non-destructive fixture load (SPEC-t17-t18
// §2.5). Guarded by DEMO_MODE/non-production plus manifest version/hash;
// upserts users/customers/accounts/transactions/evidence with deterministic
// fixture keys; never overwrites applicant rows or fixture drafts.
import { assertDemoMutable } from "@credit/service-kit";
import { createDb } from "@credit/db/applications";
import { assertManifest, loadVerifiedManifest } from "./lib/manifest.js";
import { cliCustomerConfig, cliFlags, dbUserDirectory, requireEnv } from "./lib/env.js";
import { seedDemo } from "./lib/seed.js";

const flags = cliFlags();
assertDemoMutable(flags);

const manifest = loadVerifiedManifest(flags.demoSeedVersion);
const { hash } = assertManifest(manifest);

const auth = createDb(requireEnv("AUTH_DATABASE_URL"));
const { db: appDb, sql } = createDb(requireEnv("APPLICATIONS_DATABASE_URL"));
try {
	const counts = await seedDemo(manifest, {
		appDb,
		users: dbUserDirectory(auth.db),
		customerConfig: cliCustomerConfig(),
	});
	console.log(
		`demo:seed: manifest v${manifest.version} ${hash.slice(0, 12)} asOf ${manifest.demoAsOf} ` +
			`users=${counts.users} profiles=${counts.profilesUpserted} accounts=${counts.accountsUpserted} ` +
			`transactions=${counts.transactionsUpserted} evidence+=${counts.evidenceCreated} evidence-ok=${counts.evidenceSkipped}`,
	);
} finally {
	await auth.sql.end();
	await sql.end();
}
