// monitoringWorkflow test: the workflow calls runMonitoring once with
// today's UTC date and returns its counts. Activities MOCKED — no DB.

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { monitoringWorkflowName, TASK_QUEUE } from "@credit/core";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from "vitest";
import type { Activities } from "../src/activities/types.js";

const workflowsPath = fileURLToPath(new URL("../src/workflows", import.meta.url));

let env: TestWorkflowEnvironment;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
}, 180_000);

afterAll(async () => {
	await env?.teardown();
});

describe("monitoringWorkflow", () => {
	it("calls runMonitoring once with today UTC and returns its counts", async () => {
		const runMonitoring: Mock = vi.fn(async () => ({
			markedOverdue: 2,
			alertsCreated: 2,
			loansUpdated: 1,
		}));
		const taskQueue = `${TASK_QUEUE}-t-${randomUUID()}`;
		const worker = await Worker.create({
			connection: env.nativeConnection,
			namespace: "default",
			taskQueue,
			workflowsPath,
			activities: { runMonitoring } as unknown as Activities,
		});
		const run = worker.run();
		try {
			const result = await env.client.workflow.execute(monitoringWorkflowName, {
				args: [{ manual: true }],
				taskQueue,
				workflowId: `wf-${randomUUID()}`,
			});
			expect(result).toEqual({
				markedOverdue: 2,
				alertsCreated: 2,
				loansUpdated: 1,
			});
			expect(runMonitoring).toHaveBeenCalledOnce();
			expect(runMonitoring).toHaveBeenCalledWith({
				todayUtc: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
			});
		} finally {
			worker.shutdown();
			await run;
		}
	}, 60_000);
});
