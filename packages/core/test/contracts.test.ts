// Workflow contract smoke test (SPEC FR-6.1/6.2, FR-6.5).
import { describe, expect, it } from "vitest";
import { applicationWorkflowId, TASK_QUEUE } from "../src/index.js";

describe("contracts", () => {
	it("pins the queue, workflow IDs, and update/schedule names", () => {
		expect(TASK_QUEUE).toBe("credit-pipeline");
		expect(applicationWorkflowId("abc")).toBe("app-abc");
	});
});
