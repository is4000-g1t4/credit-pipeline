import { TASK_QUEUE } from "@credit/core";
import { reserveApplications, reserveLoans } from "./db.js";
import {
	LOANS_RELAY_LOCK_KEY,
	RELAY_LOCK_KEY,
	drizzleRelayStore,
	startRelayLoop,
} from "./outbox/relay.js";
import { startReconcilerLoop } from "./reconciler.js";
import { bootstrapMonitoringSchedule } from "./schedules.js";
import { createWorker } from "./worker.js";

const worker = await createWorker();
console.log(`worker: running (queue ${TASK_QUEUE}); Ctrl+C to stop`);

try {
	const outcome = await bootstrapMonitoringSchedule();
	console.log(`worker: monitoring schedule bootstrap: ${outcome}`);
} catch (err) {
	console.error("worker: monitoring schedule bootstrap failed:", err);
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

let shuttingDown = false;
const shutdown = async () => {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log("worker: shutting down...");
	relayApplications.stop();
	relayLoans.stop();
	reconciler.stop();
	worker.shutdown();
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await worker.run();
