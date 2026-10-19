// Worker entry: connects to Temporal and runs the credit-pipeline queue.
// createWorker() is exported for W3b (relay/consumer/reconciler) and tests.
import { fileURLToPath } from "node:url";
import { TASK_QUEUE } from "@credit/core";
import { NativeConnection, Worker } from "@temporalio/worker";
import { activities } from "./activities/index.js";

export async function createWorker(address?: string): Promise<Worker> {
	const connection = await NativeConnection.connect({
		address: address ?? process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
	});
	return await Worker.create({
		connection,
		namespace: "default",
		taskQueue: TASK_QUEUE,
		workflowsPath: fileURLToPath(new URL("./workflows", import.meta.url)),
		activities,
	});
}
