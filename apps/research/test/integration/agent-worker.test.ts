// Real Temporal (compose) + real credit_research Postgres: the actual agent
// worker activities (heartbeat, fencing, failAgentRun) under the generic
// agentRunWorkflow, with stub runners (no OpenRouter/Tavily). Unique task
// queue so parallel agents sharing the stack never steal each other's work.
import { randomUUID } from "node:crypto";
import { createAgentRunStarter } from "@credit/agent-kit/temporal/client";
import { createAgentWorker } from "@credit/agent-kit/temporal/worker";
import { agentEvidence, createDb } from "@credit/db/research";
import { createLogger } from "@credit/service-kit";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createResearchActivities } from "../../src/agent-activities.js";
import { researchRunTimeoutMs, RESEARCH_RUN_KIND } from "../../src/agent-run.js";
import {
	ModelUnavailableError,
	stubAgentRunner,
	stubLanguageRepair,
	stubSupportJudge,
	type AgentRunner,
} from "../../src/agents/case-brief/index.js";
import { loadEnv } from "../../src/env.js";
import { claimRun, ensureRun, getRun } from "../../src/lifecycle.js";
import { caseFacts, degradedObservability, successFixture } from "../helper.js";

process.env.LOG_LEVEL ??= "silent";

const env = { ...loadEnv(), agentsEnabled: true, contextEnabled: false };
const address = env.temporalAddress;
const taskQueue = `research-agents-test-${randomUUID()}`;
const { db, sql } = createDb(env.databaseUrl);
const use = successFixture();

// Per-run scripted behaviour; the stub runner counts real model "spend".
const modelCalls = new Map<string, number>();
let failModel = false;
const base = stubAgentRunner({ brief: use.brief, fetched: use.fetched });
const runner: AgentRunner = {
	async runBrief(opts) {
		const id = opts.runId ?? "";
		modelCalls.set(id, (modelCalls.get(id) ?? 0) + 1);
		if (failModel) throw new ModelUnavailableError("model down");
		return base.runBrief(opts);
	},
};

type Crash = "none" | "once-after-claim" | "always";
const crash = new Map<string, Crash>();
const attempts = new Map<string, number[]>();
const rowAtAttempt2 = new Map<string, { status: string; token: string | null }>();

const activities = createResearchActivities(
	{
		db,
		env,
		logger: createLogger("research-agent-worker-test"),
		runner,
		judge: stubSupportJudge(),
		repair: stubLanguageRepair(),
		observability: degradedObservability,
	},
	{
		heartbeatIntervalMs: 200,
		async beforeRun({ attempt, input }) {
			attempts.set(input.runId, [...(attempts.get(input.runId) ?? []), attempt]);
			const mode = crash.get(input.runId) ?? "none";
			if (attempt === 2) {
				const row = await getRun(db, input.runId);
				rowAtAttempt2.set(input.runId, {
					status: row?.status ?? "missing",
					token: row?.runToken ?? null,
				});
			}
			// Dies after claiming: the row is left `running` with a token the
			// next attempt must fence.
			if (mode === "always" || (mode === "once-after-claim" && attempt === 1)) {
				await claimRun(db, input.runId, input.token);
				throw new Error("worker crashed");
			}
		},
	},
);

let shutdown: () => Promise<void>;
const starter = createAgentRunStarter({ address, taskQueue });

beforeAll(async () => {
	const { worker, connection: workerConn } = await createAgentWorker({
		address,
		taskQueue,
		activities,
	});
	const running = worker.run();
	shutdown = async () => {
		worker.shutdown();
		await running;
		await workerConn.close();
	};
});

afterAll(async () => {
	await shutdown?.();
	await starter.close();
	await sql.end();
});

async function startRun(mode: Crash, extra: { maxAttempts?: number } = {}) {
	const facts = caseFacts();
	const { run } = await ensureRun(db, env, {
		applicationId: facts.applicationId,
		requestedBy: randomUUID(),
		caseFacts: facts,
		aiResearchConsent: true,
	});
	crash.set(run.id, mode);
	const input = {
		kind: RESEARCH_RUN_KIND,
		runId: run.id,
		token: run.runToken as string,
		timeoutMs: researchRunTimeoutMs(env),
		...extra,
	};
	const { workflowId, started } = await starter.start(input);
	expect(started).toBe(true);
	// The run row is the read model: wait for its terminal state.
	const deadline = Date.now() + 40_000;
	for (;;) {
		const row = await getRun(db, run.id);
		if (row && (row.status === "succeeded" || row.status === "failed")) break;
		if (Date.now() > deadline) throw new Error(`run ${run.id} did not settle`);
		await new Promise((r) => setTimeout(r, 100));
	}
	return { input, workflowId };
}

describe("research agent worker on real Temporal", () => {
	it("runs a healthy run to succeeded on attempt 1", async () => {
		const { input } = await startRun("none");
		expect(attempts.get(input.runId)).toEqual([1]);
		const run = await getRun(db, input.runId);
		expect(run?.status).toBe("succeeded");
		expect(run?.runToken).toBeNull();
		expect(modelCalls.get(input.runId)).toBe(1);
		const evidence = await db
			.select({ id: agentEvidence.id })
			.from(agentEvidence)
			.where(eq(agentEvidence.runId, input.runId));
		expect(evidence).toHaveLength(2);
	});

	it("fences a crashed attempt 1: attempt 2 rotates the token and succeeds", async () => {
		const { input } = await startRun("once-after-claim");
		expect(attempts.get(input.runId)).toEqual([1, 2]);
		// Attempt 2 started from the zombie's state: running under the input token.
		expect(rowAtAttempt2.get(input.runId)).toEqual({ status: "running", token: input.token });
		const run = await getRun(db, input.runId);
		expect(run?.status).toBe("succeeded");
		// Only the rerun spent model budget; the crash happened before it.
		expect(modelCalls.get(input.runId)).toBe(1);
		const evidence = await db
			.select({ id: agentEvidence.id })
			.from(agentEvidence)
			.where(eq(agentEvidence.runId, input.runId));
		expect(evidence).toHaveLength(2);
	});

	it("marks the run failed through failAgentRun after exhausting attempts", async () => {
		const { input } = await startRun("always", { maxAttempts: 2 });
		expect(attempts.get(input.runId)).toEqual([1, 2]);
		const run = await getRun(db, input.runId);
		expect(run).toMatchObject({
			status: "failed",
			errorCode: "internal_error",
			runToken: null,
		});
		expect(run?.finishedAt).not.toBeNull();
		expect(modelCalls.get(input.runId) ?? 0).toBe(0);
	});

	it("does not retry a business failure (finalized once, no re-spend)", async () => {
		failModel = true;
		try {
			const { input } = await startRun("none");
			expect(attempts.get(input.runId)).toEqual([1]);
			expect(modelCalls.get(input.runId)).toBe(1);
			expect(await getRun(db, input.runId)).toMatchObject({
				status: "failed",
				errorCode: "model_unavailable",
			});
		} finally {
			failModel = false;
		}
	});

	it("treats a duplicate start for the same token as an idempotent no-op", async () => {
		const { input, workflowId } = await startRun("none");
		const again = await starter.start(input);
		expect(again).toEqual({ started: false, workflowId, closed: false });
		expect(attempts.get(input.runId)).toEqual([1]);
		expect(modelCalls.get(input.runId)).toBe(1);
	});
});
