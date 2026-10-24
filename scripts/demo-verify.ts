// pnpm demo:verify --persona <key> --phase <phase> — read-only fixture
// verification (SPEC-t17-t18 §2.5): manifest hash, counts, encrypted
// blob decrypt + hash + page text, requirements outcomes, submit side
// effects, and T02/T11 expectations. Prints PASS/FAIL per check; exits
// non-zero on any failure. Never content/PII beyond ids and codes.
import { createDb } from "@credit/db/applications";
import { createDb as createResearchDb } from "@credit/db/research";
import { assertFixtureClock, assertManifest, loadManifest } from "./lib/manifest.js";
import { cliCustomerConfig, cliFlags, dbUserDirectory, requireEnv } from "./lib/env.js";
import { verifyDemo, type VerifyPhase } from "./lib/verify.js";

const persona =
	process.argv.find((a) => a.startsWith("--persona="))?.slice("--persona=".length) ?? "breadtalk";
const phase = (process.argv.find((a) => a.startsWith("--phase="))?.slice("--phase=".length) ??
	"pre-refresh") as VerifyPhase;
if (!["pre-refresh", "post-refresh", "post-attach", "post-submit"].includes(phase)) {
	throw new Error(
		"usage: bun scripts/demo-verify.ts --persona=<key> --phase=pre-refresh|post-refresh|post-attach|post-submit",
	);
}

const flags = cliFlags();
if (!flags.demoMode) throw new Error("refusing: DEMO_MODE is not true");
const manifest = loadManifest();
assertFixtureClock(manifest.demoAsOf, process.env.DEMO_AS_OF);
assertManifest(manifest);

const auth = createDb(requireEnv("AUTH_DATABASE_URL"));
const { db: appDb, sql } = createDb(requireEnv("APPLICATIONS_DATABASE_URL"));
const researchUrl = process.env.RESEARCH_DATABASE_URL;
const research = researchUrl ? createResearchDb(researchUrl) : null;
try {
	const { checks, failed } = await verifyDemo(manifest, persona, phase, {
		appDb,
		users: dbUserDirectory(auth.db),
		customerConfig: cliCustomerConfig(),
		researchDb: research?.db ?? null,
	});
	for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`);
	console.log(
		`demo:verify: persona=${persona} phase=${phase}: ${checks.length - failed}/${checks.length} checks passed`,
	);
	if (failed > 0) process.exit(1);
} finally {
	await auth.sql.end();
	await sql.end();
	if (research) await research.sql.end();
}
