// Real Temporal (compose) — proves dispatch, fenced crash retries and the
// terminal cleanup step that replaced the hand-rolled reapers.
import { randomUUID } from "node:crypto";
import { Client, Connection } from "@temporalio/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAttempt, nonRetryableAgentError, startHeartbeat } from "../../src/temporal/activity.js";
import { createAgentRunStarter } from "../../src/temporal/client.js";
import type { AgentRunFailure, AgentRunInput } from "../../src/temporal/types.js";
import { createAgentWorker } from "../../src/temporal/worker.js";

const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
const taskQueue = `agent-kit-test-${randomUUID()}`;

type Behaviour = "ok" | "throw-twice" | "always-throw" | "hang" | "non-retryable" | "slow";
const behaviour = new Map<string, Behaviour>();
const attempts = new Map<string, number[]>();
const failures = new Map<string, AgentRunFailure>();

const activities = {
	async executeAgentRun(input: AgentRunInput): Promise<void> {
		const attempt = runAttempt(input);
		attempts.set(input.runId, [...(attempts.get(input.runId) ?? []), attempt]);
		const mode = behaviour.get(input.runId);
		if (mode === "throw-twice" && attempt < 3) throw new Error("worker crashed");
		if (mode === "always-throw") throw new Error("boom");
		if (mode === "non-retryable") throw nonRetryableAgentError("run row missing");
		if (mode === "slow") {
			// Heartbeats fine but overruns its start-to-close budget.
			const stop = startHeartbeat(200);
			await new Promise((r) => setTimeout(r, 4_000));
			stop();
			return;
		}
		if (mode === "hang") {
			// No heartbeats: Temporal must time the attempt out and retry.
			await new Promise((r) => setTimeout(r, 4_000));
			return;
		}
		const stop = startHeartbeat(200);
		stop();
	},
	async failAgentRun(input: AgentRunInput, failure: AgentRunFailure): Promise<void> {
		failures.set(input.runId, failure);
	},
};

let connection: Connection;
let client: Client;
let shutdown: () => Promise<void>;

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
	connection = await Connection.connect({ address });
	client = new Client({ connection });
});

afterAll(async () => {
	await shutdown?.();
	await connection?.close();
});

async function run(mode: Behaviour, extra: Partial<AgentRunInput> = {}) {
	const runId = randomUUID();
	behaviour.set(runId, mode);
	const starter = createAgentRunStarter({ address, taskQueue, client });
	const input: AgentRunInput = {
		kind: "test.run",
		runId,
		token: randomUUID(),
		timeoutMs: 10_000,
		...extra,
	};
	const { workflowId, started } = await starter.start(input);
	expect(started).toBe(true);
	// Same token again is an idempotent no-op (crash between commit and start).
	expect((await starter.start(input)).started).toBe(false);
	const outcome = await client.workflow
		.getHandle(workflowId)
		.result()
		.then(() => "completed" as const)
		.catch(() => "failed" as const);
	return { runId, outcome };
}

describe("agentRunWorkflow", () => {
	it("completes a healthy run without cleanup", async () => {
		const { runId, outcome } = await run("ok");
		expect(outcome).toBe("completed");
		expect(attempts.get(runId)).toEqual([1]);
		expect(failures.has(runId)).toBe(false);
	});

	it("retries a crashed attempt and succeeds on attempt 3", async () => {
		const { runId, outcome } = await run("throw-twice");
		expect(outcome).toBe("completed");
		expect(attempts.get(runId)).toEqual([1, 2, 3]);
		expect(failures.has(runId)).toBe(false);
	});

	it("marks the run failed after exhausting attempts", async () => {
		const { runId, outcome } = await run("always-throw", { maxAttempts: 2 });
		expect(outcome).toBe("failed");
		expect(attempts.get(runId)).toEqual([1, 2]);
		expect(failures.get(runId)?.code).toBe("error");
	});

	it("does not retry a non-retryable error", async () => {
		const { runId, outcome } = await run("non-retryable");
		expect(outcome).toBe("failed");
		expect(attempts.get(runId)).toEqual([1]);
		expect(failures.get(runId)?.code).toBe("error");
	});

	it("treats a lost heartbeat as a timeout and cleans up", async () => {
		const { runId, outcome } = await run("hang", { heartbeatTimeoutMs: 1_000, maxAttempts: 2 });
		expect(outcome).toBe("failed");
		expect(attempts.get(runId)).toEqual([1, 2]);
		expect(failures.get(runId)?.code).toBe("timeout");
	});

	it("does not retry a run that used its whole start-to-close budget", async () => {
		const { runId, outcome } = await run("slow", { timeoutMs: 1_500 });
		expect(outcome).toBe("failed");
		expect(attempts.get(runId)).toEqual([1]);
		expect(failures.get(runId)?.code).toBe("timeout");
	});
});
