// Booking saga (SPEC FR-8.3, Wave P2): THREE transactions across two
// databases — the single-tx booking cannot span the database-per-service
// split, so booking is a saga orchestrated here in the worker:
//
//   (a) credit_applications tx: lock the application FOR UPDATE, enforce the
//       route guard (auto → processing, officer → pending_review), persist
//       the decision if absent + audit + outbox `decision.made`. Status is
//       NOT flipped yet.
//   (b) credit_loans tx: insert the loan (denormalised application
//       reference/applicant/product — no join to applications, ever) +
//       installments + audit + outbox `loan.booked`.
//   (c) credit_applications tx: conditional `SET booked` + audit.
//
// Each step is idempotent and activity retries converge: a crash between
// (a)/(b) replays (a) into the existing decision and continues; a crash
// between (b)/(c) replays (b) into the existing loan and finishes (c).
// Trade-off: a crash between (b) and (c) leaves a loan whose application is
// not yet `booked` — briefly visible as pending_review-with-loan until the
// retry lands. Readers treat `booked` status as the terminal marker, and
// markFailed/expireReview both check loan existence, so the window can
// never flip terminal state the wrong way. Integer cents throughout.

import {
	buildCreditSnapshot,
	buildSchedule,
	DSCR_DECLINE_MIN_X100,
	DTI_DECLINE_MAX_PCT_X100,
	dedupeDecisionMade,
	dedupeLoanBooked,
	dscrGte,
	dtiLte,
	monthlyPaymentCents,
	PERSONAL_MIN_CENTS,
	rateBps,
	SME_MIN_CENTS,
	TERM_MAX_MONTHS,
	TERM_MIN_MONTHS,
} from "@credit/core";
import { applications, decisions, withTx } from "@credit/db/applications";
import { installments, loans } from "@credit/db/loans";
import { and, eq, inArray } from "drizzle-orm";
import { getApplicationsDb, getLoansDb } from "../db.js";
import { insertOutbox, writeAudit } from "@credit/service-kit";
import { conflict, invalid, loadCreditContext } from "./shared.js";
import type { BookLoanInput, BookLoanResult } from "./types.js";

export async function bookLoan(input: BookLoanInput): Promise<BookLoanResult> {
	const { db: appsDb } = getApplicationsDb();
	const { db: loansDb } = getLoansDb();
	const { app, score, grade, factors, policyInputs, policyReasons } = await loadCreditContext(
		appsDb,
		input.applicationId,
	);
	const rate = rateBps(grade, app.product);

	const approvedAmountCents =
		input.route === "auto" ? app.amountCents : (input.approvedAmountCents ?? app.amountCents);
	const termMonths = input.route === "auto" ? app.termMonths : (input.termMonths ?? app.termMonths);

	if (input.route === "officer") {
		const min = app.product === "sme_term_loan" ? SME_MIN_CENTS : PERSONAL_MIN_CENTS;
		if (
			!Number.isInteger(approvedAmountCents) ||
			approvedAmountCents < min ||
			approvedAmountCents > app.amountCents
		) {
			throw invalid(`approved amount must be ${min}–${app.amountCents} (requested)`);
		}
		if (
			!Number.isInteger(termMonths) ||
			termMonths < TERM_MIN_MONTHS ||
			termMonths > TERM_MAX_MONTHS
		) {
			throw invalid(`term must be ${TERM_MIN_MONTHS}–${TERM_MAX_MONTHS} months`);
		}
		const payment = monthlyPaymentCents(approvedAmountCents, rate, termMonths);
		if (app.type === "individual") {
			const fin = app.financial as {
				monthlyIncomeCents: number;
				existingDebtCents: number;
			};
			if (
				!dtiLte(fin.existingDebtCents, payment, fin.monthlyIncomeCents, DTI_DECLINE_MAX_PCT_X100)
			) {
				throw invalid("adjusted terms breach DTI ≤ 50%");
			}
		} else {
			const biz = app.business as {
				monthlyFcfCents: number;
				existingDebtServiceCents: number;
			};
			if (
				!dscrGte(biz.monthlyFcfCents, payment, biz.existingDebtServiceCents, DSCR_DECLINE_MIN_X100)
			) {
				throw invalid("adjusted terms breach DSCR ≥ 1.0");
			}
		}
	}

	const payment = monthlyPaymentCents(approvedAmountCents, rate, termMonths);
	// Disbursement at booking; anchor = today (UTC date).
	const now = new Date();
	const anchor = now.toISOString().slice(0, 10);
	const schedule = buildSchedule(approvedAmountCents, rate, termMonths, anchor);

	const decidedBy = input.route === "auto" ? "system" : "officer";
	const actor = input.route === "auto" ? "system" : (input.officerUserId ?? "officer");
	const snapshot = buildCreditSnapshot({
		inputs: {
			...(policyInputs as Record<string, unknown>),
			...(input.route === "officer"
				? { approvedAmountCents, termMonths, requestId: input.requestId }
				: {}),
		},
		score,
		grade,
		factors,
		rateBps: rate,
		monthlyPaymentCents: payment,
		reasons: policyReasons,
		actor,
		...(input.research !== undefined ? { research: input.research } : {}),
		decidedAt: now.toISOString(),
	});
	const reasonCodes = policyReasons.map((r) => r.code);

	const sameRequest = (requestId: string | null): boolean =>
		input.route === "officer" &&
		input.requestId !== null &&
		input.requestId !== undefined &&
		requestId === input.requestId;

	// (a) Decision in credit_applications. Replays into an existing decision
	// (same requestId for officer, any for auto); a conflicting decision
	// throws instead of writing a second row.
	const decisionId = await withTx(appsDb, async (tx) => {
		const apps = await tx
			.select()
			.from(applications)
			.where(eq(applications.id, input.applicationId))
			.for("update");
		const locked = apps[0];
		if (!locked) throw new Error(`application not found: ${input.applicationId}`);

		const existing = await tx
			.select()
			.from(decisions)
			.where(eq(decisions.applicationId, input.applicationId));
		if (existing[0]) {
			if (input.route === "officer" && !sameRequest(existing[0].requestId)) {
				throw conflict(`bookLoan: decision already exists for ${input.applicationId}`);
			}
			return existing[0].id;
		}

		if (input.route === "auto" && locked.status !== "processing") {
			throw conflict(`bookLoan: application is ${locked.status}, expected processing for auto`);
		}
		if (input.route === "officer" && locked.status !== "pending_review") {
			throw conflict(
				`bookLoan: application is ${locked.status}, expected pending_review for officer`,
			);
		}

		const inserted = await tx
			.insert(decisions)
			.values({
				applicationId: input.applicationId,
				outcome: "approved",
				decidedBy,
				officerUserId: input.route === "officer" ? (input.officerUserId ?? null) : null,
				requestId: input.route === "officer" ? (input.requestId ?? null) : null,
				approvedAmountCents,
				termMonths,
				rateBps: rate,
				reasons: policyReasons,
				notes: input.route === "officer" ? (input.notes ?? null) : null,
				snapshot,
				decidedAt: now,
			})
			.onConflictDoNothing({ target: decisions.applicationId })
			.returning({ id: decisions.id });
		if (!inserted[0]) {
			// Lost a race: replay the winner, write nothing.
			const winner = await tx
				.select()
				.from(decisions)
				.where(eq(decisions.applicationId, input.applicationId));
			if (!winner[0]) throw new Error("bookLoan: insert lost");
			if (input.route === "officer" && !sameRequest(winner[0].requestId)) {
				throw conflict(`bookLoan: decision already exists for ${input.applicationId}`);
			}
			return winner[0].id;
		}
		const id = inserted[0].id;
		const decisionPayload = {
			decisionId: id,
			applicationId: input.applicationId,
			outcome: "approved" as const,
			decidedBy,
			reasonCodes,
			approvedAmountCents,
			termMonths,
			rateBps: rate,
		};
		await writeAudit(tx, {
			applicationId: input.applicationId,
			actor,
			action: "decision.made",
			entity: "decision",
			payload: { ...decisionPayload, reference: locked.reference },
		});
		await insertOutbox(tx, {
			type: "decision.made",
			key: input.applicationId,
			payload: decisionPayload,
			dedupeKey: dedupeDecisionMade(id),
			applicationId: input.applicationId,
		});
		return id;
	});

	// (b) Loan + installments in credit_loans. Replays into the existing
	// loan when a previous attempt committed this step but not (c).
	const loanStep = await withTx(loansDb, async (tx) => {
		const existing = await tx
			.select()
			.from(loans)
			.where(eq(loans.applicationId, input.applicationId));
		if (existing[0]) {
			const loan = existing[0];
			return {
				loanId: loan.id,
				replayed: true,
				approvedAmountCents: loan.principalCents,
				termMonths: loan.termMonths,
				rateBps: loan.rateBps,
			};
		}
		const [loanRow] = await tx
			.insert(loans)
			.values({
				applicationId: input.applicationId,
				applicationReference: app.reference,
				applicantUserId: app.applicantUserId,
				product: app.product,
				principalCents: approvedAmountCents,
				termMonths,
				rateBps: rate,
				monthlyPaymentCents: payment,
				status: "active",
				disbursedAt: now,
				outstandingCents: approvedAmountCents,
				nextDueDate: schedule[0].dueDate,
			})
			.returning({ id: loans.id });
		await tx.insert(installments).values(
			schedule.map((s) => ({
				loanId: loanRow.id,
				number: s.number,
				dueDate: s.dueDate,
				principalCents: s.principalCents,
				interestCents: s.interestCents,
				totalCents: s.totalCents,
				paidCents: 0,
				status: "scheduled" as const,
			})),
		);
		await writeAudit(tx, {
			applicationId: input.applicationId,
			loanId: loanRow.id,
			actor,
			action: "loan.booked",
			entity: "loan",
			payload: {
				loanId: loanRow.id,
				principalCents: approvedAmountCents,
				termMonths,
				rateBps: rate,
			},
		});
		await insertOutbox(tx, {
			type: "loan.booked",
			key: input.applicationId,
			payload: {
				loanId: loanRow.id,
				applicationId: input.applicationId,
				principalCents: approvedAmountCents,
				termMonths,
				rateBps: rate,
				monthlyPaymentCents: payment,
			},
			dedupeKey: dedupeLoanBooked(loanRow.id),
			applicationId: input.applicationId,
			loanId: loanRow.id,
		});
		return {
			loanId: loanRow.id,
			replayed: false,
			approvedAmountCents,
			termMonths,
			rateBps: rate,
		};
	});

	// (c) Terminal flip in credit_applications. Conditional on a
	// non-terminal status — already-booked (retry after commit) is a no-op
	// success, and a terminal state is never overwritten.
	await withTx(appsDb, async (tx) => {
		const flipped = await tx
			.update(applications)
			.set({ status: "booked", decidedAt: now })
			.where(
				and(
					eq(applications.id, input.applicationId),
					inArray(applications.status, ["submitted", "processing", "pending_review"]),
				),
			)
			.returning({ id: applications.id });
		if (flipped[0]) {
			await writeAudit(tx, {
				applicationId: input.applicationId,
				loanId: loanStep.loanId,
				actor,
				action: "application.booked",
				entity: "application",
				payload: {
					decisionId,
					loanId: loanStep.loanId,
					reference: app.reference,
				},
			});
		}
	});

	return {
		decisionId,
		loanId: loanStep.loanId,
		replayed: loanStep.replayed,
		approvedAmountCents: loanStep.approvedAmountCents,
		termMonths: loanStep.termMonths,
		rateBps: loanStep.rateBps,
	};
}

/** Repair path for the reconciler (FR-6.9): a stale application whose
 * workflow is gone but whose approved decision survived (crash between saga
 * steps (a)/(b), or (b)/(c)). Re-invokes the saga with the persisted
 * application/terms/requestId binding — bookLoan replays the existing
 * decision and loan, then lands the terminal flip. */
export async function resumeBooking(applicationId: string): Promise<BookLoanResult> {
	const { db } = getApplicationsDb();
	const rows = await db.select().from(decisions).where(eq(decisions.applicationId, applicationId));
	const decision = rows[0];
	if (!decision) throw new Error(`resumeBooking: no decision for ${applicationId}`);
	if (decision.outcome !== "approved") {
		throw new Error(`resumeBooking: decision is ${decision.outcome} for ${applicationId}`);
	}
	const route = decision.decidedBy === "officer" ? "officer" : "auto";
	return bookLoan({
		applicationId,
		route,
		...(route === "officer"
			? {
					approvedAmountCents: decision.approvedAmountCents ?? undefined,
					termMonths: decision.termMonths ?? undefined,
					requestId: decision.requestId,
					officerUserId: decision.officerUserId,
					notes: decision.notes,
				}
			: {}),
	});
}
