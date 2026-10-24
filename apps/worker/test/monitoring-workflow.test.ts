// monitoringWorkflow test: the workflow calls runMonitoring once with
// today's UTC date and returns its counts. Activities MOCKED — no DB.

import { fileURLToPath } from "node:url";
import { monitoringWorkflowName } from "@credit/core";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from "vitest";
import { runWorkflow } from "./workflow-helper.js";

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
		const result = await runWorkflow(
			env,
			workflowsPath,
			monitoringWorkflowName,
			[{ manual: true }],
			{ runMonitoring },
		);
		expect(result).toEqual({
			markedOverdue: 2,
			alertsCreated: 2,
			loansUpdated: 1,
		});
		expect(runMonitoring).toHaveBeenCalledOnce();
		expect(runMonitoring).toHaveBeenCalledWith({
			todayUtc: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
		});
	}, 60_000);
});
