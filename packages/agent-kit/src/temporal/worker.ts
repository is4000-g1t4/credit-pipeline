// Agent worker factory (Node only — the Temporal worker SDK does not run
// on Bun). Each owning service starts one of these in its own process on
// its own task queue, with activities that touch only that service's DB.
import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import type { AgentRunActivities } from "./types.js";

export interface AgentWorkerOptions {
	address: string;
	namespace?: string;
	taskQueue: string;
	activities: AgentRunActivities;
	/** Concurrent agent runs per worker process. */
	maxConcurrentActivityTaskExecutions?: number;
}

export async function createAgentWorker(
	opts: AgentWorkerOptions,
): Promise<{ worker: Worker; connection: NativeConnection }> {
	const connection = await NativeConnection.connect({ address: opts.address });
	const worker = await Worker.create({
		connection,
		namespace: opts.namespace ?? "default",
		taskQueue: opts.taskQueue,
		workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
		activities: { ...opts.activities },
		maxConcurrentActivityTaskExecutions: opts.maxConcurrentActivityTaskExecutions ?? 8,
		// Let in-flight runs heartbeat/finish before exit; a hard kill is
		// covered by the heartbeat timeout + fenced retry.
		shutdownGraceTime: "15 seconds",
	});
	return { worker, connection };
}
