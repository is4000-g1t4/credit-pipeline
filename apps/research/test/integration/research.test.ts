// Research-service integration: real credit_research Postgres, fake
// agent/judge (no model, Tavily, or Grafana network).
import { randomUUID } from "node:crypto";
import {
	agentEvidence,
	agentFindingReviews,
	agentFindings,
	agentRuns,
	researchAccessGrants,
	researchAuditLog,
} from "@credit/db/research";
import { createLogger } from "@credit/service-kit";
import { eq, inArray, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
	stubAgentRunner,
	AgentTimeoutError,
	ModelUnavailableError,
	type AgentResult,
} from "../../src/agent.js";
import { checkAutoCaps } from "../../src/auto-trigger.js";
import { loadEnv } from "../../src/env.js";
import {
	claimRun,
	ensureRun,
	finalizeFailure,
	getRun,
	heartbeatContextStage,
	heartbeatRun,
	reapContextStages,
	reapStaleRuns,
	claimContextStage,
	initContextStage,
	type CaseFactsPayload,
} from "../../src/lifecycle.js";
import { executeRun } from "../../src/run.js";
import { stubLanguageRepair, type LanguageRepair } from "../../src/repair.js";
import { stubSupportJudge, type SupportJudge } from "../../src/support.js";
import { TavilyError } from "../../src/tavily.js";
import { sha256Hex } from "../../src/validator.js";
import {
	APPLICANT,
	caseFacts,
	degradedObservability,
	get,
	post,
	setupApp,
	signed,
	successFixture,
	teardown,
	user,
	type TestContext,
	type TestUser,
} from "../helper.js";
import { claimOfficerAccess, grantResearchAccess } from "../../src/access.js";

function ensurePayload(facts: CaseFactsPayload): Record<string, unknown> {
	return {
		applicationId: facts.applicationId,
		caseFacts: { ...facts },
		aiResearchConsent: facts.aiResearchConsent,
	};
}

/** Silent service logger for direct executeRun calls (routes wire the real one). */
const testLogger = createLogger("research-test");

interface LatestResponse {
	run: {
		id: string;
		status: string;
		applicationId: string;
		grafanaConversationId: string;
		observability: string;
		errorCode: string | null;
	};
	brief: { summary: string; unknowns: string[] } | null;
	validation: {
		scores: Record<string, number>;
		unsupportedClaims: number;
		discarded: Array<{ findingIndex: number; reason: string; claimHash: string }>;
	} | null;
	usage: { judgeCalls: number; repairCalls: number; costUsd: number } | null;
	evidence: Array<{
		id: string;
		url: string;
		quote: string;
		snapshotHash: string;
		snapshotText: string;
		quoteStart: number;
		quoteEnd: number;
		publishedAt: string | null;
		dateBasis: string;
	}>;
	findings: Array<{
		id: string;
		claim: string;
		evidenceIds: string[];
		evidence: Array<{ url: string; quote: string; snapshotHash: string }>;
		reviewStatus: string;
	}>;
	viewedAt: string | null;
}

/** Poll latest until the background execution settles. Pass the viewing
 * officer when asserting `viewedAt` — views are per officer. Reads are
 * access-checked (T00), so pass an officer with a grant: the one that
 * ensured, or one granted by service. */
async function waitLatest(
	ctx: TestContext,
	applicationId: string,
	who: TestUser | null = null,
): Promise<LatestResponse> {
	const officer = who ?? user("officer");
	const deadline = Date.now() + 10_000;
	for (;;) {
		const res = await get(ctx, `/internal/research/applications/${applicationId}/latest`, officer);
		expect(res.status).toBe(200);
		const body = (await res.json()) as LatestResponse;
		if (body.run.status === "succeeded" || body.run.status === "failed") return body;
		if (Date.now() > deadline) throw new Error(`run did not settle (status=${body.run.status})`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

async function settledRun(
	ctx: TestContext,
	facts: CaseFactsPayload,
): Promise<{ runId: string; findings: LatestResponse["findings"]; officer: TestUser }> {
	const officer = user("officer");
	await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
	const latest = await waitLatest(ctx, facts.applicationId, officer);
	return { runId: latest.run.id, findings: latest.findings, officer };
}

describe("POST /internal/research/runs/ensure", () => {
	it("inserts a queued run and settles to a validated succeeded aggregate", async () => {
		const ctx = setupApp();
		try {
			const officer = user("officer");
			const facts = caseFacts();
			const res = await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			expect(res.status).toBe(202);
			const created = (await res.json()) as {
				run: { id: string; status: string };
				inserted: boolean;
			};
			expect(created.inserted).toBe(true);
			expect(created.run.status).toBe("queued");

			const latest = await waitLatest(ctx, facts.applicationId, officer);
			expect(latest.run.id).toBe(created.run.id);
			// The run id doubles as the Grafana conversation id (not PII).
			expect(latest.run.grafanaConversationId).toBe(created.run.id);
			expect(latest.run.observability).toBe("degraded");
			expect(latest.run.errorCode).toBe(null);
			expect(latest.usage?.repairCalls).toBe(0);
			expect(latest.brief?.summary).toContain("Registry shows");
			expect(latest.evidence).toHaveLength(2);
			expect(latest.findings).toHaveLength(2);
			for (const f of latest.findings) {
				expect(f.reviewStatus).toBe("pending");
				expect(f.evidenceIds.length).toBeGreaterThan(0);
			}
			// Quotes are substrings of the stored snapshot window.
			for (const e of latest.evidence) {
				expect(e.snapshotText.slice(e.quoteStart, e.quoteEnd)).toBe(e.quote);
				expect(e.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
			}
			expect(latest.validation?.scores.unsupported_claims).toBe(0);
			expect(latest.viewedAt).toBe(null);
			// Judge work is tracked: 2 linked pairs, first-call supported.
			expect(latest.usage?.judgeCalls).toBe(2);
			// Model dates verified in the page text stay publisher_metadata.
			for (const e of latest.evidence) {
				expect(e.publishedAt).not.toBe(null);
				expect(e.dateBasis).toBe("publisher_metadata");
			}
		} finally {
			await teardown(ctx);
		}
	});

	it("is idempotent: concurrent clicks share one active run", async () => {
		// Gated runner holds the first run active while all clicks land, so
		// the test proves sharing rather than racing the background fake.
		const use = successFixture();
		let release!: (v: AgentResult) => void;
		const gate = new Promise<AgentResult>((r) => {
			release = r;
		});
		const ctx = setupApp(use, { runner: { runBrief: () => gate } });
		try {
			const officer = user("officer");
			const facts = caseFacts();
			const results = await Promise.all(
				Array.from({ length: 10 }, () =>
					post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts)),
				),
			);
			const bodies = (await Promise.all(results.map((r) => r.json()))) as Array<{
				run: { id: string };
				inserted: boolean;
			}>;
			expect(results.every((r) => r.status === 202)).toBe(true);
			const ids = new Set(bodies.map((b) => b.run.id));
			expect(ids.size).toBe(1);
			expect(bodies.filter((b) => b.inserted)).toHaveLength(1);
			release({
				brief: use.brief,
				fetched: use.fetched,
				usage: { inputTokens: 100, outputTokens: 100, toolCalls: 2, searches: 1, extracts: 1 },
				model: "deepseek/deepseek-v4.1-flash-1017",
			});
			const latest = await waitLatest(ctx, facts.applicationId, officer);
			expect(latest.run.status).toBe("succeeded");
		} finally {
			await teardown(ctx);
		}
	});

	it("rejects without consent, wrong status, incomplete facts, and bad asOf", async () => {
		const ctx = setupApp();
		try {
			const officer = user("officer");

			const noConsent = caseFacts({ aiResearchConsent: false });
			const r1 = await post(ctx, "/internal/research/runs/ensure", officer, {
				...ensurePayload(noConsent),
				aiResearchConsent: false,
			});
			expect(r1.status).toBe(403);

			const decided = caseFacts({ status: "approved" });
			const r2 = await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(decided));
			expect(r2.status).toBe(409);

			const legacy = caseFacts({ city: null, registrationNumber: null });
			const r3 = await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(legacy));
			expect(r3.status).toBe(202);
			const failed = (await r3.json()) as { run: { status: string }; inserted: boolean };
			expect(failed.run.status).toBe("failed");
			expect(failed.inserted).toBe(false);

			const drifted = caseFacts({ asOf: "2026-02-01T10:00:00.000Z" });
			const r4 = await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(drifted));
			expect(r4.status).toBe(422);
		} finally {
			await teardown(ctx);
		}
	});

	it("enforces HMAC: unsigned 401, applicant 403, body-swap 401", async () => {
		const ctx = setupApp();
		try {
			const officer = user("officer");
			const path = "/internal/research/runs/ensure";
			const payload = ensurePayload(caseFacts());

			const unsigned = await ctx.app.request(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			expect(unsigned.status).toBe(401);

			const applicant = await post(ctx, path, APPLICANT, payload);
			expect(applicant.status).toBe(403);

			const body = JSON.stringify(payload);
			const swappedBody = JSON.stringify(ensurePayload(caseFacts()));
			const swapped = await ctx.app.request(path, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...signed(ctx, officer, "POST", path, {}, body),
				},
				body: swappedBody,
			});
			expect(swapped.status).toBe(401);
		} finally {
			await teardown(ctx);
		}
	});

	it("persists no partial rows when the agent fails", async () => {
		const use = successFixture();
		const ctx = setupApp(use, {
			runner: stubAgentRunner({ brief: null, fetched: [], throw: new TavilyError("boom") }),
		});
		try {
			const officer = user("officer");
			const facts = caseFacts();
			const res = await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			expect(res.status).toBe(202);
			const latest = await waitLatest(ctx, facts.applicationId, officer);
			expect(latest.run.status).toBe("failed");
			expect(latest.evidence).toHaveLength(0);
			expect(latest.findings).toHaveLength(0);
			// No partial rows for this run (scoped by run id, not by the
			// empty aggregate above).
			const [ev, f] = await Promise.all([
				ctx.db
					.select({ id: agentEvidence.id })
					.from(agentEvidence)
					.where(eq(agentEvidence.runId, latest.run.id)),
				ctx.db
					.select({ id: agentFindings.id })
					.from(agentFindings)
					.where(eq(agentFindings.runId, latest.run.id)),
			]);
			expect(ev).toHaveLength(0);
			expect(f).toHaveLength(0);
		} finally {
			await teardown(ctx);
		}
	});

	it("discards unsupported findings and succeeds with an empty brief", async () => {
		const ctx = setupApp(undefined, { judge: stubSupportJudge({ unsupportedIf: /./ }) });
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId, officer);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.findings).toHaveLength(0);
			expect(latest.validation?.unsupportedClaims).toBe(2);
			expect(latest.brief?.unknowns.join(" ")).toContain("no supported findings");
		} finally {
			await teardown(ctx);
		}
	});
});

describe("run token + reaper (lifecycle)", () => {
	it("claim/finalize are conditional on the token", async () => {
		const ctx = setupApp();
		try {
			const env = { ...loadEnv(), agentsEnabled: true };
			const facts = caseFacts();
			const { run, inserted } = await ensureRun(ctx.db, env, {
				applicationId: facts.applicationId,
				requestedBy: randomUUID(),
				caseFacts: facts,
				aiResearchConsent: true,
			});
			expect(inserted).toBe(true);
			const token = run.runToken as string;

			expect(await claimRun(ctx.db, run.id, "wrong-token")).toBe(false);
			expect(await claimRun(ctx.db, run.id, token)).toBe(true);
			expect(await claimRun(ctx.db, run.id, token)).toBe(false); // already running
			expect(await finalizeFailure(ctx.db, run.id, "wrong-token", "timeout", "x")).toBe(false);
			expect(await finalizeFailure(ctx.db, run.id, token, "timeout", "timed out")).toBe(true);
			const rows = await ctx.db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
			expect(rows[0]?.status).toBe("failed");
			expect(rows[0]?.runToken).toBe(null);
		} finally {
			await teardown(ctx);
		}
	});

	it("completes a queued insert started outside the route (crash-after-insert)", async () => {
		const ctx = setupApp();
		try {
			const env = { ...loadEnv(), agentsEnabled: true };
			const use = successFixture();
			const facts = caseFacts();
			const { run } = await ensureRun(ctx.db, env, {
				applicationId: facts.applicationId,
				requestedBy: randomUUID(),
				caseFacts: facts,
				aiResearchConsent: true,
			});
			await executeRun(
				{
					db: ctx.db,
					env,
					logger: testLogger,
					runner: stubAgentRunner({ brief: use.brief, fetched: use.fetched }),
					judge: stubSupportJudge(),
					repair: stubLanguageRepair(),
					observability: degradedObservability,
				},
				run.id,
				run.runToken as string,
			);
			// The route was bypassed, so claim directly before reading.
			const reader = user("officer");
			await claimOfficerAccess(ctx.db, facts.applicationId, reader.id);
			const latest = await waitLatest(ctx, facts.applicationId, reader);
			expect(latest.run.status).toBe("succeeded");
		} finally {
			await teardown(ctx);
		}
	});

	it("reaps stale queued/running runs and leaves live runs alone", async () => {
		const ctx = setupApp();
		try {
			const env = { ...loadEnv(), agentsEnabled: true };
			const mk = (f: CaseFactsPayload) =>
				ensureRun(ctx.db, env, {
					applicationId: f.applicationId,
					requestedBy: randomUUID(),
					caseFacts: f,
					aiResearchConsent: true,
				});
			const staleQueued = (await mk(caseFacts())).run;
			const staleRunning = (await mk(caseFacts())).run;
			const live = (await mk(caseFacts())).run;
			expect(await claimRun(ctx.db, live.id, live.runToken as string)).toBe(true);
			expect(await claimRun(ctx.db, staleRunning.id, staleRunning.runToken as string)).toBe(true);
			// Backdate: queued past its timeout, running silent 90s+, live fresh.
			await ctx.db.execute(
				sql`UPDATE agent_runs SET timeout_at = now() - INTERVAL '61 seconds' WHERE id = ${staleQueued.id}`,
			);
			await ctx.db.execute(
				sql`UPDATE agent_runs SET heartbeat_at = now() - INTERVAL '91 seconds' WHERE id = ${staleRunning.id}`,
			);
			const reaped = await reapStaleRuns(ctx.db);
			// Containment, not exact equality: rows accumulate in the shared
			// dev DB across runs (repo convention), including other stale rows.
			expect(reaped).toContain(staleQueued.id);
			expect(reaped).toContain(staleRunning.id);
			expect(reaped).not.toContain(live.id);
			const rows = await ctx.db.select().from(agentRuns);
			const byId = new Map(rows.map((r) => [r.id, r]));
			for (const id of [staleQueued.id, staleRunning.id]) {
				expect(byId.get(id)?.status).toBe("failed");
				expect(byId.get(id)?.errorCode).toBe("timeout");
				expect(byId.get(id)?.runToken).toBe(null);
			}
			expect(byId.get(live.id)?.status).toBe("running");
			expect(await reapStaleRuns(ctx.db)).toEqual([]);
		} finally {
			await teardown(ctx);
		}
	});

	it("a heartbeat run is not reaped: backdated then refreshed beats the reaper", async () => {
		const ctx = setupApp();
		try {
			const env = { ...loadEnv(), agentsEnabled: true };
			const facts = caseFacts();
			const { run } = await ensureRun(ctx.db, env, {
				applicationId: facts.applicationId,
				requestedBy: randomUUID(),
				caseFacts: facts,
				aiResearchConsent: true,
			});
			const token = run.runToken as string;
			expect(await claimRun(ctx.db, run.id, token)).toBe(true);
			// Silence the heartbeat past the 90s reaper threshold, then let
			// the live worker beat again: the reaper must not select it.
			await ctx.db.execute(
				sql`UPDATE agent_runs SET heartbeat_at = now() - INTERVAL '91 seconds' WHERE id = ${run.id}`,
			);
			await heartbeatRun(ctx.db, run.id, token);
			expect(await reapStaleRuns(ctx.db)).not.toContain(run.id);
			expect((await getRun(ctx.db, run.id))?.status).toBe("running");
		} finally {
			await teardown(ctx);
		}
	});

	it("a heartbeat context stage is not reaped: backdated then refreshed beats the reaper", async () => {
		const ctx = setupApp();
		try {
			const env = { ...loadEnv(), agentsEnabled: true, contextEnabled: true };
			const facts = caseFacts();
			const { run } = await ensureRun(ctx.db, env, {
				applicationId: facts.applicationId,
				requestedBy: randomUUID(),
				caseFacts: facts,
				aiResearchConsent: true,
			});
			const token = run.runToken as string;
			expect(await claimRun(ctx.db, run.id, token)).toBe(true);
			expect(await initContextStage(ctx.db, env, run.id, token, "queued")).toBe(true);
			const stageToken = await claimContextStage(ctx.db, env, run.id, token, {
				promptVersion: "context-v1",
				model: "test-context-model",
			});
			expect(stageToken).not.toBe(null);
			// Silence the stage heartbeat past the 90s reaper threshold,
			// then let the live stage beat again.
			await ctx.db.execute(
				sql`UPDATE agent_runs SET context_heartbeat_at = now() - INTERVAL '91 seconds' WHERE id = ${run.id}`,
			);
			await heartbeatContextStage(ctx.db, run.id, stageToken as string);
			expect(await reapContextStages(ctx.db)).not.toContain(run.id);
			expect((await getRun(ctx.db, run.id))?.contextStatus).toBe("running");
		} finally {
			await teardown(ctx);
		}
	});
});

describe("app-scoped views, reviews, and bundle", () => {
	it("latest 404s when no run exists; view dedupes within the minute", async () => {
		const ctx = setupApp();
		try {
			// No grant anywhere: non-disclosure 404, same as a missing run.
			const missing = await get(
				ctx,
				`/internal/research/applications/${randomUUID()}/latest`,
				user("officer"),
			);
			expect(missing.status).toBe(404);

			const facts = caseFacts();
			const { runId, officer } = await settledRun(ctx, facts);
			const viewPath = `/internal/research/applications/${facts.applicationId}/runs/${runId}/view`;
			const v1 = await post(ctx, viewPath, officer, {});
			expect(v1.status).toBe(200);
			expect(((await v1.json()) as { deduped: boolean }).deduped).toBe(false);
			const v2 = await post(ctx, viewPath, officer, {});
			expect(((await v2.json()) as { deduped: boolean }).deduped).toBe(true);
			// Views are per officer: poll latest as the viewing officer.
			const latest = await waitLatest(ctx, facts.applicationId, officer);
			expect(latest.viewedAt).not.toBe(null);
		} finally {
			await teardown(ctx);
		}
	});

	it("reviews are append-only; the bundle carries accepted findings only", async () => {
		const ctx = setupApp();
		try {
			const facts = caseFacts();
			const { runId, findings, officer } = await settledRun(ctx, facts);
			expect(findings).toHaveLength(2);
			const reviewPath = (id: string) =>
				`/internal/research/applications/${facts.applicationId}/findings/${id}/review`;
			const a1 = await post(ctx, reviewPath(findings[0].id), officer, { action: "accepted" });
			expect(a1.status).toBe(201);
			const r2 = await post(ctx, reviewPath(findings[1].id), officer, { action: "rejected" });
			expect(r2.status).toBe(201);

			const bundlePath = `/internal/research/applications/${facts.applicationId}/runs/${runId}/bundle`;
			const bundleRes = await get(ctx, bundlePath, officer);
			expect(bundleRes.status).toBe(200);
			const bundle = (await bundleRes.json()) as {
				bundle: {
					agentRunId: string;
					applicationId: string;
					briefHash: string;
					viewedAt: string | null;
					acceptedFindings: Array<{
						findingId: string;
						claim: string;
						category: string;
						entityMatch: unknown;
						evidence: Array<{ url: string; quote: string; snapshotHash: string }>;
					}>;
				};
			};
			expect(bundle.bundle.agentRunId).toBe(runId);
			expect(bundle.bundle.applicationId).toBe(facts.applicationId);
			expect(bundle.bundle.briefHash).toMatch(/^[0-9a-f]{64}$/);
			// The kept finding carries its exact claim and evidence quotes,
			// hashed against the frozen brief.
			const latest = await waitLatest(ctx, facts.applicationId, officer);
			expect(bundle.bundle.briefHash).toBe(sha256Hex(JSON.stringify(latest.brief)));
			expect(bundle.bundle.acceptedFindings).toHaveLength(1);
			const [kept] = bundle.bundle.acceptedFindings;
			expect(kept.findingId).toBe(findings[0].id);
			expect(kept.claim).toBe(findings[0].claim);
			expect(kept.evidence.map((e) => e.quote)).toEqual(findings[0].evidence.map((e) => e.quote));
			expect(latest.findings.find((f) => f.id === findings[0].id)?.reviewStatus).toBe("accepted");
			expect(latest.findings.find((f) => f.id === findings[1].id)?.reviewStatus).toBe("rejected");

			// Append-only: rejecting the kept finding adds a row (latest
			// wins) and removes it from the frozen bundle.
			const a2 = await post(ctx, reviewPath(findings[0].id), officer, {
				action: "rejected",
				note: "second look",
			});
			expect(a2.status).toBe(201);
			const reviews = await ctx.db
				.select({ id: agentFindingReviews.id })
				.from(agentFindingReviews)
				.where(eq(agentFindingReviews.findingId, findings[0].id));
			expect(reviews).toHaveLength(2);
			const bundleRes2 = await get(ctx, bundlePath, officer);
			// Nothing stays accepted: explicit stale, not an empty bundle.
			expect(bundleRes2.status).toBe(409);
			const stale2 = (await bundleRes2.json()) as { error: { code: string } };
			expect(stale2.error.code).toBe("RESEARCH_SELECTION_STALE");
		} finally {
			await teardown(ctx);
		}
	});

	it("bundle 404s cross-application; findings/views reject mismatches", async () => {
		const ctx = setupApp();
		try {
			const officer = user("officer");
			const factsA = caseFacts();
			const factsB = caseFacts();
			const { runId, findings } = await settledRun(ctx, factsA);
			await settledRun(ctx, factsB);

			// The caller holds a grant on application B: the 404s below can
			// only come from the run/application mismatch, never from access.
			await grantResearchAccess(ctx.db, {
				applicationId: factsB.applicationId,
				userId: officer.id,
				accessRole: "compliance",
				grantedBy: randomUUID(),
				granterRole: "service",
			});
			const crossBundle = await get(
				ctx,
				`/internal/research/applications/${factsB.applicationId}/runs/${runId}/bundle`,
				officer,
			);
			expect(crossBundle.status).toBe(404);

			const crossView = await post(
				ctx,
				`/internal/research/applications/${factsB.applicationId}/runs/${runId}/view`,
				officer,
				{},
			);
			expect(crossView.status).toBe(404);

			const crossReview = await post(
				ctx,
				`/internal/research/applications/${factsB.applicationId}/findings/${findings[0].id}/review`,
				officer,
				{ action: "accepted" },
			);
			expect(crossReview.status).toBe(404);

			const missingFinding = await post(
				ctx,
				`/internal/research/applications/${factsA.applicationId}/findings/${randomUUID()}/review`,
				officer,
				{ action: "accepted" },
			);
			expect(missingFinding.status).toBe(404);
		} finally {
			await teardown(ctx);
		}
	});

	it("rejects reviews while the run has not succeeded", async () => {
		const ctx = setupApp();
		try {
			const officer = user("officer");
			const env = { ...loadEnv(), agentsEnabled: true };
			const facts = caseFacts();
			// Direct insert: no background execution, run stays queued.
			// The route bypass is intentional — claim access directly so the
			// test proves the 409 (not a 404) for a non-succeeded run.
			const { run } = await ensureRun(ctx.db, env, {
				applicationId: facts.applicationId,
				requestedBy: randomUUID(),
				caseFacts: facts,
				aiResearchConsent: true,
			});
			await claimOfficerAccess(ctx.db, facts.applicationId, officer.id);
			const [finding] = await ctx.db
				.insert(agentFindings)
				.values({
					runId: run.id,
					claim: "Seeded claim.",
					category: "registry",
					whyItMatters: "Seeded relevance.",
					allegationStatus: "unknown",
					confidenceBasis: {},
					entityMatch: {},
				})
				.returning({ id: agentFindings.id });
			const res = await post(
				ctx,
				`/internal/research/applications/${facts.applicationId}/findings/${finding.id}/review`,
				officer,
				{ action: "accepted" },
			);
			expect(res.status).toBe(409);
		} finally {
			await teardown(ctx);
		}
	});
	it("a reaped run's old token writes nothing (stale success cannot land)", async () => {
		const ctx = setupApp();
		try {
			const env = { ...loadEnv(), agentsEnabled: true };
			const use = successFixture();
			const facts = caseFacts();
			const { run } = await ensureRun(ctx.db, env, {
				applicationId: facts.applicationId,
				requestedBy: randomUUID(),
				caseFacts: facts,
				aiResearchConsent: true,
			});
			const token = run.runToken as string;
			expect(await claimRun(ctx.db, run.id, token)).toBe(true);
			// Silence the heartbeat so the reaper takes the run; the token
			// turns over (null) on reap.
			await ctx.db.execute(
				sql`UPDATE agent_runs SET heartbeat_at = now() - INTERVAL '91 seconds' WHERE id = ${run.id}`,
			);
			expect(await reapStaleRuns(ctx.db)).toContain(run.id);
			// The background worker still holding the old token must not
			// write: claim fails, zero evidence/finding rows land.
			await executeRun(
				{
					db: ctx.db,
					env,
					logger: testLogger,
					runner: stubAgentRunner({ brief: use.brief, fetched: use.fetched }),
					judge: stubSupportJudge(),
					repair: stubLanguageRepair(),
					observability: degradedObservability,
				},
				run.id,
				token,
			);
			const after = await getRun(ctx.db, run.id);
			expect(after?.status).toBe("failed");
			expect(after?.errorCode).toBe("timeout");
			const [ev, f] = await Promise.all([
				ctx.db
					.select({ id: agentEvidence.id })
					.from(agentEvidence)
					.where(eq(agentEvidence.runId, run.id)),
				ctx.db
					.select({ id: agentFindings.id })
					.from(agentFindings)
					.where(eq(agentFindings.runId, run.id)),
			]);
			expect(ev).toHaveLength(0);
			expect(f).toHaveLength(0);
		} finally {
			await teardown(ctx);
		}
	});

	it("a run reaped mid-flight cannot finalize success with the old token", async () => {
		const ctx = setupApp();
		try {
			const env = { ...loadEnv(), agentsEnabled: true };
			const use = successFixture();
			const facts = caseFacts();
			const { run } = await ensureRun(ctx.db, env, {
				applicationId: facts.applicationId,
				requestedBy: randomUUID(),
				caseFacts: facts,
				aiResearchConsent: true,
			});
			const token = run.runToken as string;
			// The runner reaps the run mid-flight (after executeRun claimed
			// it): the token turns over before finalize, so the success
			// guard must reject the write — no seam, just a slow agent.
			const reapingRunner = {
				async runBrief(): Promise<AgentResult> {
					await ctx.db.execute(
						sql`UPDATE agent_runs SET heartbeat_at = now() - INTERVAL '91 seconds' WHERE id = ${run.id}`,
					);
					expect(await reapStaleRuns(ctx.db)).toContain(run.id);
					return {
						brief: use.brief,
						fetched: use.fetched,
						usage: {
							inputTokens: 100,
							outputTokens: 100,
							toolCalls: 2,
							searches: 1,
							extracts: 1,
						},
						model: "deepseek/deepseek-v4.1-flash-1017",
					};
				},
			};
			await executeRun(
				{
					db: ctx.db,
					env,
					logger: testLogger,
					runner: reapingRunner,
					judge: stubSupportJudge(),
					repair: stubLanguageRepair(),
					observability: degradedObservability,
				},
				run.id,
				token,
			);
			// finalizeSuccess's stale-token guard fired: the run stays
			// failed/timeout with zero evidence/finding rows, even though
			// validation built findings before the finalize attempt.
			const after = await getRun(ctx.db, run.id);
			expect(after?.status).toBe("failed");
			expect(after?.errorCode).toBe("timeout");
			const [ev, f] = await Promise.all([
				ctx.db
					.select({ id: agentEvidence.id })
					.from(agentEvidence)
					.where(eq(agentEvidence.runId, run.id)),
				ctx.db
					.select({ id: agentFindings.id })
					.from(agentFindings)
					.where(eq(agentFindings.runId, run.id)),
			]);
			expect(ev).toHaveLength(0);
			expect(f).toHaveLength(0);
		} finally {
			await teardown(ctx);
		}
	});

	it("bundle 404s before success, 409s when nothing stays accepted", async () => {
		const ctx = setupApp();
		try {
			const officer = user("officer");
			const env = { ...loadEnv(), agentsEnabled: true };
			const facts = caseFacts();
			// Queued run: no succeeded bundle yet. Claim access first so the
			// 404 below proves the non-succeeded status, not the access check.
			const { run } = await ensureRun(ctx.db, env, {
				applicationId: facts.applicationId,
				requestedBy: randomUUID(),
				caseFacts: facts,
				aiResearchConsent: true,
			});
			await claimOfficerAccess(ctx.db, facts.applicationId, officer.id);
			const queued = await get(
				ctx,
				`/internal/research/applications/${facts.applicationId}/runs/${run.id}/bundle`,
				officer,
			);
			expect(queued.status).toBe(404);

			// Succeeded run with zero accepted findings: explicit stale, not
			// a min(1) schema surprise.
			const settledFacts = caseFacts();
			const { runId, findings, officer: owner } = await settledRun(ctx, settledFacts);
			expect(findings.length).toBeGreaterThan(0);
			const empty = await get(
				ctx,
				`/internal/research/applications/${settledFacts.applicationId}/runs/${runId}/bundle`,
				owner,
			);
			expect(empty.status).toBe(409);
			const body = (await empty.json()) as { error: { code: string } };
			expect(body.error.code).toBe("RESEARCH_SELECTION_STALE");
		} finally {
			await teardown(ctx);
		}
	});

	it("bundle viewedAt follows the requesting officer, not any officer", async () => {
		const ctx = setupApp();
		try {
			const officerA = user("officer");
			const officerB = user("officer");
			const facts = caseFacts();
			// Officer A ensures (claiming the case), officer B never touches
			// it: B's reads are cross-officer non-disclosure 404s.
			await post(ctx, "/internal/research/runs/ensure", officerA, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId, officerA);
			expect(latest.run.status).toBe("succeeded");
			const findings = latest.findings;
			const reviewPath = (id: string) =>
				`/internal/research/applications/${facts.applicationId}/findings/${id}/review`;
			await post(ctx, reviewPath(findings[0].id), officerA, { action: "accepted" });

			const viewPath = `/internal/research/applications/${facts.applicationId}/runs/${latest.run.id}/view`;
			const bundlePath = `/internal/research/applications/${facts.applicationId}/runs/${latest.run.id}/bundle`;
			// Only officer A views.
			expect((await post(ctx, viewPath, officerA, {})).status).toBe(200);

			const bundleA = (await (await get(ctx, bundlePath, officerA)).json()) as {
				bundle: { viewedAt: string | null };
			};
			expect(bundleA.bundle.viewedAt).not.toBe(null);
			// Officer B holds no grant: 404, not an empty viewedAt.
			expect((await get(ctx, bundlePath, officerB)).status).toBe(404);
			expect(
				(await get(ctx, `/internal/research/applications/${facts.applicationId}/latest`, officerB))
					.status,
			).toBe(404);
		} finally {
			await teardown(ctx);
		}
	});
});

const SCOPED_OFFICIAL_URL = "https://find-and-update.company-information.service.gov.uk/company/9";
const SCOPED_NEWS_URL = "https://www.bbc.co.uk/news/scoped-case";

/** Quote-aware judge: a claim is supported only by its own passage. */
const scopedJudge: SupportJudge = async (claim, quote) => {
	const supported =
		(claim.includes("Alpha") && quote.includes("Alpha")) ||
		(claim.includes("Beta") && quote.includes("Beta"));
	if (!supported) return { verdict: "unsupported", span: null };
	return { verdict: "supported", span: quote.slice(0, Math.min(quote.length, 200)) };
};

function scopedFixture(): { brief: unknown; fetched: AgentResult["fetched"] } {
	const quoteA = "Alpha Corp opened a Leeds office in 2024.";
	const quoteB = "Beta Ltd filed 2024 accounts on time.";
	return {
		brief: {
			summary: "Two findings.",
			findings: [
				{
					claim: "Alpha Corp opened a Leeds office in 2024.",
					category: "market",
					whyItMatters: "Context for the application.",
					allegationStatus: "unknown",
					entityMatch: {
						identifierType: "name_city",
						value: "Acme Ltd, Leeds",
						confidence: "medium",
					},
					evidenceLocalIds: ["ev-1"],
				},
				{
					// Links ONLY ev-1, whose quote cannot support it; ev-2
					// must not rescue it (per-finding scope).
					claim: "Beta Ltd filed 2024 accounts on time.",
					category: "registry",
					whyItMatters: "Context for the application.",
					allegationStatus: "unknown",
					entityMatch: {
						identifierType: "name_city",
						value: "Acme Ltd, Leeds",
						confidence: "medium",
					},
					evidenceLocalIds: ["ev-1"],
				},
			],
			evidence: [
				{
					localId: "ev-1",
					url: SCOPED_OFFICIAL_URL,
					title: "Alpha filing",
					publisher: "Companies House",
					publishedAt: null,
					quote: quoteA,
				},
				{
					localId: "ev-2",
					url: SCOPED_NEWS_URL,
					title: "Beta news",
					publisher: "BBC",
					publishedAt: null,
					quote: quoteB,
				},
			],
			contradictions: [],
			unknowns: [],
			questionsForOfficer: [],
		},
		fetched: [
			{
				requestedUrl: SCOPED_OFFICIAL_URL,
				returnedUrl: SCOPED_OFFICIAL_URL,
				title: "Alpha filing",
				searchPublishedDate: null,
				rawContent: `page\n${quoteA}\nmore`,
			},
			{
				requestedUrl: SCOPED_NEWS_URL,
				returnedUrl: SCOPED_NEWS_URL,
				title: "Beta news",
				searchPublishedDate: null,
				rawContent: `page\n${quoteB}\nmore`,
			},
		],
	};
}

describe("failure boundary + judge budget (Wave 2.5)", () => {
	it("judges each finding only against its own linked evidence", async () => {
		const use = scopedFixture();
		const ctx = setupApp(use, { judge: scopedJudge });
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId, officer);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.findings).toHaveLength(1);
			expect(latest.findings[0].claim).toContain("Alpha");
			// The rejected claim is never persisted in full: index + hash only.
			const discarded = latest.validation?.discarded ?? [];
			expect(discarded).toHaveLength(1);
			expect(discarded[0].findingIndex).toBe(1);
			expect(discarded[0].claimHash).toMatch(/^[0-9a-f]{64}$/);
			expect(JSON.stringify(latest.validation)).not.toContain("Beta Ltd filed");
		} finally {
			await teardown(ctx);
		}
	});

	it("clears the summary and reports pii_leak when content is quarantined", async () => {
		const quote = "The director's diabetes treatment was discussed at the Acme Leeds meeting.";
		const url = "https://www.bbc.co.uk/news/pii-case";
		const ctx = setupApp({
			brief: {
				summary: "The director has a health condition and the firm met.",
				findings: [
					{
						claim: "Acme Ltd held a meeting in Leeds.",
						category: "market",
						whyItMatters: "Context.",
						allegationStatus: "unknown",
						entityMatch: {
							identifierType: "name_city",
							value: "Acme Ltd, Leeds",
							confidence: "medium",
						},
						evidenceLocalIds: ["ev-1"],
					},
				],
				evidence: [
					{
						localId: "ev-1",
						url,
						title: "Meeting",
						publisher: "BBC",
						publishedAt: null,
						quote,
					},
				],
				contradictions: [],
				unknowns: [],
				questionsForOfficer: [],
			},
			fetched: [
				{
					requestedUrl: url,
					returnedUrl: url,
					title: "Meeting",
					searchPublishedDate: null,
					rawContent: `page\n${quote}\nmore`,
				},
			],
		});
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId, officer);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.findings).toHaveLength(0);
			expect(latest.brief?.summary).toBe("No supported findings remained after validation.");
			expect(latest.validation?.scores.pii_leak).toBe(1);
		} finally {
			await teardown(ctx);
		}
	});

	it("stores null + unknown when the model date is absent from the page", async () => {
		const quote = "Dated item mentions Acme Ltd opening in Leeds.";
		const url = "https://www.bbc.co.uk/news/dateless-case";
		const ctx = setupApp({
			brief: {
				summary: "One finding.",
				findings: [
					{
						claim: "Dated item mentions Acme Ltd opening in Leeds.",
						category: "market",
						whyItMatters: "Context.",
						allegationStatus: "unknown",
						entityMatch: {
							identifierType: "name_city",
							value: "Acme Ltd, Leeds",
							confidence: "medium",
						},
						evidenceLocalIds: ["ev-1"],
					},
				],
				evidence: [
					{
						localId: "ev-1",
						url,
						title: "Item",
						publisher: "BBC",
						publishedAt: "2025-06-01",
						quote,
					},
				],
				contradictions: [],
				unknowns: [],
				questionsForOfficer: [],
			},
			fetched: [
				{
					requestedUrl: url,
					returnedUrl: url,
					title: "Item",
					searchPublishedDate: null,
					rawContent: `page\n${quote}\nmore`,
				},
			],
		});
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId, officer);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.evidence).toHaveLength(1);
			expect(latest.evidence[0].publishedAt).toBe(null);
			expect(latest.evidence[0].dateBasis).toBe("unknown");
		} finally {
			await teardown(ctx);
		}
	});

	it("merges two quotes from one small page into a single evidence row", async () => {
		const url = "https://www.bbc.co.uk/news/shared-page";
		const quoteA = "Alpha line one.";
		const quoteB = "Beta line two.";
		const raw = `start\n${quoteA}\nMiddle.\n${quoteB}\nend`;
		const ctx = setupApp({
			brief: {
				summary: "Shared page.",
				findings: [
					{
						claim: "Alpha line one.",
						category: "market",
						whyItMatters: "Context.",
						allegationStatus: "unknown",
						entityMatch: {
							identifierType: "name_city",
							value: "Acme Ltd, Leeds",
							confidence: "medium",
						},
						evidenceLocalIds: ["ev-1a", "ev-1b"],
					},
				],
				evidence: [
					{
						localId: "ev-1a",
						url,
						title: "Page",
						publisher: "BBC",
						publishedAt: null,
						quote: quoteA,
					},
					{
						localId: "ev-1b",
						url,
						title: "Page",
						publisher: "BBC",
						publishedAt: null,
						quote: quoteB,
					},
				],
				contradictions: [],
				unknowns: [],
				questionsForOfficer: [],
			},
			fetched: [
				{
					requestedUrl: url,
					returnedUrl: url,
					title: "Page",
					searchPublishedDate: null,
					rawContent: raw,
				},
			],
		});
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId, officer);
			// One row, not a 23505 on the (run, url, hash) unique key.
			expect(latest.run.status).toBe("succeeded");
			expect(latest.evidence).toHaveLength(1);
			expect(latest.findings).toHaveLength(1);
			expect(latest.findings[0].evidenceIds).toHaveLength(1);
			// Exact attribution: the surviving row keeps the first quote —
			// the dropped second quote is never attached to this finding.
			expect(latest.evidence[0].quote).toBe(quoteA);
			expect(latest.findings[0].evidence).toHaveLength(1);
			expect(latest.findings[0].evidence[0].quote).toBe(quoteA);
		} finally {
			await teardown(ctx);
		}
	});

	it("drops a finding that cites only the duplicate quote, never misattributing it", async () => {
		const url = "https://www.bbc.co.uk/news/shared-page-second";
		const quoteA = "Alpha line one here.";
		const quoteB = "Beta line two here.";
		const raw = `start\n${quoteA}\nMiddle.\n${quoteB}\nend`;
		const ctx = setupApp({
			brief: {
				summary: "Shared page.",
				findings: [
					{
						claim: "Beta line two here.",
						category: "market",
						whyItMatters: "Context.",
						allegationStatus: "unknown",
						entityMatch: {
							identifierType: "name_city",
							value: "Acme Ltd, Leeds",
							confidence: "medium",
						},
						evidenceLocalIds: ["ev-1b"],
					},
				],
				evidence: [
					{
						localId: "ev-1a",
						url,
						title: "Page",
						publisher: "BBC",
						publishedAt: null,
						quote: quoteA,
					},
					{
						localId: "ev-1b",
						url,
						title: "Page",
						publisher: "BBC",
						publishedAt: null,
						quote: quoteB,
					},
				],
				contradictions: [],
				unknowns: [],
				questionsForOfficer: [],
			},
			fetched: [
				{
					requestedUrl: url,
					returnedUrl: url,
					title: "Page",
					searchPublishedDate: null,
					rawContent: raw,
				},
			],
		});
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId, officer);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.evidence).toHaveLength(1);
			expect(latest.evidence[0].quote).toBe(quoteA);
			// The finding cited only the dropped duplicate: discarded with
			// an explicit reason, never attached to the first row's quote.
			expect(latest.findings).toHaveLength(0);
			expect(latest.validation?.discarded).toHaveLength(1);
			expect(latest.validation?.discarded[0].reason).toMatch(/duplicate/);
			expect(JSON.stringify(latest.validation)).not.toContain("Beta line two here.");
		} finally {
			await teardown(ctx);
		}
	});

	it("never rejects: bad tokens and runner crashes settle without unhandled rejection", async () => {
		const ctx = setupApp();
		try {
			const env = { ...loadEnv(), agentsEnabled: true };
			const facts = caseFacts();
			const { run } = await ensureRun(ctx.db, env, {
				applicationId: facts.applicationId,
				requestedBy: randomUUID(),
				caseFacts: facts,
				aiResearchConsent: true,
			});
			await expect(
				executeRun(
					{
						db: ctx.db,
						env,
						logger: testLogger,
						runner: stubAgentRunner({ brief: null, fetched: [] }),
						judge: stubSupportJudge(),
						repair: stubLanguageRepair(),
						observability: degradedObservability,
					},
					run.id,
					"not-a-token",
				),
			).resolves.toBeUndefined();
			const still = await getRun(ctx.db, run.id);
			expect(still?.status).toBe("queued");

			const facts2 = caseFacts();
			const second = await ensureRun(ctx.db, env, {
				applicationId: facts2.applicationId,
				requestedBy: randomUUID(),
				caseFacts: facts2,
				aiResearchConsent: true,
			});
			await expect(
				executeRun(
					{
						db: ctx.db,
						env,
						logger: testLogger,
						runner: stubAgentRunner({ brief: null, fetched: [], throw: new Error("boom") }),
						judge: stubSupportJudge(),
						repair: stubLanguageRepair(),
						observability: degradedObservability,
					},
					second.run.id,
					second.run.runToken as string,
				),
			).resolves.toBeUndefined();
			const reader = user("officer");
			await claimOfficerAccess(ctx.db, facts2.applicationId, reader.id);
			const latest = await waitLatest(ctx, facts2.applicationId, reader);
			expect(latest.run.status).toBe("failed");
		} finally {
			await teardown(ctx);
		}
	});

	it("enforces AGENT_MAX_COST_USD end-to-end including judge work", async () => {
		const ctx = setupApp();
		try {
			const env = { ...loadEnv(), agentsEnabled: true };
			const use = successFixture();
			const facts = caseFacts();
			const { run } = await ensureRun(ctx.db, env, {
				applicationId: facts.applicationId,
				requestedBy: randomUUID(),
				caseFacts: facts,
				aiResearchConsent: true,
			});
			await executeRun(
				{
					db: ctx.db,
					env: { ...env, maxCostUsd: 0 },
					logger: testLogger,
					runner: stubAgentRunner({ brief: use.brief, fetched: use.fetched }),
					judge: stubSupportJudge(),
					repair: stubLanguageRepair(),
					observability: degradedObservability,
				},
				run.id,
				run.runToken as string,
			);
			const reader = user("officer");
			await claimOfficerAccess(ctx.db, facts.applicationId, reader.id);
			const latest = await waitLatest(ctx, facts.applicationId, reader);
			expect(latest.run.status).toBe("failed");
		} finally {
			await teardown(ctx);
		}
	});

	it("a real failing run persists partial usage that counts against the auto cap", async () => {
		const ctx = setupApp();
		try {
			const env = { ...loadEnv(), agentsEnabled: true };
			const use = successFixture();
			const facts = caseFacts();
			const applicantUserId = randomUUID();
			const { run } = await ensureRun(ctx.db, env, {
				applicationId: facts.applicationId,
				requestedBy: randomUUID(),
				requestedByRole: "service",
				trigger: "auto",
				triggerEventId: randomUUID(),
				applicantUserId,
				caseFacts: facts,
				aiResearchConsent: true,
			});
			// Zero budget trips the end-to-end cap after real agent + judge
			// work: the failure row must carry that spend, not empty usage.
			await executeRun(
				{
					db: ctx.db,
					env: { ...env, maxCostUsd: 0 },
					logger: testLogger,
					runner: stubAgentRunner({ brief: use.brief, fetched: use.fetched }),
					judge: stubSupportJudge(),
					repair: stubLanguageRepair(),
					observability: degradedObservability,
				},
				run.id,
				run.runToken as string,
			);
			const after = await getRun(ctx.db, run.id);
			expect(after?.status).toBe("failed");
			const usage = after?.usage as Record<string, number>;
			expect(usage.inputTokens).toBeGreaterThan(0);
			expect(usage.costUsd).toBeGreaterThan(0);
			// The failed spend counts: a budget at today's total is exhausted.
			const spend = (await ctx.db.execute(
				sql`SELECT coalesce(sum(CASE WHEN usage->>'costUsd' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (usage->>'costUsd')::double precision ELSE 0 END), 0)::float8 AS total FROM agent_runs WHERE trigger = 'auto' AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
			)) as unknown as Array<{ total: number }>;
			const total = spend[0]?.total ?? 0;
			expect(total).toBeGreaterThanOrEqual(usage.costUsd);
			expect(
				await checkAutoCaps(
					ctx.db,
					{
						...env,
						autoTriggerMaxRunsPerApplicantDay: 1000,
						autoTriggerMaxRunsPerDay: 100_000,
						autoTriggerDailyCostBudgetUsd: total,
					},
					randomUUID(),
				),
			).toEqual({ ok: false, reason: "daily_cost_budget" });
		} finally {
			await teardown(ctx);
		}
	});

	it("a runner-thrown failure persists a conservative cost against the auto cap", async () => {
		const ctx = setupApp();
		try {
			const env = { ...loadEnv(), agentsEnabled: true };
			// Hermetic floor: a timeout before any usage persists maxCostUsd.
			const floorEnv = { ...env, maxCostUsd: 0.15 };
			const facts = caseFacts();
			const applicantUserId = randomUUID();
			const { run } = await ensureRun(ctx.db, env, {
				applicationId: facts.applicationId,
				requestedBy: randomUUID(),
				requestedByRole: "service",
				trigger: "auto",
				triggerEventId: randomUUID(),
				applicantUserId,
				caseFacts: facts,
				aiResearchConsent: true,
			});
			// The runner throws before returning any usage (timeout): the
			// failure row must carry the conservative floor, not zero, so
			// the auto daily budget counts the failed work.
			await executeRun(
				{
					db: ctx.db,
					env: floorEnv,
					logger: testLogger,
					runner: stubAgentRunner({
						brief: null,
						fetched: [],
						throw: new AgentTimeoutError("agent wall clock exceeded"),
					}),
					judge: stubSupportJudge(),
					repair: stubLanguageRepair(),
					observability: degradedObservability,
				},
				run.id,
				run.runToken as string,
			);
			const after = await getRun(ctx.db, run.id);
			expect(after?.status).toBe("failed");
			expect(after?.errorCode).toBe("timeout");
			const usage = after?.usage as Record<string, number>;
			expect(usage.costUsd).toBe(0.15);
			// The failed spend counts: a budget at today's total is exhausted.
			const spend = (await ctx.db.execute(
				sql`SELECT coalesce(sum(CASE WHEN usage->>'costUsd' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (usage->>'costUsd')::double precision ELSE 0 END), 0)::float8 AS total FROM agent_runs WHERE trigger = 'auto' AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
			)) as unknown as Array<{ total: number }>;
			const total = spend[0]?.total ?? 0;
			expect(total).toBeGreaterThanOrEqual(usage.costUsd);
			expect(
				await checkAutoCaps(
					ctx.db,
					{
						...env,
						autoTriggerMaxRunsPerApplicantDay: 1000,
						autoTriggerMaxRunsPerDay: 100_000,
						autoTriggerDailyCostBudgetUsd: total,
					},
					randomUUID(),
				),
			).toEqual({ ok: false, reason: "daily_cost_budget" });
		} finally {
			await teardown(ctx);
		}
	});

	it("collapses concurrent first views to one row", async () => {
		const ctx = setupApp();
		try {
			const facts = caseFacts();
			const { runId, officer } = await settledRun(ctx, facts);
			const viewPath = `/internal/research/applications/${facts.applicationId}/runs/${runId}/view`;
			const results = await Promise.all(
				Array.from({ length: 5 }, () => post(ctx, viewPath, officer, {})),
			);
			expect(results.every((r) => r.status === 200)).toBe(true);
			const bodies = (await Promise.all(results.map((r) => r.json()))) as Array<{
				deduped: boolean;
			}>;
			expect(bodies.filter((b) => !b.deduped)).toHaveLength(1);
			const rows = (await ctx.db.execute(
				sql`SELECT count(*)::int AS n FROM agent_run_views WHERE run_id = ${runId} AND officer_id = ${officer.id}`,
			)) as unknown as Array<{ n: number }>;
			expect(rows[0]?.n).toBe(1);
		} finally {
			await teardown(ctx);
		}
	});
});

describe("language repair (Wave 5)", () => {
	/** successFixture brief with decision language in the summary and findings. */
	function forbiddenFixture(): { brief: unknown; fetched: AgentResult["fetched"] } {
		const use = successFixture();
		const brief = use.brief as {
			findings: Array<Record<string, unknown>>;
			evidence: unknown;
			contradictions: unknown;
			unknowns: unknown;
			questionsForOfficer: unknown;
		};
		return {
			brief: {
				summary: "Registry shows timely filings; the loan terms look fine.",
				findings: [
					{ ...brief.findings[0], whyItMatters: "Timely filing supports approval." },
					{
						...brief.findings[1],
						claim: "Local paper rates Acme Ltd a growing firm in Leeds.",
						whyItMatters: "Growth decides the application.",
					},
				],
				evidence: brief.evidence,
				contradictions: brief.contradictions,
				unknowns: brief.unknowns,
				questionsForOfficer: brief.questionsForOfficer,
			},
			fetched: use.fetched,
		};
	}

	it("repairs decision language once and succeeds", async () => {
		const use = forbiddenFixture();
		const repair = stubLanguageRepair({
			repair: (brief) => ({
				...brief,
				summary: "Registry shows timely filings in the public record.",
				findings: brief.findings.map((f, i) => ({
					...f,
					claim: i === 1 ? "Local paper describes Acme Ltd as a growing firm in Leeds." : f.claim,
					whyItMatters: "This is part of the public record for the officer to weigh.",
				})),
			}),
		});
		const ctx = setupApp(use, { repair });
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId, officer);
			expect(latest.run.status).toBe("succeeded");
			// Exactly one repair call; usage counts toward the run budget.
			expect(repair.calls).toBe(1);
			expect(latest.usage?.repairCalls).toBe(1);
			// Nothing added or lost: same findings, evidence, and links.
			expect(latest.findings).toHaveLength(2);
			expect(latest.evidence).toHaveLength(2);
			expect(latest.brief?.summary).toBe("Registry shows timely filings in the public record.");
			expect(JSON.stringify(latest)).not.toMatch(
				/loan terms|supports approval|decides the application/i,
			);
		} finally {
			await teardown(ctx);
		}
	});

	it("fails safely with zero persisted rows when repair cannot clean the brief", async () => {
		const use = forbiddenFixture();
		const repair = stubLanguageRepair(); // identity: still dirty
		const ctx = setupApp(use, {
			repair,
			observability: {
				status: "ok",
				hooksFor: () => ({ detach: () => {} }),
				trackModelCall: (_opts, fn) => fn(),
				trackToolExecution: (_opts, fn) => fn(),
			},
		});
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId, officer);
			expect(latest.run.status).toBe("failed");
			expect(latest.run.errorCode).toBe("validation_failed");
			expect(repair.calls).toBe(1);
			expect(latest.evidence).toHaveLength(0);
			expect(latest.findings).toHaveLength(0);
			expect(latest.brief).toBe(null);
			// The failure row carries the real status, not the insert default.
			expect(latest.run.observability).toBe("ok");
			const [ev, f] = await Promise.all([
				ctx.db
					.select({ id: agentEvidence.id })
					.from(agentEvidence)
					.where(eq(agentEvidence.runId, latest.run.id)),
				ctx.db
					.select({ id: agentFindings.id })
					.from(agentFindings)
					.where(eq(agentFindings.runId, latest.run.id)),
			]);
			expect(ev).toHaveLength(0);
			expect(f).toHaveLength(0);
		} finally {
			await teardown(ctx);
		}
	});

	it("rejects a repair that adds findings or evidence", async () => {
		const use = forbiddenFixture();
		const repair = stubLanguageRepair({
			repair: (brief) => ({
				...brief,
				summary: "Registry shows timely filings in the public record.",
				findings: [
					...brief.findings.map((f) => ({
						...f,
						whyItMatters: "This is part of the public record.",
					})),
					{
						claim: "Acme Ltd held a meeting in Leeds.",
						category: "market",
						whyItMatters: "Context.",
						allegationStatus: "unknown",
						entityMatch: {
							identifierType: "name_city",
							value: "Acme Ltd, Leeds",
							confidence: "medium",
						},
						evidenceLocalIds: ["ev-1"],
					},
				],
				evidence: [
					...brief.evidence,
					{
						localId: "ev-3",
						url: "https://www.bbc.co.uk/news/acme-leeds",
						title: "Extra",
						publisher: "BBC",
						publishedAt: null,
						quote: "Local paper notes Acme Ltd opened a second warehouse in Leeds.",
					},
				],
			}),
		});
		const ctx = setupApp(use, { repair });
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId, officer);
			expect(latest.run.status).toBe("failed");
			expect(latest.run.errorCode).toBe("validation_failed");
			expect(repair.calls).toBe(1);
			expect(latest.evidence).toHaveLength(0);
			expect(latest.findings).toHaveLength(0);
			expect(JSON.stringify(latest.validation)).not.toContain("held a meeting");
		} finally {
			await teardown(ctx);
		}
	});
});

describe("run conversation threading (Wave 7)", () => {
	it("threads the run id to every judge and repair call", async () => {
		const judgeRunIds: Array<string | undefined> = [];
		const repairRunIds: Array<string | undefined> = [];
		const use = successFixture();
		const brief = use.brief as { summary: string } & Record<string, unknown>;
		const judge: SupportJudge = async (_claim, quote, opts) => {
			judgeRunIds.push(opts?.runId);
			return { verdict: "supported", span: quote.slice(0, Math.min(quote.length, 200)) };
		};
		const repair: LanguageRepair = async (b, opts) => {
			repairRunIds.push(opts?.runId);
			return {
				brief: {
					...b,
					summary: "Registry shows timely filings in the public record.",
				},
			};
		};
		const ctx = setupApp(
			{
				brief: { ...brief, summary: "Registry shows timely filings; the loan terms look fine." },
				fetched: use.fetched,
			},
			{ judge, repair },
		);
		try {
			const officer = user("officer");
			const facts = caseFacts();
			const res = await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const created = (await res.json()) as { run: { id: string } };
			const latest = await waitLatest(ctx, facts.applicationId, officer);
			expect(latest.run.status).toBe("succeeded");
			// Every direct model call joins the run conversation: same id throughout.
			expect(judgeRunIds.length).toBeGreaterThan(0);
			expect(judgeRunIds.every((id) => id === created.run.id)).toBe(true);
			expect(repairRunIds).toEqual([created.run.id]);
			expect(latest.usage?.repairCalls).toBe(1);
		} finally {
			await teardown(ctx);
		}
	});
});

describe("correctness boundaries (Wave A)", () => {
	it("rejects evidence dated after asOf, discarding the citing finding", async () => {
		const quote = "Acme Ltd filed accounts for the year ending March 2025 on time.";
		const url = "https://find-and-update.company-information.service.gov.uk/company/9";
		const ctx = setupApp({
			brief: {
				summary: "One finding.",
				findings: [
					{
						claim: quote,
						category: "registry",
						whyItMatters: "Context for the application.",
						allegationStatus: "unknown",
						entityMatch: {
							identifierType: "name_city",
							value: "Acme Ltd, Leeds",
							confidence: "medium",
						},
						evidenceLocalIds: ["ev-1"],
					},
				],
				evidence: [
					{
						localId: "ev-1",
						url,
						title: "Filings",
						publisher: "Companies House",
						publishedAt: "2026-02-01",
						quote,
					},
				],
				contradictions: [],
				unknowns: [],
				questionsForOfficer: [],
			},
			fetched: [
				{
					requestedUrl: url,
					returnedUrl: url,
					title: "Filings",
					searchPublishedDate: null,
					rawContent: `Published 2026-02-01.\n${quote}\nfooter`,
				},
			],
		});
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId, officer);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.evidence).toHaveLength(0);
			expect(latest.findings).toHaveLength(0);
			expect(latest.validation?.discarded).toHaveLength(1);
			expect(latest.brief?.summary).toBe("No supported findings remained after validation.");
		} finally {
			await teardown(ctx);
		}
	});

	it("drops evidence redirected to another registrable domain, citation_valid < 1", async () => {
		const quote = "Acme Ltd filed accounts for the year ending March 2025 on time.";
		const requestedUrl = "https://find-and-update.company-information.service.gov.uk/company/9";
		const returnedUrl = "https://acme-mirror.example.com/company/9";
		const ctx = setupApp({
			brief: {
				summary: "One finding.",
				findings: [
					{
						claim: quote,
						category: "registry",
						whyItMatters: "Context for the application.",
						allegationStatus: "unknown",
						entityMatch: {
							identifierType: "name_city",
							value: "Acme Ltd, Leeds",
							confidence: "medium",
						},
						evidenceLocalIds: ["ev-1"],
					},
				],
				evidence: [
					{
						localId: "ev-1",
						url: requestedUrl,
						title: "Filings",
						publisher: "Companies House",
						publishedAt: null,
						quote,
					},
				],
				contradictions: [],
				unknowns: [],
				questionsForOfficer: [],
			},
			fetched: [
				{
					requestedUrl,
					returnedUrl,
					title: "Filings",
					searchPublishedDate: null,
					rawContent: `page\n${quote}\nmore`,
				},
			],
		});
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId, officer);
			// The redirect left the allowlist: evidence dropped, the citing
			// finding discarded, and the citation score reflects the drop.
			expect(latest.run.status).toBe("succeeded");
			expect(latest.evidence).toHaveLength(0);
			expect(latest.findings).toHaveLength(0);
			expect(latest.validation?.scores.citation_valid).toBeLessThan(1);
		} finally {
			await teardown(ctx);
		}
	});

	it("drops evidence whose final URL is private, citation_valid < 1", async () => {
		const quote = "Acme Ltd filed accounts for the year ending March 2025 on time.";
		const url = "http://10.0.0.5/x";
		const ctx = setupApp({
			brief: {
				summary: "One finding.",
				findings: [
					{
						claim: quote,
						category: "registry",
						whyItMatters: "Context for the application.",
						allegationStatus: "unknown",
						entityMatch: {
							identifierType: "name_city",
							value: "Acme Ltd, Leeds",
							confidence: "medium",
						},
						evidenceLocalIds: ["ev-1"],
					},
				],
				evidence: [
					{
						localId: "ev-1",
						url,
						title: "Filings",
						publisher: "Companies House",
						publishedAt: null,
						quote,
					},
				],
				contradictions: [],
				unknowns: [],
				questionsForOfficer: [],
			},
			fetched: [
				{
					requestedUrl: url,
					returnedUrl: url,
					title: "Filings",
					searchPublishedDate: null,
					rawContent: `page\n${quote}\nmore`,
				},
			],
		});
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId, officer);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.evidence).toHaveLength(0);
			expect(latest.findings).toHaveLength(0);
			expect(latest.validation?.scores.citation_valid).toBeLessThan(1);
		} finally {
			await teardown(ctx);
		}
	});

	it("maps ModelUnavailableError to model_unavailable and missing keys to config_error", async () => {
		for (const [err, code] of [
			[new ModelUnavailableError("boom"), "model_unavailable"],
			[new ModelUnavailableError("model is not configured"), "config_error"],
			[new TavilyError("search is not configured"), "config_error"],
			[new TavilyError("tool budget exceeded"), "tool_error"],
		] as Array<[Error, string]>) {
			const use = successFixture();
			const ctx = setupApp(use, {
				runner: stubAgentRunner({ brief: use.brief, fetched: use.fetched, throw: err }),
			});
			try {
				const officer = user("officer");
				const facts = caseFacts();
				await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
				const latest = await waitLatest(ctx, facts.applicationId, officer);
				expect(latest.run.status).toBe("failed");
				expect(latest.run.errorCode).toBe(code);
			} finally {
				await teardown(ctx);
			}
		}
	});

	it("discards common-name individual adverse-media (name_only) with an explicit reason", async () => {
		const quote = "John Smith was convicted of fraud in 2021, the gazette notes.";
		const url = "https://www.bbc.co.uk/news/common-name-case";
		const ctx = setupApp({
			brief: {
				summary: "One adverse finding.",
				findings: [
					{
						claim: "John Smith was convicted of fraud in 2021.",
						category: "adverse_media",
						whyItMatters: "Context for the application.",
						allegationStatus: "convicted",
						entityMatch: { identifierType: "name_only", value: "John Smith", confidence: "high" },
						evidenceLocalIds: ["ev-1"],
					},
				],
				evidence: [
					{ localId: "ev-1", url, title: "News", publisher: "BBC", publishedAt: null, quote },
				],
				contradictions: [],
				unknowns: [],
				questionsForOfficer: [],
			},
			fetched: [
				{
					requestedUrl: url,
					returnedUrl: url,
					title: "News",
					searchPublishedDate: null,
					rawContent: `page\n${quote}\nmore`,
				},
			],
		});
		try {
			const officer = user("officer");
			const facts = caseFacts({
				companyName: null,
				registrationNumber: null,
				applicantName: "John Smith",
			});
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId, officer);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.findings).toHaveLength(0);
			expect(latest.validation?.discarded[0].reason).toMatch(/name_only/);
			expect(JSON.stringify(latest.validation)).not.toContain("John Smith was convicted");
		} finally {
			await teardown(ctx);
		}
	});

	it("caps single-source SME adverse-media at low with a limitation note", async () => {
		const quote = "Acme Ltd was fined for a filing breach, the paper reports.";
		const url = "https://www.bbc.co.uk/news/sme-adverse-case";
		const ctx = setupApp({
			brief: {
				summary: "One adverse finding.",
				findings: [
					{
						claim: "Acme Ltd was fined for a filing breach.",
						category: "adverse_media",
						whyItMatters: "Context for the application.",
						allegationStatus: "unknown",
						entityMatch: {
							identifierType: "name_city",
							value: "Acme Ltd, Leeds",
							confidence: "medium",
						},
						evidenceLocalIds: ["ev-1"],
					},
				],
				evidence: [
					{ localId: "ev-1", url, title: "News", publisher: "BBC", publishedAt: null, quote },
				],
				contradictions: [],
				unknowns: [],
				questionsForOfficer: [],
			},
			fetched: [
				{
					requestedUrl: url,
					returnedUrl: url,
					title: "News",
					searchPublishedDate: null,
					rawContent: `page\n${quote}\nmore`,
				},
			],
		});
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId, officer);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.findings).toHaveLength(1);
			const rows = await ctx.db
				.select({ confidence: agentFindings.confidence })
				.from(agentFindings)
				.where(
					inArray(
						agentFindings.id,
						latest.findings.map((f) => f.id),
					),
				);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.confidence).toBe("low");
			expect(latest.brief?.unknowns.join(" ")).toMatch(/single-source adverse/);
		} finally {
			await teardown(ctx);
		}
	});
	it("drops a finding whose judge claims supported without a span", async () => {
		const use = successFixture();
		const spanless: SupportJudge = async () => ({ verdict: "supported", span: null });
		const ctx = setupApp(use, { judge: spanless });
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId, officer);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.findings).toHaveLength(0);
			expect(latest.validation?.unsupportedClaims).toBe(2);
		} finally {
			await teardown(ctx);
		}
	});

	it("keeps an official fraud-record quote carrying a protected term", async () => {
		// The quote carries a protected term (diabetes) inside a genuine
		// fraud record: the exception keeps it on an official source.
		const quote =
			"The filing notes Acme Ltd's director disclosed diabetes treatment before Acme was convicted of fraud in 2021.";
		const url = "https://find-and-update.company-information.service.gov.uk/company/9";
		const ctx = setupApp({
			brief: {
				summary: "One registry finding.",
				findings: [
					{
						claim: "Acme Ltd was convicted of fraud in 2021.",
						category: "registry",
						whyItMatters: "Context for the application.",
						allegationStatus: "convicted",
						entityMatch: {
							identifierType: "name_city",
							value: "Acme Ltd, Leeds",
							confidence: "medium",
						},
						evidenceLocalIds: ["ev-1"],
					},
				],
				evidence: [
					{
						localId: "ev-1",
						url,
						title: "Filing",
						publisher: "Companies House",
						publishedAt: null,
						quote,
					},
				],
				contradictions: [],
				unknowns: [],
				questionsForOfficer: [],
			},
			fetched: [
				{
					requestedUrl: url,
					returnedUrl: url,
					title: "Filing",
					searchPublishedDate: null,
					rawContent: `page\n${quote}\nmore`,
				},
			],
		});
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId, officer);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.evidence).toHaveLength(1);
			expect(latest.findings).toHaveLength(1);
		} finally {
			await teardown(ctx);
		}
	});

	it("drops the same protected quote on a non-official source", async () => {
		// Identical protected term + fraud text, but a news tier cannot
		// invoke the fraud-record exception: the quote is quarantined and
		// the citing finding is discarded with zero persisted rows.
		const quote =
			"The filing notes Acme Ltd's director disclosed diabetes treatment before Acme was convicted of fraud in 2021.";
		const url = "https://www.bbc.co.uk/news/protected-quote-case";
		const ctx = setupApp({
			brief: {
				summary: "One registry finding.",
				findings: [
					{
						claim: "Acme Ltd was convicted of fraud in 2021.",
						category: "registry",
						whyItMatters: "Context for the application.",
						allegationStatus: "convicted",
						entityMatch: {
							identifierType: "name_city",
							value: "Acme Ltd, Leeds",
							confidence: "medium",
						},
						evidenceLocalIds: ["ev-1"],
					},
				],
				evidence: [
					{
						localId: "ev-1",
						url,
						title: "News",
						publisher: "BBC",
						publishedAt: null,
						quote,
					},
				],
				contradictions: [],
				unknowns: [],
				questionsForOfficer: [],
			},
			fetched: [
				{
					requestedUrl: url,
					returnedUrl: url,
					title: "News",
					searchPublishedDate: null,
					rawContent: `page\n${quote}\nmore`,
				},
			],
		});
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId, officer);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.evidence).toHaveLength(0);
			expect(latest.findings).toHaveLength(0);
			expect(latest.brief?.summary).toBe("No supported findings remained after validation.");
			expect(latest.validation?.scores.pii_leak).toBe(1);
		} finally {
			await teardown(ctx);
		}
	});

	it("drops dirty unknowns without a repair call instead of failing the run", async () => {
		const use = successFixture();
		const brief = use.brief as Record<string, unknown>;
		const repair = stubLanguageRepair();
		const ctx = setupApp(
			{
				brief: {
					...brief,
					unknowns: ["No adverse media found, but the loan terms need review."],
				},
				fetched: use.fetched,
			},
			{ repair },
		);
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId, officer);
			expect(latest.run.status).toBe("succeeded");
			// Summary/findings are clean: no repair call is spent on
			// droppable non-findings.
			expect(repair.calls).toBe(0);
			expect(latest.usage?.repairCalls).toBe(0);
			expect(latest.findings).toHaveLength(2);
			expect(JSON.stringify(latest.brief)).not.toMatch(/loan terms/);
		} finally {
			await teardown(ctx);
		}
	});

	it("a repair transport failure cannot fail a run with only dirty non-findings", async () => {
		const use = successFixture();
		const brief = use.brief as Record<string, unknown>;
		const repair = stubLanguageRepair({ throw: new Error("connection refused") });
		const ctx = setupApp(
			{
				brief: {
					...brief,
					unknowns: ["No adverse media found, but the loan terms need review."],
					questionsForOfficer: ["Should we approve this application?"],
				},
				fetched: use.fetched,
			},
			{ repair },
		);
		try {
			const officer = user("officer");
			const facts = caseFacts();
			await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts));
			const latest = await waitLatest(ctx, facts.applicationId, officer);
			expect(latest.run.status).toBe("succeeded");
			expect(repair.calls).toBe(0);
			expect(latest.findings).toHaveLength(2);
			expect(JSON.stringify(latest.brief)).not.toMatch(/loan terms|approve/);
		} finally {
			await teardown(ctx);
		}
	});
});

describe("T00 sensitive research access control and audit", () => {
	it("ensure claims access idempotently; concurrent first claims collapse to one grant", async () => {
		const ctx = setupApp();
		try {
			const officer = user("officer");
			const facts = caseFacts();
			const first = await post(
				ctx,
				"/internal/research/runs/ensure",
				officer,
				ensurePayload(facts),
			);
			expect(first.status).toBe(202);
			const second = await post(
				ctx,
				"/internal/research/runs/ensure",
				officer,
				ensurePayload(facts),
			);
			expect(second.status).toBe(202);
			const grants = await ctx.db
				.select()
				.from(researchAccessGrants)
				.where(eq(researchAccessGrants.applicationId, facts.applicationId));
			const active = grants.filter((g) => g.revokedAt === null);
			expect(active).toHaveLength(1);
			expect(active[0]?.userId).toBe(officer.id);
			expect(active[0]?.accessRole).toBe("assigned_officer");
			expect(active[0]?.grantedBy).toBe(officer.id);

			// Concurrent first claims on a fresh case serialize on the
			// advisory lock: exactly one wins, no duplicate rows.
			const fresh = caseFacts();
			const outcomes = await Promise.all(
				Array.from({ length: 5 }, () =>
					claimOfficerAccess(ctx.db, fresh.applicationId, officer.id),
				),
			);
			expect(outcomes.filter((o) => o.claimed)).toHaveLength(1);
			const freshGrants = await ctx.db
				.select({ id: researchAccessGrants.id })
				.from(researchAccessGrants)
				.where(eq(researchAccessGrants.applicationId, fresh.applicationId));
			expect(freshGrants).toHaveLength(1);
		} finally {
			await teardown(ctx);
		}
	});

	it("a second officer gets 404 on ensure/latest/view/finding/bundle; applicants get 403", async () => {
		const ctx = setupApp();
		try {
			const facts = caseFacts();
			const { runId, findings, officer } = await settledRun(ctx, facts);
			const other = user("officer");

			const ensure = await post(ctx, "/internal/research/runs/ensure", other, ensurePayload(facts));
			expect(ensure.status).toBe(404);
			expect(
				(await get(ctx, `/internal/research/applications/${facts.applicationId}/latest`, other))
					.status,
			).toBe(404);
			expect(
				(
					await post(
						ctx,
						`/internal/research/applications/${facts.applicationId}/runs/${runId}/view`,
						other,
						{},
					)
				).status,
			).toBe(404);
			expect(
				(
					await post(
						ctx,
						`/internal/research/applications/${facts.applicationId}/findings/${findings[0].id}/review`,
						other,
						{ action: "accepted" },
					)
				).status,
			).toBe(404);
			expect(
				(
					await get(
						ctx,
						`/internal/research/applications/${facts.applicationId}/runs/${runId}/bundle`,
						other,
					)
				).status,
			).toBe(404);

			// Role denial stays 403 (checked before access), never 404.
			expect(
				(await get(ctx, `/internal/research/applications/${facts.applicationId}/latest`, APPLICANT))
					.status,
			).toBe(403);
			// The owning officer is unaffected by the denial.
			expect(
				(await get(ctx, `/internal/research/applications/${facts.applicationId}/latest`, officer))
					.status,
			).toBe(200);
		} finally {
			await teardown(ctx);
		}
	});

	it("service grants/revokes across the role matrix; officer/applicant get 403", async () => {
		const ctx = setupApp();
		try {
			const service = user("service");
			const officer = user("officer");
			const applicant = user("applicant");
			const facts = caseFacts();
			const { officer: owner } = await settledRun(ctx, facts);
			const grantPath = `/internal/research/applications/${facts.applicationId}/access/grants`;
			const revokePath = `/internal/research/applications/${facts.applicationId}/access/revoke`;

			// Unsigned service calls are 401, like every internal route.
			const unsigned = await ctx.app.request(grantPath, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ userId: officer.id, accessRole: "compliance" }),
			});
			expect(unsigned.status).toBe(401);

			// Officers and applicants cannot manage access.
			for (const who of [owner, officer, applicant]) {
				const denied = await post(ctx, grantPath, who, {
					userId: officer.id,
					accessRole: "compliance",
				});
				expect(denied.status).toBe(403);
				const deniedRevoke = await post(ctx, revokePath, who, { userId: officer.id });
				expect(deniedRevoke.status).toBe(403);
			}

			// Strict body: unknown roles and bad ids are 422, bad app ids 404.
			for (const body of [
				{ userId: officer.id, accessRole: "super_officer" },
				{ userId: "not-a-uuid", accessRole: "compliance" },
				{ accessRole: "compliance" },
				{},
			]) {
				expect((await post(ctx, grantPath, service, body)).status).toBe(422);
			}
			expect(
				(
					await post(ctx, `/internal/research/applications/not-a-uuid/access/grants`, service, {
						userId: officer.id,
						accessRole: "compliance",
					})
				).status,
			).toBe(404);

			// Every matrix role grants read access.
			const holders = new Map<string, TestUser>();
			for (const accessRole of [
				"assigned_officer",
				"compliance",
				"policy_owner",
				"safeguarding",
			] as const) {
				const holder = user("officer");
				holders.set(accessRole, holder);
				const granted = await post(ctx, grantPath, service, {
					userId: holder.id,
					accessRole,
				});
				expect(granted.status).toBe(201);
				const body = (await granted.json()) as {
					grant: { userId: string; accessRole: string; revokedAt: null };
				};
				expect(body.grant.userId).toBe(holder.id);
				expect(body.grant.accessRole).toBe(accessRole);
				expect(
					(await get(ctx, `/internal/research/applications/${facts.applicationId}/latest`, holder))
						.status,
				).toBe(200);
			}

			// Revoke removes access; revoking again (or a stranger) is 404.
			const compliance = holders.get("compliance") as TestUser;
			expect((await post(ctx, revokePath, service, { userId: compliance.id })).status).toBe(200);
			expect(
				(
					await get(
						ctx,
						`/internal/research/applications/${facts.applicationId}/latest`,
						compliance,
					)
				).status,
			).toBe(404);
			expect((await post(ctx, revokePath, service, { userId: compliance.id })).status).toBe(404);
			expect((await post(ctx, revokePath, service, { userId: randomUUID() })).status).toBe(404);

			// A revoked holder may be granted again.
			expect(
				(await post(ctx, grantPath, service, { userId: compliance.id, accessRole: "compliance" }))
					.status,
			).toBe(201);
			expect(
				(
					await get(
						ctx,
						`/internal/research/applications/${facts.applicationId}/latest`,
						compliance,
					)
				).status,
			).toBe(200);
		} finally {
			await teardown(ctx);
		}
	});

	it("every read/write appends audit rows with ids and codes, never PII", async () => {
		const ctx = setupApp();
		try {
			const service = user("service");
			const facts = caseFacts();
			const { runId, findings, officer } = await settledRun(ctx, facts);
			const appPath = `/internal/research/applications/${facts.applicationId}`;
			await get(ctx, `${appPath}/latest`, officer);
			await post(ctx, `${appPath}/runs/${runId}/view`, officer, {});
			await post(ctx, `${appPath}/findings/${findings[0].id}/review`, officer, {
				action: "accepted",
			});
			await get(ctx, `${appPath}/runs/${runId}/bundle`, officer);
			// A denied cross-officer probe is audited too.
			const probe = await get(ctx, `${appPath}/latest`, user("officer"));
			expect(probe.status).toBe(404);
			// A service grant/revoke round-trip is audited.
			const specialist = user("officer");
			await post(ctx, `${appPath}/access/grants`, service, {
				userId: specialist.id,
				accessRole: "safeguarding",
			});
			await post(ctx, `${appPath}/access/revoke`, service, { userId: specialist.id });

			const rows = await ctx.db
				.select()
				.from(researchAuditLog)
				.where(eq(researchAuditLog.applicationId, facts.applicationId));
			const actions = rows.map((r) => r.action);
			for (const expected of [
				"access.claim",
				"run.ensure",
				"run.read",
				"run.view",
				"finding.review",
				"bundle.read",
				"access.denied",
				"access.grant",
				"access.revoke",
			]) {
				expect(actions).toContain(expected);
			}
			// Append-only: more reads only add rows, and run-scoped reads
			// carry the run id.
			expect(rows.length).toBeGreaterThanOrEqual(9);
			expect(rows.filter((r) => r.runId === runId).map((r) => r.action)).toContain("bundle.read");
			const dump = JSON.stringify(rows);
			for (const pii of [
				"Jane Doe",
				"Acme Ltd",
				"Leeds",
				"filed accounts",
				"officer@example.com",
				"applicant@example.com",
			]) {
				expect(dump).not.toContain(pii);
			}
		} finally {
			await teardown(ctx);
		}
	});

	it("a revoked officer cannot self-claim; only a service re-grant restores access", async () => {
		const ctx = setupApp();
		try {
			const service = user("service");
			const facts = caseFacts();
			const { officer } = await settledRun(ctx, facts);
			const appPath = `/internal/research/applications/${facts.applicationId}`;

			expect(
				(await post(ctx, `${appPath}/access/revoke`, service, { userId: officer.id })).status,
			).toBe(200);

			// Self-claim is denied (audited), not re-inserted.
			expect(
				(await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts))).status,
			).toBe(404);
			expect((await get(ctx, `${appPath}/latest`, officer)).status).toBe(404);
			const denials = (
				await ctx.db
					.select()
					.from(researchAuditLog)
					.where(eq(researchAuditLog.applicationId, facts.applicationId))
			).filter((r) => r.action === "access.denied" && r.actorId === officer.id);
			expect(denials.length).toBeGreaterThanOrEqual(1);
			const grants = await ctx.db
				.select()
				.from(researchAccessGrants)
				.where(eq(researchAccessGrants.applicationId, facts.applicationId));
			expect(grants.filter((g) => g.revokedAt === null)).toHaveLength(0);

			// Only the service grant path restores access.
			expect(
				(
					await post(ctx, `${appPath}/access/grants`, service, {
						userId: officer.id,
						accessRole: "assigned_officer",
					})
				).status,
			).toBe(201);
			expect((await get(ctx, `${appPath}/latest`, officer)).status).toBe(200);
		} finally {
			await teardown(ctx);
		}
	});

	it("specialist grants are additive: a grant before first claim never blocks the officer", async () => {
		const ctx = setupApp();
		try {
			const service = user("service");
			const specialist = user("officer");
			const facts = caseFacts();
			const appPath = `/internal/research/applications/${facts.applicationId}`;

			// Specialist grant lands before any officer has claimed the case.
			expect(
				(
					await post(ctx, `${appPath}/access/grants`, service, {
						userId: specialist.id,
						accessRole: "compliance",
					})
				).status,
			).toBe(201);

			// A specialist-only holder cannot ensure: denied (audited 404),
			// grant unchanged, no officer row inserted.
			await expect(
				claimOfficerAccess(ctx.db, facts.applicationId, specialist.id),
			).rejects.toMatchObject({ status: 404 });
			const earlyGrants = await ctx.db
				.select()
				.from(researchAccessGrants)
				.where(eq(researchAccessGrants.applicationId, facts.applicationId));
			const earlyLive = earlyGrants.filter((g) => g.revokedAt === null);
			expect(earlyLive).toHaveLength(1);
			expect(earlyLive[0]?.userId).toBe(specialist.id);
			expect(earlyLive[0]?.accessRole).toBe("compliance");

			// The first officer still claims the case (not a 404): a
			// specialist-only grant never makes it unclaimable.
			const officer = user("officer");
			const ensured = await post(
				ctx,
				"/internal/research/runs/ensure",
				officer,
				ensurePayload(facts),
			);
			expect(ensured.status).toBe(202);
			expect(((await ensured.json()) as { inserted: boolean }).inserted).toBe(true);

			// Both the owner and the specialist read; a stranger gets 404.
			expect((await get(ctx, `${appPath}/latest`, officer)).status).toBe(200);
			expect((await get(ctx, `${appPath}/latest`, specialist)).status).toBe(200);
			expect((await get(ctx, `${appPath}/latest`, user("officer"))).status).toBe(404);

			// Once the officer owns the case, the specialist's own claim is
			// still denied (audited 404, no officer row, no conversion) —
			// while their specialist grant keeps working for reads.
			await expect(
				claimOfficerAccess(ctx.db, facts.applicationId, specialist.id),
			).rejects.toMatchObject({ status: 404 });
			expect((await get(ctx, `${appPath}/latest`, specialist)).status).toBe(200);
			const grants = await ctx.db
				.select()
				.from(researchAccessGrants)
				.where(eq(researchAccessGrants.applicationId, facts.applicationId));
			const live = grants.filter((g) => g.revokedAt === null);
			expect(live).toHaveLength(2);
			expect(live.find((g) => g.userId === specialist.id)?.accessRole).toBe("compliance");
			expect(live.find((g) => g.userId === officer.id)?.accessRole).toBe("assigned_officer");
		} finally {
			await teardown(ctx);
		}
	});

	it("specialists cannot ensure: 404 with an audited denial, owner and co-owner unaffected", async () => {
		const ctx = setupApp();
		try {
			const service = user("service");
			const facts = caseFacts();
			const { officer } = await settledRun(ctx, facts);
			const appPath = `/internal/research/applications/${facts.applicationId}`;

			// Every specialist role is denied on ensure — only an active
			// `assigned_officer` grant authorizes it.
			for (const accessRole of ["compliance", "policy_owner", "safeguarding"] as const) {
				const specialist = user("officer");
				expect(
					(
						await post(ctx, `${appPath}/access/grants`, service, {
							userId: specialist.id,
							accessRole,
						})
					).status,
				).toBe(201);
				expect(
					(await post(ctx, "/internal/research/runs/ensure", specialist, ensurePayload(facts)))
						.status,
				).toBe(404);
				// The denial is audited; the specialist grant is unchanged
				// (no officer row, no conversion, no revocation).
				const denials = (
					await ctx.db
						.select()
						.from(researchAuditLog)
						.where(eq(researchAuditLog.applicationId, facts.applicationId))
				).filter((r) => r.action === "access.denied" && r.actorId === specialist.id);
				expect(denials.length).toBeGreaterThanOrEqual(1);
				const grants = await ctx.db
					.select()
					.from(researchAccessGrants)
					.where(eq(researchAccessGrants.applicationId, facts.applicationId));
				expect(
					grants
						.filter((g) => g.userId === specialist.id && g.revokedAt === null)
						.map((g) => g.accessRole),
				).toEqual([accessRole]);
				// Reads still pass for the denied specialist.
				expect((await get(ctx, `${appPath}/latest`, specialist)).status).toBe(200);
			}

			// The owner re-ensures idempotently; a service-granted co-owner
			// (second active `assigned_officer`) ensures too — never blocked
			// by the first.
			expect(
				(await post(ctx, "/internal/research/runs/ensure", officer, ensurePayload(facts))).status,
			).toBe(202);
			const coOwner = user("officer");
			expect(
				(
					await post(ctx, `${appPath}/access/grants`, service, {
						userId: coOwner.id,
						accessRole: "assigned_officer",
					})
				).status,
			).toBe(201);
			expect(
				(await post(ctx, "/internal/research/runs/ensure", coOwner, ensurePayload(facts))).status,
			).toBe(202);
			expect((await get(ctx, `${appPath}/latest`, coOwner)).status).toBe(200);
		} finally {
			await teardown(ctx);
		}
	});

	it("specialists keep read access across latest/view/bundle/audit", async () => {
		const ctx = setupApp();
		try {
			const service = user("service");
			const facts = caseFacts();
			const { runId, findings, officer } = await settledRun(ctx, facts);
			const appPath = `/internal/research/applications/${facts.applicationId}`;
			// Owner accepts one finding so a bundle exists.
			expect(
				(
					await post(ctx, `${appPath}/findings/${findings[0].id}/review`, officer, {
						action: "accepted",
					})
				).status,
			).toBe(201);

			const specialist = user("officer");
			expect(
				(
					await post(ctx, `${appPath}/access/grants`, service, {
						userId: specialist.id,
						accessRole: "compliance",
					})
				).status,
			).toBe(201);

			expect((await get(ctx, `${appPath}/latest`, specialist)).status).toBe(200);
			expect((await post(ctx, `${appPath}/runs/${runId}/view`, specialist, {})).status).toBe(200);
			expect((await get(ctx, `${appPath}/runs/${runId}/bundle`, specialist)).status).toBe(200);
			// No auto history on this case: empty entries, no claim, still 200.
			const audit = await get(ctx, `${appPath}/audit`, specialist);
			expect(audit.status).toBe(200);
			expect(await audit.json()).toEqual({ applicationId: facts.applicationId, entries: [] });
		} finally {
			await teardown(ctx);
		}
	});
});
