// pnpm demo:context-stub --persona <key> [--app-id <uuid>] — deterministic
// context/E2E seam (SPEC-t17-t18 D4): inserts a clearly-labeled STUB
// succeeded run (external brief + context stage with the persona's expected
// signal types) for a submitted fixture case, so the officer UI and the
// signal-review endpoints can be exercised without model keys or spend.
//
// Every stub string says it is a stub; signal evidence references real
// fixture transaction ids. Reruns replace the previous stub for the same
// application (live runs are never touched). Guarded by DEMO_MODE and
// non-production, like seed/case. Reads still require the review-service
// research flags — when those are off, E2E keeps its explicit skip.
import { assertDemoMutable } from "@credit/service-kit";
import {
	applications,
	createDb,
	customerAccounts,
	customerProfiles,
	customerTransactions,
} from "@credit/db/applications";
import { agentRuns, contextSignals, createDb as createResearchDb } from "@credit/db/research";
import { and, asc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { loadVerifiedManifest, personaOf } from "./lib/manifest.js";
import { cliFlags, requireEnv } from "./lib/env.js";

export const STUB_MARKER = "demo-context-stub-v1";

const METRIC_FOR: Record<string, { metric: string; observed: number; expected: number }> = {
	negative_balance: { metric: "negative_eod_days", observed: 3, expected: 0 },
	revenue_concentration: { metric: "top_inflow_share", observed: 0.45, expected: 0.4 },
	round_trip: { metric: "round_trip_pairs", observed: 2, expected: 0 },
	cash_deposit_share: { metric: "cash_inflow_share", observed: 0.3, expected: 0.25 },
	declared_vs_observed_cashflow: { metric: "monthly_fcf_variance", observed: 0.4, expected: 0.3 },
	returned_payment: { metric: "returned_count", observed: 1, expected: 0 },
	insufficient_data: { metric: "usable_rows", observed: 0, expected: 1 },
};

const personaKey = process.argv.find((a) => a.startsWith("--persona="))?.slice("--persona=".length);
if (!personaKey)
	throw new Error("usage: bun scripts/demo-context-stub.ts --persona=<key> [--app-id=<uuid>]");
const appIdArg = process.argv.find((a) => a.startsWith("--app-id="))?.slice("--app-id=".length);

const flags = cliFlags();
assertDemoMutable(flags);
const manifest = loadVerifiedManifest();
const persona = personaOf(manifest, personaKey);

const { db: appDb, sql: appSql } = createDb(requireEnv("APPLICATIONS_DATABASE_URL"));
const research = createResearchDb(requireEnv("RESEARCH_DATABASE_URL"));
try {
	const app = appIdArg
		? (await appDb.select().from(applications).where(eq(applications.id, appIdArg)).limit(1))[0]
		: (
				await appDb
					.select()
					.from(applications)
					.where(eq(applications.fixtureKey, persona.case.fixtureKey))
					.limit(1)
			)[0];
	if (!app) throw new Error(`demo:context-stub: no case for ${personaKey} (run demo:case)`);
	if (app.status === "draft" || !app.submittedAt) {
		throw new Error("demo:context-stub: case is not submitted (run demo:submit)");
	}
	const asOf = app.submittedAt;

	const profile = (
		await appDb
			.select()
			.from(customerProfiles)
			.where(eq(customerProfiles.userId, app.applicantUserId))
			.limit(1)
	)[0];
	const accountRows = profile
		? await appDb
				.select({ id: customerAccounts.id })
				.from(customerAccounts)
				.where(eq(customerAccounts.customerId, profile.id))
				.orderBy(asc(customerAccounts.id))
		: [];
	const txRows =
		accountRows.length === 0
			? []
			: await appDb
					.select({ id: customerTransactions.id })
					.from(customerTransactions)
					.where(
						and(
							eq(customerTransactions.accountId, accountRows[0].id),
							sql`${customerTransactions.postedAt} <= ${asOf.toISOString()}::timestamptz`,
						),
					)
					.orderBy(asc(customerTransactions.postedAt), asc(customerTransactions.id))
					.limit(5);
	const evidenceIds = txRows.map((t) => t.id);
	const windowDays = 180;
	const periodStart = new Date(asOf.getTime() - windowDays * 86_400_000).toISOString().slice(0, 10);
	const periodEnd = asOf.toISOString().slice(0, 10);

	// Idempotent: drop this application's previous stub runs (live runs are
	// never stub-marked, so they survive). Signal/review rows cascade.
	await research.db.execute(
		sql`DELETE FROM agent_runs WHERE application_id = ${app.id} AND case_facts->>'stub' = ${STUB_MARKER}`,
	);

	const signals = [...persona.expectedSignals];
	// No fallback: candidates come from the manifest. A persona with no
	// expected signals records a succeeded stage with zero signals — never a
	// fabricated anomaly. `insufficient_data` mirrors the live candidate
	// exactly (status insufficient_data, low confidence, no evidence); every
	// other expected signal is a review candidate.
	const now = new Date();
	const [run] = await research.db
		.insert(agentRuns)
		.values({
			applicationId: app.id,
			feature: "case_brief",
			status: "succeeded",
			trigger: "officer",
			requestedBy: randomUUID(),
			requestedByRole: "officer",
			caseFacts: { applicationId: app.id, reference: app.reference, stub: STUB_MARKER },
			model: "stub",
			agentVersion: STUB_MARKER,
			promptVersion: "stub-v1",
			promptHash: "stub",
			asOf,
			grafanaConversationId: randomUUID(),
			observability: "degraded",
			brief: {
				summary: "Deterministic E2E stub brief — not model output.",
				contradictions: [],
				unknowns: [`Stub run for ${personaKey}; no public sources were read.`],
				questionsForOfficer: [],
			},
			validation: { validatorVersion: "stub-v1" },
			usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0, costUsd: 0 },
			startedAt: now,
			finishedAt: now,
			timeoutAt: now,
			contextStatus: "succeeded",
			contextBrief: {
				summary: `Deterministic E2E stub context for ${personaKey} — not model output.`,
				claims: signals.map((type, i) => ({
					text: `Stub claim ${i + 1}: the ${type} signal fired over the window (deterministic fixture, not model output).`,
					signalRefs: [i],
				})),
				dataGaps: ["Stub run: gaps are illustrative, not measured."],
				limitations: ["Stub run: illustrative only — a live T11 run replaces this."],
			},
			contextValidation: { validatorVersion: "stub-v1", signalCount: signals.length },
			contextUsage: { inputTokens: 0, outputTokens: 0, toolCalls: 0, costUsd: 0 },
			contextStartedAt: now,
			contextFinishedAt: now,
			contextPromptVersion: "stub-v1",
			contextModel: "stub",
			contextStageVersion: 1,
		})
		.returning({ id: agentRuns.id });
	await research.db.insert(contextSignals).values(
		signals.map((type, i) => {
			const known = METRIC_FOR[type] ?? { metric: "usable_rows", observed: 0, expected: 0 };
			const sparse = type === "insufficient_data";
			return {
				runId: run.id,
				stageVersion: 1,
				accountId: null,
				accountScope: "all",
				type,
				periodStart,
				periodEnd,
				metric: known.metric,
				observed: String(known.observed),
				expected: String(known.expected),
				confidence: sparse ? ("low" as const) : ("medium" as const),
				status: sparse ? ("insufficient_data" as const) : ("review" as const),
				policyVersion: "context-metrics-v1",
				explanation: `Stub signal ${i + 1} (${type}) — deterministic fixture, not model output.`,
				evidence: sparse ? [] : evidenceIds.map((id) => ({ kind: "transaction", id })),
			};
		}),
	);
	console.log(
		`demo:context-stub: persona=${personaKey} app=${app.id} run=${run.id} signals=${signals.length} (stub — not model output)`,
	);
} finally {
	await appSql.end();
	await research.sql.end();
}
