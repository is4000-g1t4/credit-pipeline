// T18 context stage integration (D3b): real credit_research Postgres, fake
// external agent + fake context runner + fake consent probe — no model,
// Tavily, Grafana, applications, or Kafka network.
import { randomUUID } from "node:crypto";
import {
	agentRuns,
	contextSignalReviews,
	contextSignals,
	researchAuditLog,
} from "@credit/db/research";
import { createLogger } from "@credit/service-kit";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
	ContextToolError,
	type CandidateSnapshot,
	stubContextRunner,
} from "../../src/agents/context-analyst/index.js";
import {
	claimContextRetry,
	claimContextStage,
	claimRun,
	ensureRun,
	finalizeFailure,
	getRun,
	initContextStage,
	persistContextFailure,
	persistContextSuccess,
	runLeaseMs,
	type CaseFactsPayload,
} from "../../src/lifecycle.js";
import { failResearchRun, RESEARCH_RUN_KIND, runAgentAttempt } from "../../src/agent-run.js";
import {
	stubAgentRunner,
	stubLanguageRepair,
	stubSupportJudge,
	TavilyError,
} from "../../src/agents/case-brief/index.js";
import {
	handleReviewRequested,
	type AutoTriggerDeps,
	type ResearchContextResult,
} from "../../src/auto-trigger.js";
import { loadEnv } from "../../src/env.js";
import {
	caseFacts,
	degradedObservability,
	get,
	post,
	setupApp,
	successFixture,
	teardown,
	user,
	waitRun,
	type TestContext,
	type TestUser,
} from "../helper.js";
import { candidateSnapshot, seenEvidence } from "../fixtures.js";

process.env.LOG_LEVEL ??= "silent";
const testLogger = createLogger("research-context-test");

function contextSnapshots(): CandidateSnapshot[] {
	return [candidateSnapshot()];
}

function contextSeen(): Map<string, Set<string>> {
	return seenEvidence();
}

function contextOutput(): Record<string, unknown> {
	return {
		claims: [
			{
				text: "The account showed 3 end-of-day negative balances over the window.",
				signalRefs: [0],
			},
		],
		signals: [
			{
				type: "negative_balance",
				periodStart: "2025-12-30",
				periodEnd: "2026-01-15",
				metric: "negative_eod_days",
				observed: 3,
				expected: 0,
				evidence: [{ kind: "transaction", id: "tx-1" }],
				confidence: "high",
				status: "review",
				policyVersion: "context-metrics-v1",
				accountScope: "all",
				explanation: "Three end-of-day balances were negative.",
			},
		],
		dataGaps: [],
		limitations: [],
	};
}

/** setupApp with the T18 stage enabled and scripted context output. */
function setupContext(
	outputs: unknown[] = [contextOutput()],
	opts: {
		consent?: boolean;
		env?: Record<string, unknown>;
		throw?: Error;
		externalThrow?: Error;
	} = {},
) {
	const use = successFixture();
	const env = { contextEnabled: true };
	Object.assign(env, opts.env);
	return setupApp(use, {
		env,
		runner: opts.externalThrow
			? stubAgentRunner({ brief: null, fetched: [], throw: opts.externalThrow })
			: stubAgentRunner({ brief: use.brief, fetched: use.fetched }),
		contextRunner: stubContextRunner({
			outputs,
			snapshots: contextSnapshots(),
			seenEvidence: contextSeen(),
			throw: opts.throw,
		}),
		fetchContextConsent: async () => opts.consent ?? true,
	});
}

interface LatestContext {
	status: string;
	stageVersion: number;
	errorCode: string | null;
	brief: { summary: string } | null;
	validation: { signalCount: number } | null;
	usage: { costUsd: number } | null;
	signals: Array<{
		id: string;
		type: string;
		metric: string;
		observed: number | null;
		status: string;
		stageVersion: number;
		reviewStatus?: string;
		reviewedAt?: string | null;
	}>;
}

interface LatestResponse {
	run: { id: string; status: string; applicationId: string; errorCode: string | null };
	brief: { summary: string } | null;
	usage: { costUsd: number } | null;
	context: LatestContext;
}

/** Poll latest until the run AND its context stage are terminal. */
async function waitSettled(
	ctx: TestContext,
	applicationId: string,
	officer: TestUser,
): Promise<LatestResponse> {
	const deadline = Date.now() + 15_000;
	for (;;) {
		const res = await get(ctx, `/internal/research/applications/${applicationId}/latest`, officer);
		expect(res.status).toBe(200);
		const body = (await res.json()) as LatestResponse;
		const runTerminal = body.run.status === "succeeded" || body.run.status === "failed";
		const contextTerminal = body.context.status !== "queued" && body.context.status !== "running";
		if (runTerminal && contextTerminal) return body;
		if (Date.now() > deadline) {
			throw new Error(`run did not settle (run=${body.run.status} context=${body.context.status})`);
		}
		await new Promise((r) => setTimeout(r, 50));
	}
}

async function settledRun(
	ctx: TestContext,
	facts: CaseFactsPayload,
	officer?: TestUser,
): Promise<{ latest: LatestResponse; officer: TestUser }> {
	const who = officer ?? user("officer");
	const res = await post(ctx, "/internal/research/runs/ensure", who, {
		applicationId: facts.applicationId,
		caseFacts: { ...facts },
		aiResearchConsent: facts.aiResearchConsent,
	});
	expect(res.status).toBe(202);
	return { latest: await waitSettled(ctx, facts.applicationId, who), officer: who };
}

describe("context stage in executeRun", () => {
	it("runs context after external and exposes both in latest", async () => {
		const ctx = setupContext();
		try {
			const facts = caseFacts();
			const { latest } = await settledRun(ctx, facts);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.brief?.summary).toContain("Registry shows");
			expect(latest.context.status).toBe("succeeded");
			expect(latest.context.stageVersion).toBe(1);
			expect(latest.context.errorCode).toBe(null);
			expect(latest.context.brief?.summary).toContain("negative balances");
			expect(latest.context.signals).toHaveLength(1);
			expect(latest.context.signals[0]).toMatchObject({
				type: "negative_balance",
				metric: "negative_eod_days",
				observed: 3,
				status: "review",
				stageVersion: 1,
			});
			// Single ledger: combined spend plus context detail.
			expect(latest.usage?.costUsd).toBeGreaterThan(0);
			expect(latest.context.usage?.costUsd).toBeGreaterThan(0);
			expect(latest.usage?.costUsd).toBeGreaterThanOrEqual(latest.context.usage?.costUsd ?? 0);
			// Lease: inserted combined (external + context + grace), then
			// refreshed at stage claim (context + grace = 210s).
			const rows = await ctx.db.select().from(agentRuns).where(eq(agentRuns.id, latest.run.id));
			const leaseMs = rows[0].timeoutAt.getTime() - rows[0].createdAt.getTime();
			expect(leaseMs).toBeGreaterThan(205_000);
			expect(leaseMs).toBeLessThan(215_000);
			// The latest response carried stored context: audited as read.
			const reads = await ctx.db
				.select({ action: researchAuditLog.action })
				.from(researchAuditLog)
				.where(eq(researchAuditLog.runId, latest.run.id));
			expect(reads.map((a) => a.action)).toContain("context.read");
		} finally {
			await teardown(ctx);
		}
	});

	it("skips context without consent, external unaffected", async () => {
		const ctx = setupContext([contextOutput()], { consent: false });
		try {
			const facts = caseFacts();
			const { latest } = await settledRun(ctx, facts);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.brief?.summary).toContain("Registry shows");
			expect(latest.context.status).toBe("skipped");
			expect(latest.context.signals).toHaveLength(0);
		} finally {
			await teardown(ctx);
		}
	});

	it("marks not_applicable when the feature is off", async () => {
		const use = successFixture();
		const ctx = setupApp(use, { fetchContextConsent: async () => true });
		try {
			const facts = caseFacts();
			const officer = user("officer");
			await post(ctx, "/internal/research/runs/ensure", officer, {
				applicationId: facts.applicationId,
				caseFacts: { ...facts },
				aiResearchConsent: facts.aiResearchConsent,
			});
			const latest = await waitSettled(ctx, facts.applicationId, officer);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.context.status).toBe("not_applicable");
		} finally {
			await teardown(ctx);
		}
	});

	it("gates AGENTS_ENABLED for both stages", async () => {
		const ctx = setupContext([contextOutput()], { env: { agentsEnabled: false } });
		try {
			const facts = caseFacts();
			const { latest } = await settledRun(ctx, facts);
			expect(latest.run.status).toBe("failed");
			expect(latest.context.status).toBe("skipped");
		} finally {
			await teardown(ctx);
		}
	});

	it("keeps a valid external brief when context fails", async () => {
		const ctx = setupContext([], { throw: new ContextToolError("boom") });
		try {
			const facts = caseFacts();
			const { latest } = await settledRun(ctx, facts);
			// No partial enum: the run succeeds on its external result.
			expect(latest.run.status).toBe("succeeded");
			expect(latest.brief?.summary).toContain("Registry shows");
			expect(latest.context.status).toBe("failed");
			expect(latest.context.errorCode).toBe("tool_error");
			expect(latest.context.signals).toHaveLength(0);
		} finally {
			await teardown(ctx);
		}
	});

	it("persists context when external fails — no partial status", async () => {
		const ctx = setupContext([contextOutput()], { externalThrow: new TavilyError("down") });
		try {
			const facts = caseFacts();
			const { latest } = await settledRun(ctx, facts);
			expect(latest.run.status).toBe("failed");
			expect(latest.context.status).toBe("succeeded");
			expect(latest.context.brief?.summary).toContain("negative balances");
			expect(latest.context.signals).toHaveLength(1);
		} finally {
			await teardown(ctx);
		}
	});

	it("fails context on stage overage without discarding external", async () => {
		const ctx = setupContext([contextOutput()], { env: { contextMaxCostUsd: 0 } });
		try {
			const facts = caseFacts();
			const { latest } = await settledRun(ctx, facts);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.brief?.summary).toContain("Registry shows");
			expect(latest.context.status).toBe("failed");
			expect(latest.context.errorCode).toBe("cost_exceeded");
		} finally {
			await teardown(ctx);
		}
	});

	it("repairs once, then fails closed", async () => {
		const bad = { claims: [], signals: [{ bogus: true }] };
		const contextRunner = stubContextRunner({
			outputs: [bad, bad],
			snapshots: contextSnapshots(),
			seenEvidence: contextSeen(),
		});
		const use = successFixture();
		const ctx = setupApp(use, {
			env: { contextEnabled: true },
			contextRunner,
			fetchContextConsent: async () => true,
		});
		try {
			const facts = caseFacts();
			const { latest } = await settledRun(ctx, facts);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.context.status).toBe("failed");
			expect(latest.context.errorCode).toBe("validation_failed");
			expect(contextRunner.repairCalls).toBe(1);
		} finally {
			await teardown(ctx);
		}
	});

	it("succeeds empty when no candidate meets the evidence bar (no repair spent)", async () => {
		const contextRunner = stubContextRunner({
			outputs: [{ claims: [], signals: [], dataGaps: ["No accounts in scope."], limitations: [] }],
			snapshots: [],
			seenEvidence: new Map(),
		});
		const use = successFixture();
		const ctx = setupApp(use, {
			env: { contextEnabled: true },
			contextRunner,
			fetchContextConsent: async () => true,
		});
		try {
			const facts = caseFacts();
			const { latest } = await settledRun(ctx, facts);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.context.status).toBe("succeeded");
			expect(latest.context.signals).toHaveLength(0);
			// The explicit empty summary feeds the UI's "no signals met the
			// evidence bar" branch — reachable, never an all-clear.
			expect(latest.context.brief?.summary).toContain("No signals met the evidence bar");
			expect(contextRunner.repairCalls).toBe(0);
		} finally {
			await teardown(ctx);
		}
	});

	it("appends a server-authored stop gap when the model hits the tool-call limit", async () => {
		const contextRunner = stubContextRunner({
			outputs: [contextOutput()],
			snapshots: contextSnapshots(),
			seenEvidence: contextSeen(),
			modelBudgetExceeded: true,
			toolFailures: [{ tool: "get_loans", reason: "downstream 503" }],
		});
		const use = successFixture();
		const ctx = setupApp(use, {
			env: { contextEnabled: true },
			contextRunner,
			fetchContextConsent: async () => true,
		});
		try {
			const facts = caseFacts();
			const { latest } = await settledRun(ctx, facts);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.context.status).toBe("succeeded");
			const gaps =
				(latest.context.brief as unknown as { dataGaps?: string[] } | null)?.dataGaps ?? [];
			expect(gaps).toContain("Context investigation stopped at the tool-call limit.");
			// Officer-facing gaps carry the tool name only — the raw reason
			// is logged server-side, never exposed to the officer.
			expect(gaps).toContain("Context screen unavailable: get_loans");
			for (const gap of gaps) expect(gap).not.toContain("downstream 503");
		} finally {
			await teardown(ctx);
		}
	});
});

describe("context retry", () => {
	it("retries a failed stage on the same run without rerunning external", async () => {
		let calls = 0;
		const flaky = {
			calls: 0,
			repairCalls: 0,
			async runContext() {
				calls += 1;
				flaky.calls = calls;
				if (calls === 1) throw new ContextToolError("boom");
				return {
					output: contextOutput(),
					usage: { inputTokens: 50, outputTokens: 50, toolCalls: 3 },
					snapshots: contextSnapshots(),
					seenEvidence: contextSeen(),
					model: "test-context-model",
					toolFailures: [],
					modelBudgetExceeded: false,
				};
			},
			async repairContext() {
				return {
					output: contextOutput(),
					usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
				};
			},
		};
		const use = successFixture();
		const ctx = setupApp(use, {
			env: { contextEnabled: true },
			contextRunner: flaky,
			fetchContextConsent: async () => true,
		});
		try {
			const facts = caseFacts();
			const { latest, officer } = await settledRun(ctx, facts);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.context.status).toBe("failed");

			const retryPath = `/internal/research/applications/${facts.applicationId}/runs/${latest.run.id}/context/retry`;
			const retry = await post(ctx, retryPath, officer, {});
			expect(retry.status).toBe(202);
			const claimed = (await retry.json()) as {
				runId: string;
				contextStageToken: string;
				contextStageVersion: number;
			};
			expect(claimed.contextStageVersion).toBe(2);
			expect(claimed.contextStageToken).toMatch(/^[0-9a-f-]{36}$/);

			const after = await waitSettled(ctx, facts.applicationId, officer);
			expect(after.run.status).toBe("succeeded");
			expect(after.brief?.summary).toContain("Registry shows");
			expect(after.context.status).toBe("succeeded");
			expect(after.context.stageVersion).toBe(2);
			expect(after.context.signals).toHaveLength(1);
			expect(after.context.signals[0].stageVersion).toBe(2);
			expect(calls).toBe(2);

			// A succeeded stage cannot retry again.
			expect((await post(ctx, retryPath, officer, {})).status).toBe(409);
		} finally {
			await teardown(ctx);
		}
	});

	it("admits exactly one of two concurrent retries (no bypass)", async () => {
		const ctx = setupContext([], { throw: new ContextToolError("boom") });
		try {
			const facts = caseFacts();
			const { latest, officer } = await settledRun(ctx, facts);
			expect(latest.context.status).toBe("failed");
			const retryPath = `/internal/research/applications/${facts.applicationId}/runs/${latest.run.id}/context/retry`;
			const [first, second] = await Promise.all([
				post(ctx, retryPath, officer, {}),
				post(ctx, retryPath, officer, {}),
			]);
			expect([first.status, second.status].sort()).toEqual([202, 409]);
			const winner = first.status === 202 ? first : second;
			const claimed = (await winner.json()) as { contextStageVersion: number };
			expect(claimed.contextStageVersion).toBe(2);
		} finally {
			await teardown(ctx);
		}
	});

	it("blocks an auto-run retry on an exhausted current-day cost budget", async () => {
		const ctx = setupContext([], {
			throw: new ContextToolError("boom"),
			env: { autoTriggerDailyCostBudgetUsd: 0 },
		});
		try {
			const env = { ...loadEnv(), agentsEnabled: true, contextEnabled: true };
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
			const token = run.runToken as string;
			expect(await claimRun(ctx.db, run.id, token)).toBe(true);
			expect(await initContextStage(ctx.db, env, run.id, token, "queued")).toBe(true);
			const stageToken = await claimContextStage(ctx.db, env, run.id, token, {
				promptVersion: "context-v1",
				model: "test-context-model",
			});
			expect(stageToken).not.toBe(null);
			expect(await persistContextFailure(ctx.db, run.id, stageToken as string, "tool_error")).toBe(
				true,
			);
			expect(await finalizeFailure(ctx.db, run.id, token, "timeout", "timed out")).toBe(true);

			const officer = user("officer");
			const { claimOfficerAccess } = await import("../../src/access.js");
			await claimOfficerAccess(ctx.db, facts.applicationId, officer.id);
			const retryPath = `/internal/research/applications/${facts.applicationId}/runs/${run.id}/context/retry`;
			const retry = await post(ctx, retryPath, officer, {});
			expect(retry.status).toBe(409);
			expect(((await retry.json()) as { error: { code: string } }).error.code).toBe(
				"AUTO_CAP_EXCEEDED",
			);
			// Nothing claimed: the stage is still failed at version 1.
			const live = await getRun(ctx.db, run.id);
			expect(live?.contextStatus).toBe("failed");
			expect(live?.contextStageVersion).toBe(1);
			expect(live?.contextStageToken).toBe(null);
		} finally {
			await teardown(ctx);
		}
	});

	it("rejects unknown runs, non-terminal runs, and strangers", async () => {
		const ctx = setupContext();
		try {
			const stranger = user("officer");
			expect(
				(
					await post(
						ctx,
						`/internal/research/applications/${randomUUID()}/runs/${randomUUID()}/context/retry`,
						stranger,
						{},
					)
				).status,
			).toBe(404);

			// Queued run with a grant but no terminal outcome: 409, not 404.
			const env = { ...loadEnv(), agentsEnabled: true };
			const facts = caseFacts();
			const { run } = await ensureRun(ctx.db, env, {
				applicationId: facts.applicationId,
				requestedBy: randomUUID(),
				caseFacts: facts,
				aiResearchConsent: true,
			});
			const { claimOfficerAccess } = await import("../../src/access.js");
			await claimOfficerAccess(ctx.db, facts.applicationId, stranger.id);
			expect(
				(
					await post(
						ctx,
						`/internal/research/applications/${facts.applicationId}/runs/${run.id}/context/retry`,
						stranger,
						{},
					)
				).status,
			).toBe(409);
		} finally {
			await teardown(ctx);
		}
	});
});

describe("context stage lifecycle (DB)", () => {
	it("dedupes duplicate validated signals by unique key before insert", async () => {
		const ctx = setupContext();
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
			const one = {
				type: "negative_balance",
				periodStart: "2025-12-30",
				periodEnd: "2026-01-15",
				metric: "negative_eod_days",
				observed: 3,
				expected: 0,
				evidence: [{ kind: "transaction", id: "tx-1" }],
				confidence: "high" as const,
				status: "review" as const,
				policyVersion: "context-metrics-v1",
				accountScope: "all",
				explanation: "Three end-of-day balances were negative.",
			};
			expect(
				await persistContextSuccess(ctx.db, run.id, stageToken as string, {
					brief: { summary: "dupes" },
					validation: {},
					usage: {},
					signals: [one, { ...one }],
				}),
			).toBe(true);
			const rows = await ctx.db
				.select()
				.from(contextSignals)
				.where(and(eq(contextSignals.runId, run.id), sql`${contextSignals.supersededAt} IS NULL`));
			expect(rows).toHaveLength(1);
		} finally {
			await teardown(ctx);
		}
	});

	it("guards stage writes by token and failAgentRun fails stuck stages without touching the brief", async () => {
		const ctx = setupContext();
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
			// Combined insert lease: external + context + policy + grace, the
			// same budget as one Temporal attempt (runLeaseMs).
			const inserted = await getRun(ctx.db, run.id);
			const insertLease = inserted!.timeoutAt.getTime() - inserted!.createdAt.getTime();
			expect(insertLease).toBeGreaterThan(runLeaseMs(env) - 5_000);
			expect(insertLease).toBeLessThan(runLeaseMs(env) + 5_000);
			expect(await initContextStage(ctx.db, env, run.id, token, "queued")).toBe(true);
			const stageToken = await claimContextStage(ctx.db, env, run.id, token, {
				promptVersion: "context-v1",
				model: "test",
			});
			expect(stageToken).not.toBe(null);

			// Stale token writes nothing.
			expect(
				await persistContextSuccess(ctx.db, run.id, randomUUID(), {
					brief: {},
					validation: {},
					usage: {},
					signals: [],
				}),
			).toBe(false);

			// Temporal gave up (start-to-close timeout): failAgentRun fails the
			// run AND its running stage and clears the stage token.
			await failResearchRun(
				ctx.db,
				env,
				{ kind: RESEARCH_RUN_KIND, runId: run.id, token, timeoutMs: 300_000 },
				{ code: "timeout", message: "activity timeout" },
			);
			const reaped = await getRun(ctx.db, run.id);
			expect(reaped?.status).toBe("failed");
			expect(reaped?.contextStatus).toBe("failed");
			expect(reaped?.contextErrorCode).toBe("timeout");
			expect(reaped?.contextStageToken).toBe(null);
			expect(reaped?.brief).toBe(null);

			// Terminal run, failed stage: retry claims version 2 and persists.
			const retry = await claimContextRetry(ctx.db, env, run.id);
			expect(retry?.stageVersion).toBe(2);
			const persisted = await persistContextSuccess(ctx.db, run.id, retry!.stageToken, {
				brief: { summary: "retry brief" },
				validation: { validatorVersion: "context-v1" },
				usage: { costUsd: 0.001 },
				signals: [
					{
						type: "negative_balance",
						periodStart: "2025-12-30",
						periodEnd: "2026-01-15",
						metric: "negative_eod_days",
						observed: 3,
						expected: 0,
						evidence: [{ kind: "transaction", id: "tx-1" }],
						confidence: "high",
						status: "review",
						policyVersion: "context-metrics-v1",
						accountScope: "all",
						explanation: "Three end-of-day balances were negative.",
					},
				],
			});
			expect(persisted).toBe(true);
			const rows = await ctx.db
				.select()
				.from(contextSignals)
				.where(and(eq(contextSignals.runId, run.id), sql`${contextSignals.supersededAt} IS NULL`));
			expect(rows).toHaveLength(1);
			expect(rows[0].stageVersion).toBe(2);

			// No second retry once the stage succeeded.
			expect(await claimContextRetry(ctx.db, env, run.id)).toBe(null);
		} finally {
			await teardown(ctx);
		}
	});
});

describe("context signal review", () => {
	function signalPath(applicationId: string, signalId: string): string {
		return `/internal/research/applications/${applicationId}/context/signals/${signalId}/review`;
	}

	it("appends accept/dismiss; latest shows reviewStatus; 404 cross-case/unknown/stranger; 422 invalid", async () => {
		const ctx = setupContext();
		try {
			const facts = caseFacts();
			const { latest, officer } = await settledRun(ctx, facts);
			expect(latest.context.signals).toHaveLength(1);
			const [signal] = latest.context.signals;
			expect(signal).toMatchObject({ reviewStatus: "pending", reviewedAt: null });
			const path = signalPath(facts.applicationId, signal.id);

			const accept = await post(ctx, path, officer, { action: "accepted" });
			expect(accept.status).toBe(201);
			const accepted = (await accept.json()) as {
				id: string;
				signalId: string;
				action: string;
				signal: { id: string; reviewStatus: string };
			};
			expect(accepted.signalId).toBe(signal.id);
			expect(accepted.signal.reviewStatus).toBe("accepted");

			const seen = await waitSettled(ctx, facts.applicationId, officer);
			expect(seen.context.signals[0].reviewStatus).toBe("accepted");

			// Append-only: a dismiss adds a row and latest wins.
			const dismiss = await post(ctx, path, officer, {
				action: "rejected",
				note: "benign on review",
			});
			expect(dismiss.status).toBe(201);
			const rows = await ctx.db
				.select({ id: contextSignalReviews.id })
				.from(contextSignalReviews)
				.where(eq(contextSignalReviews.signalId, signal.id));
			expect(rows).toHaveLength(2);
			const relatest = await waitSettled(ctx, facts.applicationId, officer);
			expect(relatest.context.signals[0].reviewStatus).toBe("rejected");

			// Audited with ids/action only (no content).
			const audits = await ctx.db
				.select({ action: researchAuditLog.action })
				.from(researchAuditLog)
				.where(eq(researchAuditLog.runId, latest.run.id));
			expect(audits.map((a) => a.action)).toContain("context.signal_review");

			// Cross-case, unknown, and stranger reads are 404 (non-disclosure).
			expect(
				(await post(ctx, signalPath(randomUUID(), signal.id), officer, { action: "accepted" }))
					.status,
			).toBe(404);
			expect(
				(
					await post(ctx, signalPath(facts.applicationId, randomUUID()), officer, {
						action: "accepted",
					})
				).status,
			).toBe(404);
			expect((await post(ctx, path, user("officer"), { action: "accepted" })).status).toBe(404);
			expect((await post(ctx, path, officer, { action: "maybe" })).status).toBe(422);
		} finally {
			await teardown(ctx);
		}
	});

	it("409s a superseded signal after retry; the new stage reviews clean", async () => {
		let calls = 0;
		const flaky = {
			calls: 0,
			repairCalls: 0,
			async runContext() {
				calls += 1;
				flaky.calls = calls;
				if (calls === 1) throw new ContextToolError("boom");
				return {
					output: contextOutput(),
					usage: { inputTokens: 50, outputTokens: 50, toolCalls: 3 },
					snapshots: contextSnapshots(),
					seenEvidence: contextSeen(),
					model: "test-context-model",
					toolFailures: [],
					modelBudgetExceeded: false,
				};
			},
			async repairContext() {
				return {
					output: contextOutput(),
					usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
				};
			},
		};
		const use = successFixture();
		const ctx = setupApp(use, {
			env: { contextEnabled: true },
			contextRunner: flaky,
			fetchContextConsent: async () => true,
		});
		try {
			const facts = caseFacts();
			const { latest, officer } = await settledRun(ctx, facts);
			expect(latest.context.status).toBe("failed");
			expect(latest.context.signals).toHaveLength(0);

			// Seed a live v1 signal directly, then supersede it via retry.
			const [seeded] = await ctx.db
				.insert(contextSignals)
				.values({
					runId: latest.run.id,
					stageVersion: 1,
					accountScope: "all",
					type: "negative_balance",
					periodStart: "2025-12-30",
					periodEnd: "2026-01-15",
					metric: "negative_eod_days",
					observed: "3",
					expected: "0",
					confidence: "high",
					status: "review",
					policyVersion: "context-metrics-v1",
					explanation: "Seeded for the supersede check.",
					evidence: [{ kind: "transaction", id: "tx-1" }],
				})
				.returning({ id: contextSignals.id });
			const retryPath = `/internal/research/applications/${facts.applicationId}/runs/${latest.run.id}/context/retry`;
			expect((await post(ctx, retryPath, officer, {})).status).toBe(202);
			const after = await waitSettled(ctx, facts.applicationId, officer);
			expect(after.context.status).toBe("succeeded");

			// The v1 signal is superseded: review is 409, never resurrected.
			const stale = await post(ctx, signalPath(facts.applicationId, seeded.id), officer, {
				action: "accepted",
			});
			expect(stale.status).toBe(409);
			expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
				"SIGNAL_SUPERSEDED",
			);
			// The live v2 signal reviews clean.
			const [live] = after.context.signals;
			const ok = await post(ctx, signalPath(facts.applicationId, live.id), officer, {
				action: "accepted",
			});
			expect(ok.status).toBe(201);
		} finally {
			await teardown(ctx);
		}
	});

	it("rejects a review when consent is withdrawn between check and insert, audited", async () => {
		let consent = true;
		let flapOnce = false;
		const use = successFixture();
		const ctx = setupApp(use, {
			env: { contextEnabled: true },
			contextRunner: stubContextRunner({
				outputs: [contextOutput()],
				snapshots: contextSnapshots(),
				seenEvidence: contextSeen(),
			}),
			fetchContextConsent: async () => {
				// The review pre-check passes, then withdrawal lands before
				// the in-transaction recheck.
				if (flapOnce) {
					flapOnce = false;
					consent = false;
					return true;
				}
				return consent;
			},
		});
		try {
			const facts = caseFacts();
			const { latest, officer } = await settledRun(ctx, facts);
			expect(latest.context.signals).toHaveLength(1);
			const [signal] = latest.context.signals;

			flapOnce = true;
			const denied = await post(ctx, signalPath(facts.applicationId, signal.id), officer, {
				action: "accepted",
			});
			expect(denied.status).toBe(403);
			// No review row survived the abort.
			const rows = await ctx.db
				.select({ id: contextSignalReviews.id })
				.from(contextSignalReviews)
				.where(eq(contextSignalReviews.signalId, signal.id));
			expect(rows).toHaveLength(0);
			const audits = await ctx.db
				.select({ action: researchAuditLog.action })
				.from(researchAuditLog)
				.where(eq(researchAuditLog.runId, latest.run.id));
			expect(audits.map((a) => a.action)).toContain("context.denied");
			expect(audits.map((a) => a.action)).not.toContain("context.signal_review");
		} finally {
			await teardown(ctx);
		}
	});
});

describe("context consent withdrawal", () => {
	it("omits stored context from latest and rejects signal review/retry, audited", async () => {
		let consent = true;
		const use = successFixture();
		const ctx = setupApp(use, {
			env: { contextEnabled: true },
			contextRunner: stubContextRunner({
				outputs: [contextOutput()],
				snapshots: contextSnapshots(),
				seenEvidence: contextSeen(),
			}),
			fetchContextConsent: async () => consent,
		});
		try {
			const facts = caseFacts();
			const { latest, officer } = await settledRun(ctx, facts);
			expect(latest.context.status).toBe("succeeded");
			expect(latest.context.signals).toHaveLength(1);
			const [signal] = latest.context.signals;

			// Withdrawal: the external brief stays readable, stored context
			// does not — status metadata without content.
			consent = false;
			const gated = await get(
				ctx,
				`/internal/research/applications/${facts.applicationId}/latest`,
				officer,
			);
			expect(gated.status).toBe(200);
			const body = (await gated.json()) as LatestResponse;
			expect(body.run.status).toBe("succeeded");
			expect(body.brief?.summary).toContain("Registry shows");
			expect(body.context.status).toBe("succeeded");
			expect(body.context.brief).toBe(null);
			expect(body.context.validation).toBe(null);
			expect(body.context.signals).toHaveLength(0);

			const reviewPath = `/internal/research/applications/${facts.applicationId}/context/signals/${signal.id}/review`;
			const denied = await post(ctx, reviewPath, officer, { action: "accepted" });
			expect(denied.status).toBe(403);
			const retryPath = `/internal/research/applications/${facts.applicationId}/runs/${latest.run.id}/context/retry`;
			expect((await post(ctx, retryPath, officer, {})).status).toBe(403);

			const audits = await ctx.db
				.select({ action: researchAuditLog.action })
				.from(researchAuditLog)
				.where(eq(researchAuditLog.runId, latest.run.id));
			expect(audits.map((a) => a.action)).toContain("context.denied");
		} finally {
			await teardown(ctx);
		}
	});

	it("purges stored brief and supersedes signals over service HMAC", async () => {
		const ctx = setupContext();
		try {
			const facts = caseFacts();
			const { latest, officer } = await settledRun(ctx, facts);
			expect(latest.context.signals).toHaveLength(1);
			const [signal] = latest.context.signals;

			const purgePath = `/internal/research/applications/${facts.applicationId}/context/purge`;
			// Officers and applicants cannot purge — service only.
			expect((await post(ctx, purgePath, officer, {})).status).toBe(403);
			const purged = await post(ctx, purgePath, user("service"), {});
			expect(purged.status).toBe(200);
			expect(await purged.json()).toMatchObject({ purgedRuns: 1, purgedSignals: 1 });

			const after = await waitSettled(ctx, facts.applicationId, officer);
			expect(after.context.status).toBe("succeeded");
			expect(after.context.brief).toBe(null);
			expect(after.context.signals).toHaveLength(0);
			// The purged signal stays superseded history: review 409s.
			const stale = await post(
				ctx,
				`/internal/research/applications/${facts.applicationId}/context/signals/${signal.id}/review`,
				officer,
				{ action: "accepted" },
			);
			expect(stale.status).toBe(409);

			const audits = await ctx.db
				.select({ action: researchAuditLog.action })
				.from(researchAuditLog)
				.where(eq(researchAuditLog.applicationId, facts.applicationId));
			expect(audits.map((a) => a.action)).toContain("context.purge");
		} finally {
			await teardown(ctx);
		}
	});

	it("drops staged context when consent is withdrawn mid-stage (no persist)", async () => {
		let allowPersist = true;
		const inner = stubContextRunner({
			outputs: [contextOutput()],
			snapshots: contextSnapshots(),
			seenEvidence: contextSeen(),
		});
		const use = successFixture();
		const ctx = setupApp(use, {
			env: { contextEnabled: true },
			runner: stubAgentRunner({ brief: use.brief, fetched: use.fetched }),
			contextRunner: {
				...inner,
				async runContext(input) {
					const out = await inner.runContext(input);
					// Withdrawal lands after the model call, before persist.
					allowPersist = false;
					return out;
				},
			},
			fetchContextConsent: async () => allowPersist,
		});
		try {
			const facts = caseFacts();
			const { latest } = await settledRun(ctx, facts);
			// External outcome is untouched; the stage failed closed and
			// persisted nothing.
			expect(latest.run.status).toBe("succeeded");
			expect(latest.brief?.summary).toContain("Registry shows");
			expect(latest.context.status).toBe("failed");
			expect(latest.context.errorCode).toBe("consent_required");
			expect(latest.context.signals).toHaveLength(0);
			expect(latest.context.brief).toBe(null);
			const live = await getRun(ctx.db, latest.run.id);
			expect(live?.contextBrief).toBe(null);
			const rows = await ctx.db
				.select({ id: contextSignals.id })
				.from(contextSignals)
				.where(
					and(eq(contextSignals.runId, latest.run.id), sql`${contextSignals.supersededAt} IS NULL`),
				);
			expect(rows).toHaveLength(0);
			const audits = await ctx.db
				.select({ action: researchAuditLog.action, metadata: researchAuditLog.metadata })
				.from(researchAuditLog)
				.where(eq(researchAuditLog.runId, latest.run.id));
			expect(audits.map((a) => a.action)).toContain("context.failed");
			expect(
				audits.some(
					(a) =>
						a.action === "context.failed" &&
						(a.metadata as { code?: string })?.code === "consent_required",
				),
			).toBe(true);
		} finally {
			await teardown(ctx);
		}
	});

	it("purge invalidating the stage before persist still finalizes a valid external brief", async () => {
		let ctx!: TestContext;
		let invalidated = false;
		const inner = stubContextRunner({
			outputs: [contextOutput()],
			snapshots: contextSnapshots(),
			seenEvidence: contextSeen(),
		});
		const use = successFixture();
		ctx = setupApp(use, {
			env: { contextEnabled: true },
			runner: stubAgentRunner({ brief: use.brief, fetched: use.fetched }),
			contextRunner: {
				...inner,
				async runContext(input) {
					const out = await inner.runContext(input);
					if (!invalidated) {
						invalidated = true;
						// Purge/reaper wins after the consent probe but before
						// the stage persist transaction.
						await ctx.db
							.update(agentRuns)
							.set({ contextStatus: "skipped", contextStageToken: null })
							.where(eq(agentRuns.id, input.runId!));
					}
					return out;
				},
			},
			fetchContextConsent: async () => true,
		});
		try {
			const facts = caseFacts();
			const { latest } = await settledRun(ctx, facts);
			expect(latest.run.status).toBe("succeeded");
			expect(latest.brief?.summary).toContain("Registry shows");
			expect(latest.context.status).toBe("skipped");
			expect(latest.context.signals).toHaveLength(0);
			expect(latest.context.brief).toBe(null);
		} finally {
			await teardown(ctx);
		}
	});

	it("purge clears a running stage, blanks signals, and blocks later persists", async () => {
		const ctx = setupContext();
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
			const [seeded] = await ctx.db
				.insert(contextSignals)
				.values({
					runId: run.id,
					stageVersion: 1,
					accountScope: "all",
					type: "negative_balance",
					periodStart: "2025-12-30",
					periodEnd: "2026-01-15",
					metric: "negative_eod_days",
					observed: "3",
					expected: "0",
					confidence: "high",
					status: "review",
					policyVersion: "context-metrics-v1",
					explanation: "Seeded for the purge check.",
					evidence: [{ kind: "transaction", id: "tx-1" }],
				})
				.returning({ id: contextSignals.id });

			const purgePath = `/internal/research/applications/${facts.applicationId}/context/purge`;
			const purged = await post(ctx, purgePath, user("service"), {});
			expect(purged.status).toBe(200);
			expect(await purged.json()).toMatchObject({ purgedRuns: 1, purgedSignals: 1 });

			const live = await getRun(ctx.db, run.id);
			expect(live?.contextStatus).toBe("skipped");
			expect(live?.contextStageToken).toBe(null);
			expect(live?.contextBrief).toBe(null);
			const rows = await ctx.db
				.select()
				.from(contextSignals)
				.where(eq(contextSignals.id, seeded.id));
			expect(rows[0].supersededAt).not.toBe(null);
			expect(rows[0].observed).toBe(null);
			expect(rows[0].expected).toBe(null);
			expect(rows[0].explanation).toBe(null);
			expect(rows[0].evidence).toEqual([]);

			// The running stage cannot persist after the purge.
			expect(
				await persistContextSuccess(ctx.db, run.id, stageToken as string, {
					brief: {},
					validation: {},
					usage: {},
					signals: [],
				}),
			).toBe(false);
			// ...and the in-tx consent gate aborts with zero writes too.
			expect(
				await persistContextSuccess(
					ctx.db,
					run.id,
					stageToken as string,
					{ brief: {}, validation: {}, usage: {}, signals: [] },
					{ consent: false },
				),
			).toBe(false);
		} finally {
			await teardown(ctx);
		}
	});
});

describe("context in auto-trigger", () => {
	function envelope(applicationId: string, id: string = randomUUID()) {
		return {
			id,
			type: "review.requested" as const,
			version: 1 as const,
			occurredAt: new Date().toISOString(),
			applicationId,
			payload: { applicationId, reference: "CR-2026-0001", reasonCodes: ["R1"] },
		};
	}

	it("runs one context stage per referral; redelivery makes zero new calls", async () => {
		const use = successFixture();
		const ctx = setupApp(use, {
			env: { contextEnabled: true },
			contextRunner: stubContextRunner({
				outputs: [contextOutput()],
				snapshots: contextSnapshots(),
				seenEvidence: contextSeen(),
			}),
			fetchContextConsent: async () => true,
		});
		try {
			const env = {
				...loadEnv(),
				agentsEnabled: true,
				contextEnabled: true,
				autoTriggerMaxRunsPerApplicantDay: 1000,
				autoTriggerMaxRunsPerDay: 100_000,
				autoTriggerDailyCostBudgetUsd: 1000,
			};
			const facts = caseFacts();
			const applicantUserId = randomUUID();
			const fetchResearchContext = async (
				applicationId: string,
			): Promise<ResearchContextResult> => {
				if (applicationId !== facts.applicationId) return { ok: false, status: 404 };
				return { ok: true, caseFacts: facts, applicantUserId, contextConsent: true };
			};
			const contextRunner = stubContextRunner({
				outputs: [contextOutput()],
				snapshots: contextSnapshots(),
				seenEvidence: contextSeen(),
			});
			const deps: AutoTriggerDeps = {
				db: ctx.db,
				env,
				logger: testLogger,
				runner: stubAgentRunner({ brief: use.brief, fetched: use.fetched }),
				judge: stubSupportJudge(),
				repair: stubLanguageRepair(),
				observability: degradedObservability,
				contextRunner,
				fetchResearchContext,
				fetchContextConsent: async () => true,
				// In-process stand-in for Temporal: attempt 1 of the real activity.
				starter: {
					start: async (input) => {
						void runAgentAttempt(deps as never, input, 1).catch(() => undefined);
						return { started: true };
					},
				},
			};
			const eventId = randomUUID();
			const first = await handleReviewRequested(deps, envelope(facts.applicationId, eventId));
			expect(first.handled).toBe("ensured");
			const runId = (first as { runId: string }).runId;
			const run = await waitRun(ctx, runId);
			expect(run.status).toBe("succeeded");
			expect(run.contextStatus).toBe("succeeded");

			const second = await handleReviewRequested(deps, envelope(facts.applicationId, eventId));
			expect(second).toEqual({ handled: "duplicate", runId });
			expect(contextRunner.calls).toBe(1);
		} finally {
			await teardown(ctx);
		}
	});

	it("skips the auto run when agents are disabled", async () => {
		const ctx = setupApp();
		try {
			const facts = caseFacts();
			const deps: AutoTriggerDeps = {
				db: ctx.db,
				env: { ...loadEnv(), agentsEnabled: false },
				logger: testLogger,
				runner: stubAgentRunner({ brief: null, fetched: [] }),
				judge: stubSupportJudge(),
				repair: stubLanguageRepair(),
				observability: degradedObservability,
				fetchResearchContext: async (_applicationId: string) => ({
					ok: true,
					caseFacts: facts,
					applicantUserId: randomUUID(),
					contextConsent: true,
				}),
			};
			const out = await handleReviewRequested(deps, envelope(facts.applicationId));
			expect(out).toEqual({ handled: "skipped", reason: "agents_disabled" });
			const rows = await ctx.db
				.select({ id: agentRuns.id })
				.from(agentRuns)
				.where(eq(agentRuns.applicationId, facts.applicationId));
			expect(rows).toHaveLength(0);
		} finally {
			await teardown(ctx);
		}
	});
});
