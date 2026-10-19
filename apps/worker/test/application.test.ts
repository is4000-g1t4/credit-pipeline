// Workflow tests: auto-approve, policy decline, check-only decline
// precedence, data-failure markFailed, terminal re-entry. Activities are
// MOCKED — no DB/Kafka. Time-skipping test server (no live Temporal).

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dedupeDecisionMade, dedupeLoanBooked, TASK_QUEUE } from "@credit/core";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from "vitest";
import type { Activities, ApplicationDto, ScoringSummary } from "../src/activities/types.js";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const workflowsPath = fileURLToPath(new URL("../src/workflows", import.meta.url));

let env: TestWorkflowEnvironment;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
}, 180_000);

afterAll(async () => {
	await env?.teardown();
});

function appDto(overrides: Partial<ApplicationDto> = {}): ApplicationDto {
	return {
		id: APP_ID,
		reference: "APP-2026-ABCDEF",
		type: "individual",
		product: "personal_loan",
		status: "processing",
		amountCents: 1200000,
		termMonths: 48,
		purpose: "home renovation",
		identity: {},
		financial: {},
		business: null,
		submittedAt: "2026-10-19T00:00:00.000Z",
		decidedAt: null,
		...overrides,
	};
}

const INDIVIDUAL_SCORING: ScoringSummary = {
	kind: "individual",
	score: 777,
	grade: "A",
	product: "personal_loan",
	requestedAmountCents: 1200000,
	requestedTermMonths: 48,
	rateBps: 650,
	newPaymentCents: 28458,
	monthlyIncomeCents: 420000,
	existingDebtCents: 61000,
	monthlyFcfCents: null,
	existingDebtServiceCents: null,
};

function baseMocks(overrides: Record<string, Mock> = {}): Record<string, Mock> {
	return {
		loadApplicationAndSetProcessing: vi.fn(async () => appDto()),
		loadApplication: vi.fn(async () => appDto({ status: "booked" })),
		runIdentityCheck: vi.fn(async () => ({
			check: "identity",
			passed: true,
		})),
		runSanctionsCheck: vi.fn(async () => ({
			check: "sanctions",
			passed: true,
		})),
		runDocumentCheck: vi.fn(async () => ({
			verified: true,
			kinds: ["id"],
		})),
		fetchBureauReport: vi.fn(async () => ({})),
		fetchBankData: vi.fn(async () => ({})),
		scoreAndPersist: vi.fn(async () => INDIVIDUAL_SCORING),
		evaluateAndPersistPolicy: vi.fn(async () => ({
			outcome: "auto_approve",
			reasons: [],
			maxAmountCents: 1200000,
		})),
		persistDecline: vi.fn(async () => ({
			decisionId: "dec-1",
			replayed: false,
			status: "declined",
		})),
		persistCheckOnlyDecline: vi.fn(async () => ({
			decisionId: "dec-1",
			replayed: false,
			status: "declined",
		})),
		persistOfficerDecline: vi.fn(async () => ({
			decisionId: "dec-1",
			replayed: false,
			status: "declined",
		})),
		markPendingReview: vi.fn(async () => ({ status: "pending_review" })),
		expireReview: vi.fn(async () => ({ expired: true })),
		bookLoan: vi.fn(async () => ({
			decisionId: "dec-1",
			loanId: "loan-1",
			replayed: false,
			approvedAmountCents: 1200000,
			termMonths: 48,
			rateBps: 650,
		})),
		markFailed: vi.fn(async () => ({ marked: true })),
		...overrides,
	};
}

async function execute(mocks: Record<string, Mock>) {
	const taskQueue = `${TASK_QUEUE}-t-${randomUUID()}`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		namespace: "default",
		taskQueue,
		workflowsPath,
		activities: mocks as unknown as Activities,
	});
	const run = worker.run();
	try {
		return await env.client.workflow.execute("applicationWorkflow", {
			args: [{ applicationId: APP_ID }],
			taskQueue,
			workflowId: `wf-${randomUUID()}`,
		});
	} finally {
		worker.shutdown();
		await run;
	}
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
