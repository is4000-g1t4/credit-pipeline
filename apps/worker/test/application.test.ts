// Workflow tests: auto-approve, policy decline, check-only decline
// precedence, data-failure markFailed, terminal re-entry. Activities are
// MOCKED — no DB/Kafka. Time-skipping test server (no live Temporal).

import { fileURLToPath } from "node:url";
import { dedupeDecisionMade, dedupeLoanBooked } from "@credit/core";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from "vitest";
import { APP_ID, baseMocks, runWorkflow } from "./workflow-helper.js";

const workflowsPath = fileURLToPath(new URL("../src/workflows", import.meta.url));

let env: TestWorkflowEnvironment;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
}, 180_000);

afterAll(async () => {
	await env?.teardown();
});

async function execute(mocks: Record<string, Mock>) {
	return runWorkflow(env, workflowsPath, "applicationWorkflow", [{ applicationId: APP_ID }], mocks);
}

const firstCall = (m: Mock): number => m.mock.invocationCallOrder[0];

describe("applicationWorkflow: straight-through paths", () => {
	it("auto-approves: load → verify+data → score → policy → bookLoan", async () => {
		const mocks = baseMocks();
		const result = (await execute(mocks)) as Record<string, unknown>;

		expect(result).toMatchObject({
			applicationId: APP_ID,
			outcome: "booked",
			kind: "auto",
			decisionId: "dec-1",
			loanId: "loan-1",
		});
		// Call order: load first, then the parallel group, score → policy → book.
		expect(firstCall(mocks.loadApplicationAndSetProcessing)).toBeLessThan(
			firstCall(mocks.runIdentityCheck),
		);
		expect(firstCall(mocks.fetchBankData)).toBeLessThan(firstCall(mocks.scoreAndPersist));
		expect(firstCall(mocks.scoreAndPersist)).toBeLessThan(
			firstCall(mocks.evaluateAndPersistPolicy),
		);
		expect(firstCall(mocks.evaluateAndPersistPolicy)).toBeLessThan(firstCall(mocks.bookLoan));
		for (const name of [
			"runIdentityCheck",
			"runSanctionsCheck",
			"runDocumentCheck",
			"fetchBureauReport",
			"fetchBankData",
		]) {
			expect(mocks[name]).toHaveBeenCalledOnce();
		}
		expect(mocks.bookLoan).toHaveBeenCalledOnce();
		expect(mocks.bookLoan).toHaveBeenCalledWith({
			applicationId: APP_ID,
			route: "auto",
		});
		// The returned ids are exactly what the booking outbox dedupe keys use.
		expect(dedupeDecisionMade(result.decisionId as string)).toBe("decision.made:dec-1");
		expect(dedupeLoanBooked(result.loanId as string)).toBe("loan.booked:loan-1");
		for (const name of [
			"persistDecline",
			"persistCheckOnlyDecline",
			"persistOfficerDecline",
			"markPendingReview",
			"expireReview",
			"markFailed",
		]) {
			expect(mocks[name]).not.toHaveBeenCalled();
		}
	}, 60_000);

	it("policy decline persists once and never books", async () => {
		const mocks = baseMocks({
			evaluateAndPersistPolicy: vi.fn(async () => ({
				outcome: "decline",
				reasons: [{ code: "SCORE_TOO_LOW", text: "too low" }],
				maxAmountCents: 1000000,
			})),
		});
		const result = (await execute(mocks)) as Record<string, unknown>;

		expect(result).toMatchObject({
			outcome: "declined",
			kind: "policy",
			decisionId: "dec-1",
			loanId: null,
		});
		expect(mocks.persistDecline).toHaveBeenCalledOnce();
		expect(mocks.persistDecline).toHaveBeenCalledWith({
			applicationId: APP_ID,
		});
		expect(mocks.bookLoan).not.toHaveBeenCalled();
		expect(mocks.markFailed).not.toHaveBeenCalled();
	}, 60_000);

	it("check-only decline short-circuits even when data activities fail", async () => {
		const mocks = baseMocks({
			runIdentityCheck: vi.fn(async () => ({
				check: "identity",
				passed: false,
			})),
			fetchBureauReport: vi.fn(async () => {
				throw new Error("bureau down");
			}),
			fetchBankData: vi.fn(async () => {
				throw new Error("bank down");
			}),
		});
		const result = (await execute(mocks)) as Record<string, unknown>;

		expect(result).toMatchObject({
			outcome: "declined",
			kind: "check_only",
			decisionId: "dec-1",
		});
		expect(mocks.persistCheckOnlyDecline).toHaveBeenCalledOnce();
		expect(mocks.persistCheckOnlyDecline).toHaveBeenCalledWith({
			applicationId: APP_ID,
			reasons: ["IDENTITY_FAILED"],
		});
		expect(mocks.scoreAndPersist).not.toHaveBeenCalled();
		expect(mocks.markFailed).not.toHaveBeenCalled();
		expect(mocks.bookLoan).not.toHaveBeenCalled();
	}, 60_000);

	it("data failure marks failed and the workflow throws", async () => {
		const mocks = baseMocks({
			fetchBureauReport: vi.fn(async () => {
				throw new Error("bureau down");
			}),
		});
		// The client sees the generic wrapper; the cause chain holds the detail.
		await expect(execute(mocks)).rejects.toThrow(/Workflow execution failed/);
		expect(mocks.markFailed).toHaveBeenCalledOnce();
		expect(mocks.markFailed).toHaveBeenCalledWith({
			applicationId: APP_ID,
			reason: expect.stringContaining("fetchBureauReport"),
		});
		expect(mocks.scoreAndPersist).not.toHaveBeenCalled();
		expect(mocks.bookLoan).not.toHaveBeenCalled();
		expect(mocks.persistDecline).not.toHaveBeenCalled();
	}, 60_000);

	it("terminal re-entry exits cleanly without touching anything", async () => {
		const mocks = baseMocks({
			loadApplicationAndSetProcessing: vi.fn(async () => null),
		});
		const result = (await execute(mocks)) as Record<string, unknown>;

		expect(result).toMatchObject({
			outcome: "already_terminal",
			status: "booked",
		});
		expect(mocks.loadApplication).toHaveBeenCalledOnce();
		for (const name of [
			"runIdentityCheck",
			"fetchBureauReport",
			"scoreAndPersist",
			"evaluateAndPersistPolicy",
			"bookLoan",
			"persistDecline",
			"markFailed",
		]) {
			expect(mocks[name]).not.toHaveBeenCalled();
		}
	}, 60_000);
});
