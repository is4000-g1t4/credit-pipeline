// Workflow tests: refer → officer approve / decline / 72h expiry /
// duplicate updates. Activities MOCKED; the officer arrives via the
// officerDecision update against a time-skipping test server.

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { TASK_QUEUE } from "@credit/core";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from "vitest";
import type {
	Activities,
	ApplicationDto,
	OfficerDecisionInput,
	ScoringSummary,
} from "../src/activities/types.js";
import { officerDecisionUpdate } from "../src/workflows/application.js";

const APP_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_A = "123e4567-e89b-42d3-a456-426614174000";
const REQUEST_B = "123e4567-e89b-42d3-a456-426614174001";
const workflowsPath = fileURLToPath(new URL("../src/workflows", import.meta.url));

let env: TestWorkflowEnvironment;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
}, 180_000);

afterAll(async () => {
	await env?.teardown();
});

// Tomás (SME refer/counter-offer, SPEC §5.1/5.2): $60k/60m referred,
// officer approves at the reduced $50k/60m.
const TOMAS_SCORING: ScoringSummary = {
	kind: "sme",
	score: 652,
	grade: "C",
	product: "sme_term_loan",
	requestedAmountCents: 6000000,
	requestedTermMonths: 60,
	rateBps: 990,
	newPaymentCents: 127187,
	monthlyIncomeCents: null,
	existingDebtCents: null,
	monthlyFcfCents: 380000,
	existingDebtServiceCents: 30000,
};

// Individual refer case (Alex-like): $8k/36m, D-grade. Requested terms pass
// DTI ≤ 50% (116002 ≤ 150000) but sit in the refer band; crushing the term
// to 12m pushes the payment over 50% for the validator test.
const ALEX_SCORING: ScoringSummary = {
	kind: "individual",
	score: 588,
	grade: "D",
	product: "personal_loan",
	requestedAmountCents: 800000,
	requestedTermMonths: 36,
	rateBps: 1050,
	newPaymentCents: 26002,
	monthlyIncomeCents: 300000,
	existingDebtCents: 90000,
	monthlyFcfCents: null,
	existingDebtServiceCents: null,
};

function appDto(): ApplicationDto {
	return {
		id: APP_ID,
		reference: "APP-2026-TOMAS1",
		type: "sme",
		product: "sme_term_loan",
		status: "processing",
		amountCents: 6000000,
		termMonths: 60,
		purpose: "equipment",
		identity: {},
		financial: null,
		business: {},
		submittedAt: "2026-10-19T00:00:00.000Z",
		decidedAt: null,
	};
}

function referMocks(overrides: Record<string, Mock> = {}): Record<string, Mock> {
	return {
		loadApplicationAndSetProcessing: vi.fn(async () => appDto()),
		loadApplication: vi.fn(async () => appDto()),
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
		scoreAndPersist: vi.fn(async () => TOMAS_SCORING),
		evaluateAndPersistPolicy: vi.fn(async () => ({
			outcome: "refer",
			reasons: [
				{ code: "AMOUNT_ABOVE_AUTO_LIMIT", text: "amount" },
				{ code: "SCORE_IN_REFER_BAND", text: "score" },
			],
			maxAmountCents: 6000000,
		})),
		persistDecline: vi.fn(async () => ({
			decisionId: "dec-x",
			replayed: false,
			status: "declined",
		})),
		persistCheckOnlyDecline: vi.fn(async () => ({
			decisionId: "dec-x",
			replayed: false,
			status: "declined",
		})),
		persistOfficerDecline: vi.fn(async () => ({
			decisionId: "dec-2",
			replayed: false,
			status: "declined",
		})),
		markPendingReview: vi.fn(async () => ({ status: "pending_review" })),
		expireReview: vi.fn(async () => ({ expired: true })),
		bookLoan: vi.fn(async () => ({
			decisionId: "dec-2",
			loanId: "loan-2",
			replayed: false,
			approvedAmountCents: 5000000,
			termMonths: 60,
			rateBps: 990,
		})),
		markFailed: vi.fn(async () => ({ marked: true })),
		...overrides,
	};
}

interface StartedRun {
	handle: Awaited<ReturnType<typeof env.client.workflow.start>>;
	stop: () => Promise<void>;
}

async function startRun(mocks: Record<string, Mock>): Promise<StartedRun> {
	const taskQueue = `${TASK_QUEUE}-t-${randomUUID()}`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		namespace: "default",
		taskQueue,
		workflowsPath,
		activities: mocks as unknown as Activities,
	});
	const run = worker.run();
	const handle = await env.client.workflow.start("applicationWorkflow", {
		args: [{ applicationId: APP_ID }],
		taskQueue,
		workflowId: `wf-${randomUUID()}`,
	});
	return {
		handle,
		stop: async () => {
			worker.shutdown();
			await run;
		},
	};
}

/** Wait (real time) until the workflow is parked in pending_review. */
async function waitPending(mocks: Record<string, Mock>): Promise<void> {
	await vi.waitFor(
		() => {
			expect(mocks.markPendingReview).toHaveBeenCalledOnce();
		},
		{ timeout: 30_000, interval: 50 },
	);
}

async function decide(handle: StartedRun["handle"], update: OfficerDecisionInput) {
	return await handle.executeUpdate(officerDecisionUpdate, { args: [update] });
}

// Update rejections arrive wrapped ("Workflow Update failed"); the validator
// message sits on the cause chain.
async function expectUpdateRejected(attempt: Promise<unknown>, pattern: RegExp): Promise<void> {
	try {
		await attempt;
	} catch (err) {
		const text = `${err} ${(err as { cause?: unknown })?.cause ?? ""}`;
		expect(text).toMatch(pattern);
		return;
	}
	expect.unreachable("update should have been rejected");
}

describe("applicationWorkflow: refer path", () => {
	it("officer approve at adjusted terms books with route 'officer'", async () => {
		const mocks = referMocks();
		const { handle, stop } = await startRun(mocks);
		try {
			await waitPending(mocks);
			const update = await decide(handle, {
				requestId: REQUEST_A,
				outcome: "approve",
				approvedAmountCents: 5000000,
				termMonths: 60,
				officerUserId: "00000000-0000-4000-8000-000000000001",
			});
			expect(update).toMatchObject({
				outcome: "booked",
				decisionId: "dec-2",
				loanId: "loan-2",
			});
			expect(mocks.bookLoan).toHaveBeenCalledOnce();
			expect(mocks.bookLoan).toHaveBeenCalledWith({
				applicationId: APP_ID,
				route: "officer",
				approvedAmountCents: 5000000,
				termMonths: 60,
				requestId: REQUEST_A,
				officerUserId: "00000000-0000-4000-8000-000000000001",
				notes: null,
			});
			const result = await handle.result();
			expect(result).toMatchObject({
				outcome: "booked",
				kind: "officer",
				decisionId: "dec-2",
				loanId: "loan-2",
			});
			expect(mocks.expireReview).not.toHaveBeenCalled();
		} finally {
			await stop();
		}
	}, 90_000);

	it("invalid adjustment is rejected and the case stays pending", async () => {
		const mocks = referMocks({
			scoreAndPersist: vi.fn(async () => ALEX_SCORING),
		});
		const { handle, stop } = await startRun(mocks);
		try {
			await waitPending(mocks);
			// $8k crushed to 12m breaks DTI ≤ 50%: rejected, no state change.
			await expectUpdateRejected(
				decide(handle, {
					requestId: REQUEST_A,
					outcome: "approve",
					approvedAmountCents: 800000,
					termMonths: 12,
				}),
				/DTI/,
			);
			expect(mocks.bookLoan).not.toHaveBeenCalled();

			// Still pending: a valid decline afterwards is accepted and
			// completes the case (a closed case would reject the update).
			// (No real-time wait here — under time-skipping, idling lets the
			// 72h timer fire, which is the expiry test's job, not this one's.)

			// A valid decline afterwards completes the case.
			const update = await decide(handle, {
				requestId: REQUEST_B,
				outcome: "decline",
				reasonCode: "OFFICER_JUDGEMENT",
				notes: "cash flow unclear",
			});
			expect(update).toMatchObject({ outcome: "declined" });
			expect(mocks.persistOfficerDecline).toHaveBeenCalledOnce();
			expect(mocks.bookLoan).not.toHaveBeenCalled();
			const result = await handle.result();
			expect(result).toMatchObject({ outcome: "declined", kind: "officer" });
		} finally {
			await stop();
		}
	}, 90_000);

	it("officer decline persists with code + notes, no loan", async () => {
		const mocks = referMocks();
		const { handle, stop } = await startRun(mocks);
		try {
			await waitPending(mocks);
			const update = await decide(handle, {
				requestId: REQUEST_A,
				outcome: "decline",
				reasonCode: "INSUFFICIENT_EVIDENCE",
				notes: "thin file",
				officerUserId: "00000000-0000-4000-8000-000000000001",
			});
			expect(update).toMatchObject({
				outcome: "declined",
				decisionId: "dec-2",
				loanId: null,
			});
			expect(mocks.persistOfficerDecline).toHaveBeenCalledOnce();
			expect(mocks.persistOfficerDecline).toHaveBeenCalledWith({
				applicationId: APP_ID,
				requestId: REQUEST_A,
				officerUserId: "00000000-0000-4000-8000-000000000001",
				reasonCode: "INSUFFICIENT_EVIDENCE",
				notes: "thin file",
			});
			expect(mocks.bookLoan).not.toHaveBeenCalled();
			const result = await handle.result();
			expect(result).toMatchObject({ outcome: "declined", kind: "officer" });
		} finally {
			await stop();
		}
	}, 90_000);

	it("officer decline freezes the server-built research bundle into the snapshot", async () => {
		const mocks = referMocks();
		const { handle, stop } = await startRun(mocks);
		try {
			await waitPending(mocks);
			const findingId = randomUUID();
			const research = {
				agentRunId: randomUUID(),
				applicationId: APP_ID,
				briefHash: "sha256:test",
				viewedAt: null,
				acceptedFindings: [
					{
						findingId,
						claim: "Cited claim.",
						category: "registry",
						entityMatch: { identifierType: "registration_number", value: "X", confidence: "high" },
						evidence: [
							{ url: "https://example.com/r", quote: "exact quote", snapshotHash: "sha256:q" },
						],
					},
				],
			};
			const update = await decide(handle, {
				requestId: REQUEST_A,
				outcome: "decline",
				reasonCode: "OFFICER_JUDGEMENT",
				notes: "weighed the cited filing",
				officerUserId: "00000000-0000-4000-8000-000000000001",
				research,
			});
			expect(update).toMatchObject({ outcome: "declined" });
			// Only the frozen bundle travels — never the public selection.
			expect(mocks.persistOfficerDecline).toHaveBeenCalledWith({
				applicationId: APP_ID,
				requestId: REQUEST_A,
				officerUserId: "00000000-0000-4000-8000-000000000001",
				reasonCode: "OFFICER_JUDGEMENT",
				notes: "weighed the cited filing",
				research,
			});
			const result = await handle.result();
			expect(result).toMatchObject({ outcome: "declined", kind: "officer" });
		} finally {
			await stop();
		}
	}, 90_000);

	it("72h without a decision expires with review.expired and no decision/loan", async () => {
		const mocks = referMocks();
		const { handle, stop } = await startRun(mocks);
		try {
			// Time-skipping jumps the 72h timer; no update is ever sent.
			const result = (await handle.result()) as Record<string, unknown>;
			expect(result).toMatchObject({ outcome: "expired", kind: null });
			expect(mocks.expireReview).toHaveBeenCalledOnce();
			expect(mocks.expireReview).toHaveBeenCalledWith({
				applicationId: APP_ID,
			});
			expect(mocks.bookLoan).not.toHaveBeenCalled();
			expect(mocks.persistOfficerDecline).not.toHaveBeenCalled();
			expect(mocks.persistDecline).not.toHaveBeenCalled();
		} finally {
			await stop();
		}
	}, 90_000);

	it("duplicates: different requestId rejected, same requestId replays without a second booking", async () => {
		let releaseBooking!: () => void;
		const gate = new Promise<void>((r) => {
			releaseBooking = r;
		});
		const mocks = referMocks({
			bookLoan: vi.fn(async () => {
				await gate;
				return {
					decisionId: "dec-2",
					loanId: "loan-2",
					replayed: false,
					approvedAmountCents: 5000000,
					termMonths: 60,
					rateBps: 990,
				};
			}),
		});
		const { handle, stop } = await startRun(mocks);
		try {
			await waitPending(mocks);
			const approveA = {
				requestId: REQUEST_A,
				outcome: "approve",
				approvedAmountCents: 5000000,
				termMonths: 60,
			} as const;
			const first = handle.executeUpdate(officerDecisionUpdate, {
				args: [approveA],
			});
			await vi.waitFor(
				() => {
					expect(mocks.bookLoan).toHaveBeenCalledOnce();
				},
				{ timeout: 30_000, interval: 50 },
			);
			// Same requestId while in flight joins the pending update…
			const replay = handle.executeUpdate(officerDecisionUpdate, {
				args: [{ ...approveA }],
			});
			// …a different requestId while in flight is rejected (409-style).
			await expectUpdateRejected(
				handle.executeUpdate(officerDecisionUpdate, {
					args: [{ ...approveA, requestId: REQUEST_B }],
				}),
				/not awaiting/,
			);

			releaseBooking();
			const [r1, r2] = await Promise.all([first, replay]);
			expect(r1).toMatchObject({ outcome: "booked", decisionId: "dec-2" });
			expect(r2).toEqual(r1);
			expect(mocks.bookLoan).toHaveBeenCalledOnce();
			const result = await handle.result();
			expect(result).toMatchObject({ outcome: "booked", kind: "officer" });

			// After the case closed, any late update is rejected.
			await expect(
				handle.executeUpdate(officerDecisionUpdate, {
					args: [{ ...approveA, requestId: REQUEST_B }],
				}),
			).rejects.toThrow();
			expect(mocks.bookLoan).toHaveBeenCalledOnce();
		} finally {
			await stop();
		}
	}, 120_000);
});
