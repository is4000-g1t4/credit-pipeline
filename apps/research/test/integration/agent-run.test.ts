// Durable-run mechanics that replaced the reapers + boot recovery: retry
// fencing (token rotation), failAgentRun cleanup, the agent-worker sweep,
// and API start-after-commit. Real credit_research Postgres; the Temporal
// starter is a fake (the real-Temporal path is agent-worker.test.ts).
import { randomUUID } from "node:crypto";
import { agentEvidence, agentFindings, contextSignals } from "@credit/db/research";
import { createLogger } from "@credit/service-kit";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
	contextRetryTimeoutMs,
	failResearchRun,
	RESEARCH_CONTEXT_RETRY_KIND,
	RESEARCH_RUN_KIND,
	researchRunTimeoutMs,
} from "../../src/agent-run.js";
import { sweepAgentRuns } from "../../src/agent-sweep.js";
import {
	stubAgentRunner,
	stubLanguageRepair,
	stubSupportJudge,
} from "../../src/agents/case-brief/index.js";
import { stubContextRunner } from "../../src/agents/context-analyst/index.js";
import { loadEnv } from "../../src/env.js";
import {
	claimContextRetry,
	claimContextStage,
	claimRun,
	ensureRun,
	failOverdueContextRetries,
	failOverdueQueuedRuns,
	finalizeFailure,
	getRun,
	initContextStage,
	persistContextFailure,
	persistContextSuccess,
	rotateContextStageForRetry,
	rotateRunForRetry,
	runLeaseMs,
	type CaseFactsPayload,
} from "../../src/lifecycle.js";
import { executeRun } from "../../src/run.js";
import {
	caseFacts,
	degradedObservability,
	post,
	setupApp,
	successFixture,
	teardown,
	user,
	type TestContext,
} from "../helper.js";

process.env.LOG_LEVEL ??= "silent";
const logger = createLogger("research-agent-run-test");
const env = { ...loadEnv(), agentsEnabled: true, contextEnabled: true };

async function newRun(ctx: TestContext, facts: CaseFactsPayload = caseFacts()) {
	const { run } = await ensureRun(ctx.db, env, {
		applicationId: facts.applicationId,
		requestedBy: randomUUID(),
		caseFacts: facts,
		aiResearchConsent: true,
	});
	return { run, token: run.runToken as string, facts };
}

const input = (runId: string, token: string, kind = RESEARCH_RUN_KIND) => ({
	kind,
	runId,
	token,
	timeoutMs: 300_000,
});

async function counts(ctx: TestContext, runId: string) {
	const [ev, f, sig] = await Promise.all([
		ctx.db
			.select({ id: agentEvidence.id })
			.from(agentEvidence)
			.where(eq(agentEvidence.runId, runId)),
		ctx.db
			.select({ id: agentFindings.id })
			.from(agentFindings)
			.where(eq(agentFindings.runId, runId)),
		ctx.db
			.select({ id: contextSignals.id })
			.from(contextSignals)
			.where(eq(contextSignals.runId, runId)),
	]);
	return { evidence: ev.length, findings: f.length, signals: sig.length };
}

describe("rotateRunForRetry (attempt > 1 fence)", () => {
	it("rotates the token, resets state, and rejects the zombie attempt's writes", async () => {
		const use = successFixture();
		let rotated: string | null = null;
		let midFlight: Awaited<ReturnType<typeof counts>> | null = null;
		let ctxRef: TestContext | null = null;
		let runIdRef = "";
		// The context stage is running (external evidence already persisted)
		// when attempt 2 fences: the old attempt is now a zombie.
		const rotatingContext = {
			...stubContextRunner({
				outputs: [{ claims: [], signals: [], dataGaps: [], limitations: [] }],
			}),
			async runContext() {
				midFlight = await counts(ctxRef as TestContext, runIdRef);
				rotated = await rotateRunForRetry((ctxRef as TestContext).db, env, runIdRef);
				return {
					output: { claims: [], signals: [], dataGaps: [], limitations: [] },
					usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
					snapshots: [],
					seenEvidence: new Map<string, Set<string>>(),
					model: "test-context-model",
					toolFailures: [],
					modelBudgetExceeded: false,
				};
			},
		};
		const ctx = setupApp(use, { env: { contextEnabled: true } });
		ctxRef = ctx;
		try {
			const { run, token } = await newRun(ctx);
			runIdRef = run.id;
			const deps = {
				db: ctx.db,
				env,
				logger,
				runner: stubAgentRunner({ brief: use.brief, fetched: use.fetched }),
				judge: stubSupportJudge(),
				repair: stubLanguageRepair(),
				observability: degradedObservability,
				contextRunner: rotatingContext,
				fetchContextConsent: async () => true,
			};
			// Attempt 1 (zombie): runs until the fence lands mid-stage.
			await executeRun(deps, run.id, token);
			expect(midFlight).toEqual({ evidence: 2, findings: 2, signals: 0 });
			expect(rotated).not.toBeNull();
			expect(rotated).not.toBe(token);

			// The zombie wrote nothing after the fence: queued, fresh token,
			// everything the dead attempt persisted is gone, stages reset.
			const fenced = await getRun(ctx.db, run.id);
			expect(fenced?.status).toBe("queued");
			expect(fenced?.runToken).toBe(rotated);
			expect(fenced?.brief).toBeNull();
			expect(fenced?.errorCode).toBeNull();
			expect(fenced?.contextStatus).toBe("not_applicable");
			expect(fenced?.contextStageToken).toBeNull();
			expect(fenced?.policyStatus).toBe("not_applicable");
			expect(fenced?.timeoutAt.getTime()).toBeGreaterThan(Date.now() + runLeaseMs(env) - 5_000);
			expect(await counts(ctx, run.id)).toEqual({ evidence: 0, findings: 0, signals: 0 });
			// Old token can neither claim nor fail the run.
			expect(await claimRun(ctx.db, run.id, token)).toBe(false);
			expect(await finalizeFailure(ctx.db, run.id, token, "internal_error", "zombie")).toBe(false);

			// Attempt 2 runs from scratch with the new token: no duplicates.
			await executeRun(
				{ ...deps, contextRunner: stubContextRunner({ outputs: [{}] }) },
				run.id,
				rotated!,
			);
			const done = await getRun(ctx.db, run.id);
			expect(done?.status).toBe("succeeded");
			expect((await counts(ctx, run.id)).evidence).toBe(2);
		} finally {
			await teardown(ctx);
		}
	});

	it("returns null for a terminal, missing or malformed run and touches nothing", async () => {
		const ctx = setupApp();
		try {
			const { run, token } = await newRun(ctx);
			expect(await claimRun(ctx.db, run.id, token)).toBe(true);
			expect(await finalizeFailure(ctx.db, run.id, token, "tool_error", "sources down")).toBe(true);
			const before = await getRun(ctx.db, run.id);
			expect(await rotateRunForRetry(ctx.db, env, run.id)).toBeNull();
			expect(await rotateRunForRetry(ctx.db, env, randomUUID())).toBeNull();
			expect(await rotateRunForRetry(ctx.db, env, "not-a-uuid")).toBeNull();
			expect(await getRun(ctx.db, run.id)).toEqual(before);
		} finally {
			await teardown(ctx);
		}
	});

	it("also fences a queued run (crash before the claim) and a claimed running run", async () => {
		const ctx = setupApp();
		try {
			const queued = await newRun(ctx);
			const t1 = await rotateRunForRetry(ctx.db, env, queued.run.id);
			expect(t1).not.toBe(queued.token);
			expect(await claimRun(ctx.db, queued.run.id, queued.token)).toBe(false);
			expect(await claimRun(ctx.db, queued.run.id, t1!)).toBe(true);
			const t2 = await rotateRunForRetry(ctx.db, env, queued.run.id);
			expect(t2).not.toBe(t1);
			expect((await getRun(ctx.db, queued.run.id))?.status).toBe("queued");
		} finally {
			await teardown(ctx);
		}
	});
});

describe("rotateContextStageForRetry (context-retry fence)", () => {
	it("rotates the running retry stage's token so the old attempt cannot persist", async () => {
		const ctx = setupApp();
		try {
			const { run, token } = await newRun(ctx);
			expect(await claimRun(ctx.db, run.id, token)).toBe(true);
			expect(await initContextStage(ctx.db, env, run.id, token, "queued")).toBe(true);
			const s1 = await claimContextStage(ctx.db, env, run.id, token, {
				promptVersion: "context-v1",
				model: "test",
			});
			expect(await persistContextFailure(ctx.db, run.id, s1 as string, "tool_error")).toBe(true);
			expect(await finalizeFailure(ctx.db, run.id, token, "tool_error", "x")).toBe(true);
			const retry = await claimContextRetry(ctx.db, env, run.id);
			expect(retry?.stageVersion).toBe(2);
			// Fresh retry claims have never heartbeated (the sweep relies on it).
			expect((await getRun(ctx.db, run.id))?.contextHeartbeatAt).toBeNull();

			const s2 = await rotateContextStageForRetry(ctx.db, run.id);
			expect(s2).not.toBeNull();
			expect(s2).not.toBe(retry!.stageToken);
			const data = { brief: {}, validation: {}, usage: {}, signals: [] };
			expect(await persistContextSuccess(ctx.db, run.id, retry!.stageToken, data)).toBe(false);
			expect(await persistContextSuccess(ctx.db, run.id, s2!, data)).toBe(true);
			// Stage is no longer running: nothing left to fence.
			expect(await rotateContextStageForRetry(ctx.db, run.id)).toBeNull();
		} finally {
			await teardown(ctx);
		}
	});
});

describe("failAgentRun", () => {
	it("fails an active run and its queued/running stages with the mapped code", async () => {
		const ctx = setupApp();
		try {
			const { run, token } = await newRun(ctx);
			expect(await claimRun(ctx.db, run.id, token)).toBe(true);
			expect(await initContextStage(ctx.db, env, run.id, token, "queued")).toBe(true);
			expect(
				await claimContextStage(ctx.db, env, run.id, token, { promptVersion: "v1", model: "m" }),
			).not.toBeNull();
			await ctx.db.execute(
				sql`UPDATE agent_runs SET policy_status = 'running' WHERE id = ${run.id}`,
			);

			// Non-timeout failures map to the existing internal_error code.
			await failResearchRun(ctx.db, input(run.id, token), { code: "error", message: "boom" });
			const failed = await getRun(ctx.db, run.id);
			expect(failed).toMatchObject({
				status: "failed",
				errorCode: "internal_error",
				runToken: null,
				contextStatus: "failed",
				contextErrorCode: "internal_error",
				contextStageToken: null,
				policyStatus: "failed",
				policyErrorCode: "internal_error",
			});
			expect(failed?.finishedAt).not.toBeNull();
			expect(failed?.contextFinishedAt).not.toBeNull();

			// Idempotent: a second call (workflow cleanup retry) changes nothing.
			await failResearchRun(ctx.db, input(run.id, token), { code: "timeout", message: "late" });
			expect(await getRun(ctx.db, run.id)).toEqual(failed);
		} finally {
			await teardown(ctx);
		}
	});

	it("never touches a terminal run, its persisted brief, or its stages", async () => {
		const use = successFixture();
		const ctx = setupApp(use);
		try {
			const { run, token } = await newRun(ctx);
			await executeRun(
				{
					db: ctx.db,
					env: { ...env, contextEnabled: false },
					logger,
					runner: stubAgentRunner({ brief: use.brief, fetched: use.fetched }),
					judge: stubSupportJudge(),
					repair: stubLanguageRepair(),
					observability: degradedObservability,
				},
				run.id,
				token,
			);
			const done = await getRun(ctx.db, run.id);
			expect(done?.status).toBe("succeeded");
			await failResearchRun(ctx.db, input(run.id, token), { code: "timeout", message: "x" });
			expect(await getRun(ctx.db, run.id)).toEqual(done);
			expect((await counts(ctx, run.id)).evidence).toBe(2);
		} finally {
			await teardown(ctx);
		}
	});

	it("context-retry kind fails only the running retry stage, never the run", async () => {
		const ctx = setupApp();
		try {
			const { run, token } = await newRun(ctx);
			expect(await claimRun(ctx.db, run.id, token)).toBe(true);
			expect(await initContextStage(ctx.db, env, run.id, token, "queued")).toBe(true);
			const s1 = await claimContextStage(ctx.db, env, run.id, token, {
				promptVersion: "v1",
				model: "m",
			});
			await persistContextFailure(ctx.db, run.id, s1 as string, "tool_error");
			await ctx.db.execute(
				sql`UPDATE agent_runs SET status = 'succeeded', run_token = NULL, finished_at = now(), brief = '{"summary":"kept"}'::jsonb WHERE id = ${run.id}`,
			);
			const retry = await claimContextRetry(ctx.db, env, run.id);
			expect(retry).not.toBeNull();

			// A run-kind cleanup (terminal run) must not clobber the retry stage.
			await failResearchRun(ctx.db, input(run.id, token), { code: "timeout", message: "x" });
			expect((await getRun(ctx.db, run.id))?.contextStatus).toBe("running");

			const retryInput = input(run.id, retry!.stageToken, RESEARCH_CONTEXT_RETRY_KIND);
			await failResearchRun(ctx.db, retryInput, { code: "timeout", message: "x" });
			const after = await getRun(ctx.db, run.id);
			expect(after).toMatchObject({
				status: "succeeded",
				contextStatus: "failed",
				contextErrorCode: "timeout",
				contextStageToken: null,
			});
			expect(after?.brief).toEqual({ summary: "kept" });
			// Idempotent.
			await failResearchRun(ctx.db, retryInput, { code: "error", message: "again" });
			expect(await getRun(ctx.db, run.id)).toEqual(after);
		} finally {
			await teardown(ctx);
		}
	});
});

describe("agent-worker sweep", () => {
	function fakeStarter(fail = false) {
		const starts: Array<{ kind: string; runId: string; token: string; timeoutMs: number }> = [];
		return {
			starts,
			start: async (i: { kind: string; runId: string; token: string; timeoutMs: number }) => {
				if (fail) throw new Error("temporal down");
				starts.push(i);
				return { started: true };
			},
		};
	}

	it("re-issues idempotent starts only for old, never-started rows", async () => {
		const ctx = setupApp();
		try {
			const fresh = await newRun(ctx);
			const old = await newRun(ctx);
			const rotated = await newRun(ctx);
			const claimed = await newRun(ctx);
			await ctx.db.execute(
				sql`UPDATE agent_runs SET created_at = now() - INTERVAL '30 seconds' WHERE id IN (${old.run.id}, ${rotated.run.id}, ${claimed.run.id})`,
			);
			await rotateRunForRetry(ctx.db, env, rotated.run.id);
			expect(await claimRun(ctx.db, claimed.run.id, claimed.token)).toBe(true);

			const starter = fakeStarter();
			const out = await sweepAgentRuns({ db: ctx.db, env, logger, starter });
			const startedIds = starter.starts.map((s) => s.runId);
			expect(startedIds).toContain(old.run.id);
			expect(startedIds).not.toContain(fresh.run.id);
			// Rotated/claimed rows carry a heartbeat: their token is no longer
			// the workflow's original, so restarting would run it twice.
			expect(startedIds).not.toContain(rotated.run.id);
			expect(startedIds).not.toContain(claimed.run.id);
			expect(out.started).toContain(old.run.id);
			const start = starter.starts.find((s) => s.runId === old.run.id);
			expect(start).toEqual({
				kind: RESEARCH_RUN_KIND,
				runId: old.run.id,
				token: old.token,
				timeoutMs: researchRunTimeoutMs(env),
			});
			// Starting does not change the row; it stays queued until claimed.
			expect((await getRun(ctx.db, old.run.id))?.status).toBe("queued");
		} finally {
			await teardown(ctx);
		}
	});

	it("restarts a claimed-but-unstarted context retry stage", async () => {
		const ctx = setupApp();
		try {
			const { run, token } = await newRun(ctx);
			expect(await claimRun(ctx.db, run.id, token)).toBe(true);
			expect(await initContextStage(ctx.db, env, run.id, token, "queued")).toBe(true);
			const s1 = await claimContextStage(ctx.db, env, run.id, token, {
				promptVersion: "v1",
				model: "m",
			});
			await persistContextFailure(ctx.db, run.id, s1 as string, "tool_error");
			expect(await finalizeFailure(ctx.db, run.id, token, "tool_error", "x")).toBe(true);
			const retry = await claimContextRetry(ctx.db, env, run.id);
			await ctx.db.execute(
				sql`UPDATE agent_runs SET context_started_at = now() - INTERVAL '30 seconds' WHERE id = ${run.id}`,
			);
			const starter = fakeStarter();
			await sweepAgentRuns({ db: ctx.db, env, logger, starter });
			expect(starter.starts).toContainEqual({
				kind: RESEARCH_CONTEXT_RETRY_KIND,
				runId: run.id,
				token: retry!.stageToken,
				timeoutMs: contextRetryTimeoutMs(env),
			});
		} finally {
			await teardown(ctx);
		}
	});

	it("fails queued rows 5 minutes past their lease instead of restarting them", async () => {
		const ctx = setupApp();
		try {
			const overdue = await newRun(ctx);
			const pastLease = await newRun(ctx);
			await ctx.db.execute(
				sql`UPDATE agent_runs SET created_at = now() - INTERVAL '1 hour', timeout_at = now() - INTERVAL '301 seconds' WHERE id = ${overdue.run.id}`,
			);
			await ctx.db.execute(
				sql`UPDATE agent_runs SET created_at = now() - INTERVAL '1 hour', timeout_at = now() - INTERVAL '60 seconds' WHERE id = ${pastLease.run.id}`,
			);
			const starter = fakeStarter();
			const out = await sweepAgentRuns({ db: ctx.db, env, logger, starter });
			expect(out.failed).toContain(overdue.run.id);
			expect(starter.starts.map((s) => s.runId)).not.toContain(overdue.run.id);
			const row = await getRun(ctx.db, overdue.run.id);
			expect(row).toMatchObject({ status: "failed", errorCode: "timeout", runToken: null });
			// Past lease but inside the grace: started, not failed.
			expect(out.failed).not.toContain(pastLease.run.id);
			expect(starter.starts.map((s) => s.runId)).toContain(pastLease.run.id);
			// Repeat sweep: nothing new to fail for the overdue row.
			expect(await failOverdueQueuedRuns(ctx.db)).not.toContain(overdue.run.id);
		} finally {
			await teardown(ctx);
		}
	});

	it("fails an overdue unstarted context retry stage but never its run", async () => {
		const ctx = setupApp();
		try {
			const { run, token } = await newRun(ctx);
			expect(await claimRun(ctx.db, run.id, token)).toBe(true);
			expect(await initContextStage(ctx.db, env, run.id, token, "queued")).toBe(true);
			const s1 = await claimContextStage(ctx.db, env, run.id, token, {
				promptVersion: "v1",
				model: "m",
			});
			await persistContextFailure(ctx.db, run.id, s1 as string, "tool_error");
			expect(await finalizeFailure(ctx.db, run.id, token, "tool_error", "x")).toBe(true);
			expect(await claimContextRetry(ctx.db, env, run.id)).not.toBeNull();
			await ctx.db.execute(
				sql`UPDATE agent_runs SET context_started_at = now() - INTERVAL '1 hour', context_timeout_at = now() - INTERVAL '301 seconds' WHERE id = ${run.id}`,
			);
			expect(await failOverdueContextRetries(ctx.db)).toContain(run.id);
			expect(await getRun(ctx.db, run.id)).toMatchObject({
				status: "failed",
				errorCode: "tool_error",
				contextStatus: "failed",
				contextErrorCode: "timeout",
				contextStageToken: null,
			});
		} finally {
			await teardown(ctx);
		}
	});

	it("keeps going when a start throws (Temporal still down)", async () => {
		const ctx = setupApp();
		try {
			const old = await newRun(ctx);
			await ctx.db.execute(
				sql`UPDATE agent_runs SET created_at = now() - INTERVAL '30 seconds' WHERE id = ${old.run.id}`,
			);
			const out = await sweepAgentRuns({ db: ctx.db, env, logger, starter: fakeStarter(true) });
			expect(out.started).not.toContain(old.run.id);
			expect((await getRun(ctx.db, old.run.id))?.status).toBe("queued");
		} finally {
			await teardown(ctx);
		}
	});
});

describe("API starts the workflow after the row commits", () => {
	const officerRef = user("officer");

	async function ensureViaApi(ctx: TestContext, officer = user("officer")) {
		const facts = caseFacts();
		const res = await post(ctx, "/internal/research/runs/ensure", officer, {
			applicationId: facts.applicationId,
			caseFacts: { ...facts },
			aiResearchConsent: true,
		});
		return { res, facts };
	}

	it("calls start() once with the run's token and combined lease, row already visible", async () => {
		const seen: Array<{ status?: string; token?: string | null }> = [];
		let ctxRef: TestContext | null = null;
		const ctx = setupApp(undefined, {
			starter: {
				start: async (i) => {
					// A separate connection sees the row only if the tx committed.
					const row = await getRun((ctxRef as TestContext).db, i.runId);
					seen.push({ status: row?.status, token: row?.runToken });
					return { started: true };
				},
			},
		});
		ctxRef = ctx;
		try {
			const { res } = await ensureViaApi(ctx);
			expect(res.status).toBe(202);
			const body = (await res.json()) as { run: { id: string }; inserted: boolean };
			expect(body.inserted).toBe(true);
			expect(ctx.starts).toHaveLength(1);
			const start = ctx.starts[0];
			expect(start).toMatchObject({
				kind: RESEARCH_RUN_KIND,
				runId: body.run.id,
				timeoutMs: researchRunTimeoutMs(apiEnv()),
			});
			expect(seen).toEqual([{ status: "queued", token: start.token }]);
			// The same ensure again reuses the active run: no second start.
			expect(ctx.starts).toHaveLength(1);
		} finally {
			await teardown(ctx);
		}
	});

	it("returns the same 202 when Temporal is down, leaving the row queued for the sweep", async () => {
		const ctx = setupApp(undefined, {
			starter: {
				start: async () => {
					throw new Error("temporal unreachable");
				},
			},
		});
		try {
			const { res } = await ensureViaApi(ctx);
			expect(res.status).toBe(202);
			const body = (await res.json()) as {
				run: { id: string; status: string };
				inserted: boolean;
			};
			expect(body.inserted).toBe(true);
			expect(body.run.status).toBe("queued");
			expect((await getRun(ctx.db, body.run.id))?.status).toBe("queued");

			// Temporal back: the sweep starts the stranded row.
			await ctx.db.execute(
				sql`UPDATE agent_runs SET created_at = now() - INTERVAL '30 seconds' WHERE id = ${body.run.id}`,
			);
			const starts: string[] = [];
			await sweepAgentRuns({
				db: ctx.db,
				env: apiEnv(),
				logger,
				starter: {
					start: async (i) => {
						starts.push(i.runId);
						return { started: true };
					},
				},
			});
			expect(starts).toContain(body.run.id);
		} finally {
			await teardown(ctx);
		}
	});

	it("context retry: claims the stage, starts after commit, and survives Temporal being down", async () => {
		const ctx = setupApp(undefined, {
			env: { contextEnabled: true },
			fetchContextConsent: async () => true,
			starter: {
				start: async (i) => {
					if (i.kind === RESEARCH_CONTEXT_RETRY_KIND) throw new Error("temporal unreachable");
					return { started: true };
				},
			},
		});
		try {
			const { res, facts } = await ensureViaApi(ctx, officerRef);
			expect(res.status).toBe(202);
			const runId = ((await res.json()) as { run: { id: string } }).run.id;
			const row = await getRun(ctx.db, runId);
			const token = row?.runToken as string;
			// Drive the run to a terminal state with a failed context stage.
			expect(await claimRun(ctx.db, runId, token)).toBe(true);
			expect(await initContextStage(ctx.db, env, runId, token, "queued")).toBe(true);
			const s1 = await claimContextStage(ctx.db, env, runId, token, {
				promptVersion: "v1",
				model: "m",
			});
			await persistContextFailure(ctx.db, runId, s1 as string, "tool_error");
			expect(await finalizeFailure(ctx.db, runId, token, "tool_error", "x")).toBe(true);

			const retry = await post(
				ctx,
				`/internal/research/applications/${facts.applicationId}/runs/${runId}/context/retry`,
				officerRef,
				{},
			);
			expect(retry.status).toBe(202);
			const body = (await retry.json()) as { contextStageToken: string };
			const start = ctx.starts.find((s) => s.kind === RESEARCH_CONTEXT_RETRY_KIND);
			expect(start).toEqual({
				kind: RESEARCH_CONTEXT_RETRY_KIND,
				runId,
				token: body.contextStageToken,
				timeoutMs: contextRetryTimeoutMs(env),
			});
			// Start failed: the stage stays claimed, never heartbeated, for the sweep.
			const after = await getRun(ctx.db, runId);
			expect(after?.contextStatus).toBe("running");
			expect(after?.contextHeartbeatAt).toBeNull();
		} finally {
			await teardown(ctx);
		}
	});

	it("starts nothing for a rejected request and nothing for a reused active run", async () => {
		const ctx = setupApp(undefined, {
			starter: {
				start: async () => ({ started: true }),
			},
		});
		try {
			const facts = caseFacts();
			const officer = user("officer");
			const payload = {
				applicationId: facts.applicationId,
				caseFacts: { ...facts },
				aiResearchConsent: true,
			};
			expect((await post(ctx, "/internal/research/runs/ensure", officer, payload)).status).toBe(
				202,
			);
			expect((await post(ctx, "/internal/research/runs/ensure", officer, payload)).status).toBe(
				202,
			);
			expect(ctx.starts).toHaveLength(1);
			const denied = await post(ctx, "/internal/research/runs/ensure", officer, {
				...payload,
				aiResearchConsent: false,
			});
			expect(denied.status).toBe(403);
			expect(ctx.starts).toHaveLength(1);
		} finally {
			await teardown(ctx);
		}
	});
});

function apiEnv() {
	return { ...loadEnv(), agentsEnabled: true, contextEnabled: false };
}
