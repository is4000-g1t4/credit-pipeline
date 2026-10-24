// Shared workflow-test harness (time-skipping server, mocked activities).
// baseMocks covers the straight-through suite; runWorkflow is the one-shot
// execute both that suite and the monitoring test use. refer.test.ts keeps
// its own startRun — it needs the live handle for officer updates.
import { randomUUID } from "node:crypto";
import { TASK_QUEUE } from "@credit/core";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { vi, type Mock } from "vitest";
import type { Activities, ApplicationDto, ScoringSummary } from "../src/activities/types.js";

export const APP_ID = "11111111-1111-4111-8111-111111111111";

export function appDto(overrides: Partial<ApplicationDto> = {}): ApplicationDto {
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

export const INDIVIDUAL_SCORING: ScoringSummary = {
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

export function baseMocks(overrides: Record<string, Mock> = {}): Record<string, Mock> {
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

/** One-shot execute on a fresh task queue against the time-skipping server. */
export async function runWorkflow(
	env: TestWorkflowEnvironment,
	workflowsPath: string,
	workflow: string,
	args: unknown[],
	activities: Record<string, Mock> | Activities,
): Promise<unknown> {
	const taskQueue = `${TASK_QUEUE}-t-${randomUUID()}`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		namespace: "default",
		taskQueue,
		workflowsPath,
		activities: activities as unknown as Activities,
	});
	const run = worker.run();
	try {
		return await env.client.workflow.execute(workflow, {
			args,
			taskQueue,
			workflowId: `wf-${randomUUID()}`,
		});
	} finally {
		worker.shutdown();
		await run;
	}
}
