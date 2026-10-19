// Schedule bootstrap integration (compose): two bootstraps leave exactly
// one `monitoring` schedule behind, targeting monitoringWorkflow on the
// credit-pipeline queue.

import { MONITORING_SCHEDULE_ID, TASK_QUEUE } from "@credit/core";
import { Client, Connection } from "@temporalio/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapMonitoringSchedule } from "../../src/schedules.js";
import { temporalAddress } from "./helpers.js";

let connection: Connection;
let client: Client;

beforeAll(async () => {
	connection = await Connection.connect({ address: temporalAddress() });
	client = new Client({ connection });
});

afterAll(async () => {
	await connection?.close();
});

describe("bootstrapMonitoringSchedule (integration)", () => {
	it("is idempotent: create twice, one schedule", async () => {
		const first = await bootstrapMonitoringSchedule(client);
		expect(["created", "updated"]).toContain(first);
		const second = await bootstrapMonitoringSchedule(client);
		expect(second).toBe("updated");

		const described = await client.schedule.getHandle(MONITORING_SCHEDULE_ID).describe();
		expect(described.action).toMatchObject({
			workflowType: "monitoringWorkflow",
			taskQueue: TASK_QUEUE,
		});

		// Listing is eventually consistent — poll briefly for exactly one.
		const deadline = Date.now() + 10_000;
		for (;;) {
			let found = 0;
			for await (const s of client.schedule.list()) {
				if (s.scheduleId === MONITORING_SCHEDULE_ID) found++;
			}
			if (found === 1) break;
			if (Date.now() >= deadline) throw new Error(`expected 1 monitoring schedule, saw ${found}`);
			await new Promise((r) => setTimeout(r, 500));
		}
	});
});
