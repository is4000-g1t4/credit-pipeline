import { TASK_QUEUE } from "@credit/core";
import { closeDb, reserveApplications, reserveLoans } from "./db.js";
import {
	LOANS_RELAY_LOCK_KEY,
	RELAY_LOCK_KEY,
	drizzleRelayStore,
	startRelayLoop,
} from "./outbox/relay.js";
import { startReconcilerLoop } from "./reconciler.js";
import { logger } from "./logger.js";
import { bootstrapMonitoringSchedule } from "./schedules.js";
import { createWorker } from "./worker.js";

const worker = await createWorker();
logger.info(`worker: running (queue ${TASK_QUEUE}); Ctrl+C to stop`);

try {
	const outcome = await bootstrapMonitoringSchedule();
	logger.info(`worker: monitoring schedule bootstrap: ${outcome}`);
} catch (err) {
	logger.error({ err }, "worker: monitoring schedule bootstrap failed");
}

// Kafka-backed loops tolerate a briefly unavailable broker: the relay skips
// ticks until connect succeeds — either way the worker stays up and errors
// surface in logs. One relay loop per writer DB (advisory locks are
// per-database, so the applications loop keeps 4242 and loans uses 4243).
// The Kafka consumer lives in the portfolio service now, not here.
const relayApplications = startRelayLoop({
	store: drizzleRelayStore(reserveApplications, RELAY_LOCK_KEY),
});
const relayLoans = startRelayLoop({
	store: drizzleRelayStore(reserveLoans, LOANS_RELAY_LOCK_KEY),
});
const reconciler = startReconcilerLoop();

const running = worker.run();
let signals = 0;
const shutdown = async () => {
	signals++;
	if (signals > 1) {
		logger.warn("worker: second signal, forcing exit");
		process.exit(1);
	}
	logger.info("worker: shutting down...");
	try {
		// Start Temporal draining first; loop shutdown can block on a
		// Kafka send retry for minutes, so do not serialize it ahead of it.
		worker.shutdown();
		const stops = Promise.all([
			relayApplications.stop(),
			relayLoans.stop(),
			reconciler.stop(),
		]).catch((err) => {
			logger.error({ err }, "worker: loop shutdown failed");
		});
		// Worker.run() resolves after shutdown; shutdownGraceTime bounds the
		// drain. Race keeps a wedged drain from blocking the process forever.
		await Promise.race([running, sleep(15_000)]);
		await Promise.race([stops, sleep(5_000)]);
		await closeDb();
	} catch (err) {
		logger.error({ err }, "worker: shutdown failed");
		process.exit(1);
	}
	process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await running;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
