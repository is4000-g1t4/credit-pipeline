// Booking saga integration (compose): real applications+loans DBs.
// Double-booking the same application writes exactly one decision, one
// loan, and one outbox event per type, ending `booked`. A second case
// covers the repair path: an approved decision with no loan (crash between
// saga steps (a)/(b)) resumes into exactly one loan and `booked`.
import { randomUUID } from "node:crypto";
import { dedupeDecisionMade, dedupeLoanBooked } from "@credit/core";
import { applications, decisions, policyEvaluations, scores } from "@credit/db/applications";
import { installments, loans } from "@credit/db/loans";
import { outboxEvents } from "@credit/db/shared";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { bookLoan, resumeBooking } from "../../src/activities/booking.js";
import { persistOfficerDecline } from "../../src/activities/decisions.js";
import { closeDb } from "../../src/db.js";
import { drizzleReconcilerStore } from "../../src/reconciler.js";
import { testDb, testLoansDb } from "./helpers.js";

const appsHandle = testDb();
const loansHandle = testLoansDb();
const appsDb = appsHandle.db;
const loansDb = loansHandle.db;

const appIds: string[] = [];

async function fixture(status: "processing" | "pending_review" = "processing"): Promise<string> {
	const tag = randomUUID().slice(0, 8).toUpperCase();
	const [app] = await appsDb
		.insert(applications)
		.values({
			reference: `APP-B-${tag}`,
			applicantUserId: randomUUID(),
			type: "individual",
			product: "personal_loan",
			status,
			amountCents: 500000,
			termMonths: 24,
			purpose: "booking integration",
			identity: {},
			financial: null,
			business: null,
			consents: [true, true, true],
			// D0: submitted rows always carry submittedAt (draft iff null).
			submittedAt: new Date(),
		})
		.returning({ id: applications.id });
	const applicationId = app.id;
	appIds.push(applicationId);
	await appsDb.insert(scores).values({
		applicationId,
		modelVersion: "scorecard-v1",
		score: 720,
		grade: "B",
		components: {},
		factors: [],
		affordability: { newPaymentCents: 22000 },
	});
	await appsDb.insert(policyEvaluations).values({
		applicationId,
		policyVersion: "policy-v1.0",
		outcome: "auto_approve",
		reasons: [{ code: "AMOUNT_ABOVE_AUTO_LIMIT", text: "Amount above the limit." }],
		maxAmountCents: 1500000,
		inputs: {},
		inputHash: "test",
	});
	return applicationId;
}

afterAll(async () => {
	try {
		for (const applicationId of appIds) {
			const loanRows = await loansDb
				.select({ id: loans.id })
				.from(loans)
				.where(eq(loans.applicationId, applicationId));
			for (const loan of loanRows) {
				// audit_log is append-only at the DB level; leave it in place.
				await loansDb.delete(outboxEvents).where(eq(outboxEvents.key, applicationId));
				await loansDb.delete(installments).where(eq(installments.loanId, loan.id));
				await loansDb.delete(loans).where(eq(loans.id, loan.id));
			}
			await appsDb.delete(outboxEvents).where(eq(outboxEvents.key, applicationId));
			await appsDb.delete(decisions).where(eq(decisions.applicationId, applicationId));
			await appsDb.delete(scores).where(eq(scores.applicationId, applicationId));
			await appsDb
				.delete(policyEvaluations)
				.where(eq(policyEvaluations.applicationId, applicationId));
			await appsDb.delete(applications).where(eq(applications.id, applicationId));
		}
	} finally {
		await closeDb();
		await appsHandle.sql.end();
		await loansHandle.sql.end();
	}
});

describe("bookLoan (integration)", () => {
	it("double booking writes one decision, one loan, one outbox event per type", async () => {
		const applicationId = await fixture();
		const first = await bookLoan({ applicationId, route: "auto" });
		const second = await bookLoan({ applicationId, route: "auto" });

		expect(second.decisionId).toBe(first.decisionId);
		expect(second.loanId).toBe(first.loanId);
		expect(second.replayed).toBe(true);

		const decisionRows = await appsDb
			.select()
			.from(decisions)
			.where(eq(decisions.applicationId, applicationId));
		expect(decisionRows).toHaveLength(1);
		const loanRows = await loansDb
			.select()
			.from(loans)
			.where(eq(loans.applicationId, applicationId));
		expect(loanRows).toHaveLength(1);
		const itemRows = await loansDb
			.select({ id: installments.id })
			.from(installments)
			.where(eq(installments.loanId, first.loanId));
		expect(itemRows).toHaveLength(24);

		const decisionOutbox = await appsDb
			.select()
			.from(outboxEvents)
			.where(eq(outboxEvents.dedupeKey, dedupeDecisionMade(first.decisionId)));
		expect(decisionOutbox).toHaveLength(1);
		// Topic/key/payload: the relay publishes exactly this envelope.
		expect(decisionOutbox[0]).toMatchObject({
			topic: "credit.decision.made",
			key: applicationId,
		});
		expect(decisionOutbox[0]?.payload).toMatchObject({
			type: "decision.made",
			applicationId,
			payload: {
				decisionId: first.decisionId,
				applicationId,
				outcome: "approved",
				decidedBy: "system",
			},
		});
		const loanOutbox = await loansDb
			.select()
			.from(outboxEvents)
			.where(eq(outboxEvents.dedupeKey, dedupeLoanBooked(first.loanId)));
		expect(loanOutbox).toHaveLength(1);
		expect(loanOutbox[0]).toMatchObject({ topic: "credit.loan.booked", key: applicationId });
		expect(loanOutbox[0]?.payload).toMatchObject({
			type: "loan.booked",
			applicationId,
			loanId: first.loanId,
			payload: {
				loanId: first.loanId,
				applicationId,
			},
		});

		const [app] = await appsDb
			.select()
			.from(applications)
			.where(eq(applications.id, applicationId));
		expect(app?.status).toBe("booked");
	});

	it("concurrent double booking converges on one decision and one loan", async () => {
		const applicationId = await fixture();
		const [first, second] = await Promise.all([
			bookLoan({ applicationId, route: "auto" }),
			bookLoan({ applicationId, route: "auto" }),
		]);

		expect(first.decisionId).toBe(second.decisionId);
		expect(first.loanId).toBe(second.loanId);
		const decisionRows = await appsDb
			.select({ id: decisions.id })
			.from(decisions)
			.where(eq(decisions.applicationId, applicationId));
		expect(decisionRows).toHaveLength(1);
		const loanRows = await loansDb
			.select({ id: loans.id })
			.from(loans)
			.where(eq(loans.applicationId, applicationId));
		expect(loanRows).toHaveLength(1);
		const [app] = await appsDb
			.select()
			.from(applications)
			.where(eq(applications.id, applicationId));
		expect(app?.status).toBe("booked");
	});

	it("repairs an approved decision with no loan into one loan and booked", async () => {
		const applicationId = await fixture();
		// Mimic a crash between saga steps (a) and (b): decision committed,
		// no loan, status still processing.
		const [decision] = await appsDb
			.insert(decisions)
			.values({
				applicationId,
				outcome: "approved",
				decidedBy: "system",
				reasons: [{ code: "AMOUNT_ABOVE_AUTO_LIMIT", text: "Amount above the limit." }],
				approvedAmountCents: 500000,
				termMonths: 24,
				rateBps: 750,
				snapshot: {},
			})
			.returning({ id: decisions.id });

		const result = await resumeBooking(applicationId);
		expect(result.decisionId).toBe(decision.id);

		const loanRows = await loansDb
			.select()
			.from(loans)
			.where(eq(loans.applicationId, applicationId));
		expect(loanRows).toHaveLength(1);
		const [app] = await appsDb
			.select()
			.from(applications)
			.where(eq(applications.id, applicationId));
		expect(app?.status).toBe("booked");

		// Loan exists but the flip is lost: resume converges without a second loan.
		await appsDb
			.update(applications)
			.set({ status: "processing" })
			.where(eq(applications.id, applicationId));
		const again = await resumeBooking(applicationId);
		expect(again.loanId).toBe(result.loanId);
		const loansAgain = await loansDb
			.select({ id: loans.id })
			.from(loans)
			.where(eq(loans.applicationId, applicationId));
		expect(loansAgain).toHaveLength(1);
		const [reflipped] = await appsDb
			.select()
			.from(applications)
			.where(eq(applications.id, applicationId));
		expect(reflipped?.status).toBe("booked");
	});

	it("repairs an officer-approved decision with no loan into one loan and booked", async () => {
		const applicationId = await fixture("pending_review");
		// Officer-route booking validates DTI against the stored finances.
		await appsDb
			.update(applications)
			.set({ financial: { monthlyIncomeCents: 420000, existingDebtCents: 61000 } })
			.where(eq(applications.id, applicationId));
		// Mimic a crash after the officer decision committed, before the loan.
		const [decision] = await appsDb
			.insert(decisions)
			.values({
				applicationId,
				outcome: "approved",
				decidedBy: "officer",
				officerUserId: randomUUID(),
				requestId: randomUUID(),
				approvedAmountCents: 500000,
				termMonths: 24,
				rateBps: 750,
				reasons: [{ code: "AMOUNT_ABOVE_AUTO_LIMIT", text: "Amount above the limit." }],
				notes: "Counter-offer: reduced to $5,000.",
				snapshot: {},
			})
			.returning({ id: decisions.id });

		const result = await resumeBooking(applicationId);
		expect(result.decisionId).toBe(decision.id);

		const loanRows = await loansDb
			.select()
			.from(loans)
			.where(eq(loans.applicationId, applicationId));
		expect(loanRows).toHaveLength(1);
		const [app] = await appsDb
			.select()
			.from(applications)
			.where(eq(applications.id, applicationId));
		expect(app?.status).toBe("booked");

		// Lose the booked flip: the reconciler store repairs the
		// loan-exists-but-not-booked case without writing a second loan.
		await appsDb
			.update(applications)
			.set({ status: "pending_review" })
			.where(eq(applications.id, applicationId));
		expect(await drizzleReconcilerStore().repairBooking(applicationId)).toBe(true);
		const loansAgain = await loansDb
			.select({ id: loans.id })
			.from(loans)
			.where(eq(loans.applicationId, applicationId));
		expect(loansAgain).toHaveLength(1);
		expect(loansAgain[0]?.id).toBe(result.loanId);
		const [reflipped] = await appsDb
			.select()
			.from(applications)
			.where(eq(applications.id, applicationId));
		expect(reflipped?.status).toBe("booked");
	});

	it("officer booking copies the frozen research bundle into decision.snapshot.research", async () => {
		const applicationId = await fixture("pending_review");
		// Officer-route booking validates DTI against the stored finances.
		await appsDb
			.update(applications)
			.set({ financial: { monthlyIncomeCents: 420000, existingDebtCents: 61000 } })
			.where(eq(applications.id, applicationId));
		const research = {
			agentRunId: randomUUID(),
			applicationId,
			briefHash: "sha256:test",
			viewedAt: null,
			acceptedFindings: [
				{
					findingId: randomUUID(),
					claim: "Cited claim.",
					category: "registry",
					entityMatch: { identifierType: "registration_number", value: "X", confidence: "high" },
					evidence: [
						{ url: "https://example.com/r", quote: "exact quote", snapshotHash: "sha256:q" },
					],
				},
			],
		};
		const booked = await bookLoan({
			applicationId,
			route: "officer",
			requestId: randomUUID(),
			officerUserId: randomUUID(),
			research,
		});
		expect(booked.replayed).toBe(false);
		const rows = await appsDb
			.select()
			.from(decisions)
			.where(eq(decisions.applicationId, applicationId));
		expect(rows).toHaveLength(1);
		expect((rows[0].snapshot as { research: unknown }).research).toEqual(research);
	});

	it("officer decline copies the frozen research bundle into decision.snapshot.research", async () => {
		const applicationId = await fixture("pending_review");
		const research = {
			agentRunId: randomUUID(),
			applicationId,
			briefHash: "sha256:test",
			viewedAt: null,
			acceptedFindings: [
				{
					findingId: randomUUID(),
					claim: "Cited claim.",
					category: "registry",
					entityMatch: { identifierType: "registration_number", value: "X", confidence: "high" },
					evidence: [
						{ url: "https://example.com/r", quote: "exact quote", snapshotHash: "sha256:q" },
					],
				},
			],
		};
		const declined = await persistOfficerDecline({
			applicationId,
			requestId: randomUUID(),
			officerUserId: randomUUID(),
			reasonCode: "OFFICER_JUDGEMENT",
			notes: "weighed the cited filing",
			research,
		});
		expect(declined.replayed).toBe(false);
		expect(declined.status).toBe("declined");
		const rows = await appsDb
			.select()
			.from(decisions)
			.where(eq(decisions.applicationId, applicationId));
		expect(rows).toHaveLength(1);
		expect((rows[0].snapshot as { research: unknown }).research).toEqual(research);
	});

	it("reconciler store repairs an approved decision with no loan", async () => {
		const applicationId = await fixture("processing");
		const [decision] = await appsDb
			.insert(decisions)
			.values({
				applicationId,
				outcome: "approved",
				decidedBy: "system",
				requestId: null,
				approvedAmountCents: 500000,
				termMonths: 24,
				rateBps: 750,
				reasons: [{ code: "AUTO_APPROVED", text: "Approved automatically." }],
				notes: null,
				snapshot: {},
			})
			.returning({ id: decisions.id });

		expect(await drizzleReconcilerStore().repairBooking(applicationId)).toBe(true);
		const loanRows = await loansDb
			.select()
			.from(loans)
			.where(eq(loans.applicationId, applicationId));
		expect(loanRows).toHaveLength(1);
		const [app] = await appsDb
			.select()
			.from(applications)
			.where(eq(applications.id, applicationId));
		expect(app?.status).toBe("booked");
		const saved = await appsDb
			.select({ id: decisions.id })
			.from(decisions)
			.where(eq(decisions.applicationId, applicationId));
		expect(saved).toEqual([{ id: decision.id }]);
	});
});
