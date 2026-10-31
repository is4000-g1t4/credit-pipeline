// Research agent worker (Node only; Temporal's worker SDK does not run on
// Bun). Runs durable research runs and context retries on the
// `research-agents` task queue with activities that touch only the
// research database. The HTTP server (server.ts) only starts workflows.
import { createAgentWorker } from "@credit/agent-kit/temporal/worker";
import { AGENT_TASK_QUEUES } from "@credit/agent-kit/temporal/types";
import { createResearchActivities } from "./agent-activities.js";
import { sweepAgentRuns } from "./agent-sweep.js";
import { createResearchRuntime, createResearchStarter } from "./deps.js";

const SWEEP_INTERVAL_MS = 15_000;

const { env, logger, sql, observability, execDeps } = createResearchRuntime();
const starter = createResearchStarter(env.temporalAddress);

const { worker, connection } = await createAgentWorker({
	address: env.temporalAddress,
	taskQueue: AGENT_TASK_QUEUES.research,
	activities: createResearchActivities(execDeps),
});

// Rows committed but never started (API crash, Temporal briefly down) get an
// idempotent start; rows unstartable far past their lease fail "timeout".
let sweeping = false;
const sweep = setInterval(() => {
	if (sweeping) return;
	sweeping = true;
	void (async () => {
		try {
			const { started, failed } = await sweepAgentRuns({ ...execDeps, starter });
			if (started.length > 0) logger.info({ count: started.length }, "sweep started queued runs");
			if (failed.length > 0) logger.warn({ count: failed.length }, "sweep failed overdue runs");
		} catch (err: unknown) {
			logger.error({ err: err instanceof Error ? err.name : "unknown" }, "agent sweep failed");
		} finally {
			sweeping = false;
		}
	})();
}, SWEEP_INTERVAL_MS);
sweep.unref();

let shuttingDown = false;
const shutdown = (): void => {
	if (shuttingDown) return;
	shuttingDown = true;
	clearInterval(sweep);
	// worker.run() resolves once in-flight activities drain (grace time in
	// createAgentWorker); a hard kill is covered by heartbeat timeout + fenced retry.
	worker.shutdown();
	setTimeout(() => process.exit(0), 25_000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(
	`research agent worker polling ${AGENT_TASK_QUEUES.research} at ${env.temporalAddress}`,
);
try {
	await worker.run();
} finally {
	clearInterval(sweep);
	await starter.close().catch(() => undefined);
	await connection.close().catch(() => undefined);
	try {
		await observability.shutdown?.();
	} catch (err: unknown) {
		logger.error(
			{ err: err instanceof Error ? err.name : "unknown" },
			"observability shutdown failed",
		);
	}
	await sql.end({ timeout: 5 }).catch(() => undefined);
	process.exit(0);
}
