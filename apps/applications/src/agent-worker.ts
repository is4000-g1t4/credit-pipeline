// Node entry for the applications agent worker (Temporal). Run with
// `pnpm --filter @credit/applications dev:agent-worker`. The Temporal worker
// SDK needs Node, so this is a separate process from the Bun API; it owns the
// integrity activities (the only code that executes the model) and the
// queued-run sweep.
import { createAgentRunStarter } from "@credit/agent-kit/temporal/client";
import { createAgentWorker } from "@credit/agent-kit/temporal/worker";
import { AGENT_TASK_QUEUES } from "@credit/agent-kit/temporal/types";
import { createDb } from "@credit/db";
import { createLogger } from "@credit/service-kit";
import { loadEnv } from "./env.js";
import { createIntegrityActivities } from "./integrity/activities.js";
import { sweepQueuedIntegrityRuns } from "./integrity/sweep.js";
import {
	createIntegrityRunnerFromEnv,
	integrityDispatchEnabled,
	integrityRunDepsFromEnv,
} from "./integrity/wiring.js";
import { applicationObservability } from "./observability.js";

const SWEEP_INTERVAL_MS = 15_000;

const env = loadEnv();
const logger = createLogger("applications-agent-worker");
const { db, sql } = createDb(env.databaseUrl);
const runner = createIntegrityRunnerFromEnv(env, logger);
applicationObservability();

const starter = createAgentRunStarter({
	address: env.temporalAddress,
	taskQueue: AGENT_TASK_QUEUES.applications,
});
const deps = integrityRunDepsFromEnv({ env, db, logger, runner, starter });
const dispatch = integrityDispatchEnabled(env, runner);

const { worker, connection } = await createAgentWorker({
	address: env.temporalAddress,
	taskQueue: AGENT_TASK_QUEUES.applications,
	activities: createIntegrityActivities(deps),
});

let sweeping = false;
async function sweep(): Promise<void> {
	if (sweeping) return;
	sweeping = true;
	try {
		await sweepQueuedIntegrityRuns(deps, { dispatch });
	} catch (err) {
		logger.warn({ error: err instanceof Error ? err.name : "unknown" }, "integrity sweep failed");
	} finally {
		sweeping = false;
	}
}
const sweepTimer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
void sweep();

let stopping = false;
function shutdown(signal: string): void {
	if (stopping) return;
	stopping = true;
	logger.info({ signal }, "applications agent worker shutting down");
	clearInterval(sweepTimer);
	worker.shutdown();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

logger.info(
	{ taskQueue: AGENT_TASK_QUEUES.applications, dispatch },
	"applications agent worker up",
);
try {
	await worker.run();
} finally {
	clearInterval(sweepTimer);
	await starter.close().catch(() => {});
	await connection.close().catch(() => {});
	await sql.end({ timeout: 5 }).catch(() => {});
}
