// Decline paths + the FR-6.10 persistDecision helper: one transaction, row
// lock, expected-status + no-decision/no-loan guards, INSERT ... ON CONFLICT
// DO NOTHING with winner-replay. Status/audit/outbox are written only when
// this call won the insert; the persisted decision id feeds the dedupe key.

import {
	buildCheckOnlySnapshot,
	buildCreditSnapshot,
	type CheckReasonCode,
	dedupeDecisionMade,
	dedupeReviewExpired,
	dedupeReviewRequested,
	type Factor,
	type Grade,
	makeReason,
	type PolicyReason,
	rateBps,
} from "@credit/core";
import {
	applications,
	type Db,
	decisions,
	kycChecks,
	policyEvaluations,
	scores,
	withTx,
} from "@credit/db/applications";
import { loans } from "@credit/db/loans";
import { ApplicationFailure } from "@temporalio/activity";
import { eq } from "drizzle-orm";
import { getApplicationsDb, getLoansDb } from "../db.js";
import { type ApplicationRow, loadApplicationRow } from "./application.js";
import { insertOutbox, writeAudit } from "@credit/service-kit";
import type {
	ExpireReviewResult,
	PendingReviewResult,
	PersistCheckOnlyDeclineInput,
	PersistDecisionResult,
	PersistOfficerDeclineInput,
} from "./types.js";

export interface PersistDecisionData {
	outcome: "approved" | "declined";
	decidedBy: "system" | "officer";
	officerUserId?: string | null;
	requestId?: string | null;
	approvedAmountCents?: number | null;
	termMonths?: number | null;
	rateBps?: number | null;
	reasons: { code: string; text: string }[];
	notes?: string | null;
	snapshot: unknown;
}

function conflict(message: string): Error {
	return ApplicationFailure.create({
		message,
		type: "DecisionConflict",
		nonRetryable: true,
	});
}

export async function persistDecision(
	applicationId: string,
	expectedStatuses: string[],
	data: PersistDecisionData,
): Promise<{ decisionId: string; replayed: boolean }> {
	const { db } = getApplicationsDb();
	// Cross-DB guard (same check-then-act rationale as markFailed): a booked
	// loan means a decision already exists — never write a second one.
	const loanRows = await getLoansDb()
		.db.select({ id: loans.id })
		.from(loans)
		.where(eq(loans.applicationId, applicationId));
	if (loanRows[0]) {
		const replay = await db
			.select({ id: decisions.id })
			.from(decisions)
			.where(eq(decisions.applicationId, applicationId));
		if (replay[0]) return { decisionId: replay[0].id, replayed: true };
		throw conflict(`persistDecision: loan already exists for ${applicationId}`);
	}
	return withTx(db, async (tx) => {
		const apps = await tx
			.select()
			.from(applications)
			.where(eq(applications.id, applicationId))
			.for("update");
		const app = apps[0];
		if (!app) throw new Error(`application not found: ${applicationId}`);
		const existing = await tx
			.select({ id: decisions.id })
			.from(decisions)
			.where(eq(decisions.applicationId, applicationId));
		if (existing[0]) return { decisionId: existing[0].id, replayed: true };
		if (!expectedStatuses.includes(app.status)) {
			throw conflict(
				`persistDecision: application ${applicationId} is ${app.status}, expected ${expectedStatuses.join("|")}`,
			);
		}
		const now = new Date();
		const inserted = await tx
			.insert(decisions)
			.values({
				applicationId,
				outcome: data.outcome,
				decidedBy: data.decidedBy,
				officerUserId: data.officerUserId ?? null,
				requestId: data.requestId ?? null,
				approvedAmountCents: data.approvedAmountCents ?? null,
				termMonths: data.termMonths ?? null,
				rateBps: data.rateBps ?? null,
				reasons: data.reasons,
				notes: data.notes ?? null,
				snapshot: data.snapshot,
				decidedAt: now,
			})
			.onConflictDoNothing({ target: decisions.applicationId })
			.returning({ id: decisions.id });
		if (!inserted[0]) {
			// Lost a race with a concurrent writer: replay the winner, write nothing.
			const winner = await tx
				.select({ id: decisions.id })
				.from(decisions)
				.where(eq(decisions.applicationId, applicationId));
			if (!winner[0]) throw new Error("persistDecision: insert lost");
			return { decisionId: winner[0].id, replayed: true };
		}
		const decisionId = inserted[0].id;
		// ponytail: only declines flow through this helper; approvals book
		// decision+loan+installments atomically in bookLoan.
		await tx
			.update(applications)
			.set({ status: "declined", decidedAt: now })
			.where(eq(applications.id, applicationId));
		const reasonCodes = data.reasons.map((r) => r.code);
		await writeAudit(tx, {
			applicationId,
			actor: data.decidedBy === "officer" ? (data.officerUserId ?? "officer") : "system",
			action: "decision.made",
			entity: "decision",
			payload: {
				decisionId,
				outcome: data.outcome,
				decidedBy: data.decidedBy,
				reasonCodes,
			},
		});
		await insertOutbox(tx, {
			type: "decision.made",
			key: applicationId,
			payload: {
				decisionId,
				applicationId,
				outcome: data.outcome,
				decidedBy: data.decidedBy,
				reasonCodes,
				...(data.approvedAmountCents !== null && data.approvedAmountCents !== undefined
					? { approvedAmountCents: data.approvedAmountCents }
					: {}),
				...(data.termMonths !== null && data.termMonths !== undefined
					? { termMonths: data.termMonths }
					: {}),
				...(data.rateBps !== null && data.rateBps !== undefined ? { rateBps: data.rateBps } : {}),
			},
			dedupeKey: dedupeDecisionMade(decisionId),
			applicationId,
		});
		return { decisionId, replayed: false };
	});
}

interface CreditContext {
	app: ApplicationRow;
	score: number;
	grade: Grade;
	factors: Factor[];
	newPaymentCents: number;
	policyInputs: unknown;
	policyReasons: PolicyReason[];
}

/** Score + policy rows every credit snapshot needs (both ran upstream). */
async function loadCreditContext(db: Db, applicationId: string): Promise<CreditContext> {
	const app = await loadApplicationRow(applicationId);
	const scoreRows = await db.select().from(scores).where(eq(scores.applicationId, applicationId));
	const policyRows = await db
		.select()
		.from(policyEvaluations)
		.where(eq(policyEvaluations.applicationId, applicationId));
	const scoreRow = scoreRows[0];
	const policyRow = policyRows[0];
	if (!scoreRow || !policyRow) {
		throw new Error(`decision context missing for ${applicationId}`);
	}
	return {
		app,
		score: scoreRow.score,
		grade: scoreRow.grade as Grade,
		factors: scoreRow.factors as Factor[],
		newPaymentCents: (scoreRow.affordability as { newPaymentCents: number }).newPaymentCents,
		policyInputs: policyRow.inputs,
		policyReasons: policyRow.reasons as PolicyReason[],
	};
}

/** System policy decline, expected ['processing'] (FR-6.10). FR-4.6: the
 * primary policy code plus up to 3 negative factor codes. */
export async function persistDecline(input: {
	applicationId: string;
}): Promise<PersistDecisionResult> {
	const { db } = getApplicationsDb();
	const ctx = await loadCreditContext(db, input.applicationId);
	const negative = [...ctx.factors]
		.filter((f) => f.points < 0)
		.sort((a, b) => a.points - b.points)
		.slice(0, 3)
		.map((f) => ({ code: f.code, text: f.label }));
	const primary = ctx.policyReasons[0] ?? makeReason("SCORE_TOO_LOW");
	const snapshot = buildCreditSnapshot({
		inputs: ctx.policyInputs,
		score: ctx.score,
		grade: ctx.grade,
		factors: ctx.factors,
		rateBps: rateBps(ctx.grade, ctx.app.product),
		monthlyPaymentCents: ctx.newPaymentCents,
		reasons: ctx.policyReasons,
		actor: "system",
		decidedAt: new Date().toISOString(),
	});
	const { decisionId, replayed } = await persistDecision(input.applicationId, ["processing"], {
		outcome: "declined",
		decidedBy: "system",
		reasons: [primary, ...negative],
		snapshot,
	});
	return { decisionId, replayed, status: "declined" };
}

/** Check-only decline (FR-2.2): no amounts, snapshot kind 'check_only'. */
export async function persistCheckOnlyDecline(
	input: PersistCheckOnlyDeclineInput,
): Promise<PersistDecisionResult> {
	const reasons = input.reasons.map((code: CheckReasonCode) => makeReason(code));
	const { db } = getApplicationsDb();
	const checks = await db
		.select()
		.from(kycChecks)
		.where(eq(kycChecks.applicationId, input.applicationId));
	const checkList = checks.map((c) => ({
		type: c.type,
		status: c.status as "passed" | "failed",
	}));
	const snapshot = buildCheckOnlySnapshot({
		inputs: { applicationId: input.applicationId, checks: checkList },
		checks: checkList,
		reasons,
		actor: "system",
		decidedAt: new Date().toISOString(),
	});
	const { decisionId, replayed } = await persistDecision(input.applicationId, ["processing"], {
		outcome: "declined",
		decidedBy: "system",
		reasons,
		snapshot,
	});
	return { decisionId, replayed, status: "declined" };
}

/** Officer decline, expected ['pending_review'] (FR-6.2/6.10). */
export async function persistOfficerDecline(
	input: PersistOfficerDeclineInput,
): Promise<PersistDecisionResult> {
	const { db } = getApplicationsDb();
	const ctx = await loadCreditContext(db, input.applicationId);
	const reasons = [makeReason(input.reasonCode)];
	const snapshot = buildCreditSnapshot({
		inputs: ctx.policyInputs,
		score: ctx.score,
		grade: ctx.grade,
		factors: ctx.factors,
		rateBps: rateBps(ctx.grade, ctx.app.product),
		monthlyPaymentCents: ctx.newPaymentCents,
		reasons,
		actor: input.officerUserId ?? "officer",
		decidedAt: new Date().toISOString(),
	});
	const { decisionId, replayed } = await persistDecision(input.applicationId, ["pending_review"], {
		outcome: "declined",
		decidedBy: "officer",
		officerUserId: input.officerUserId ?? null,
		requestId: input.requestId,
		reasons,
		notes: input.notes,
		snapshot,
	});
	return { decisionId, replayed, status: "declined" };
}

/** Refer step: status → pending_review + outbox review.requested, one tx.
 * Replaying on an already-pending case re-inserts (dedupe no-op). */
export async function markPendingReview(input: {
	applicationId: string;
}): Promise<PendingReviewResult> {
	const { db } = getApplicationsDb();
	return withTx(db, async (tx) => {
		const apps = await tx
			.select()
			.from(applications)
			.where(eq(applications.id, input.applicationId))
			.for("update");
		const app = apps[0];
		if (!app) throw new Error(`application not found: ${input.applicationId}`);
		if (app.status !== "processing" && app.status !== "pending_review") {
			throw conflict(`markPendingReview: application is ${app.status}, expected processing`);
		}
		const policyRows = await tx
			.select()
			.from(policyEvaluations)
			.where(eq(policyEvaluations.applicationId, input.applicationId));
		const reasonCodes = ((policyRows[0]?.reasons as PolicyReason[] | undefined) ?? []).map(
			(r) => r.code,
		);
		if (app.status === "processing") {
			await tx
				.update(applications)
				.set({ status: "pending_review" })
				.where(eq(applications.id, input.applicationId));
		}
		await writeAudit(tx, {
			applicationId: input.applicationId,
			actor: "system",
			action: "review.requested",
			entity: "application",
			payload: { reference: app.reference, reasonCodes },
		});
		await insertOutbox(tx, {
			type: "review.requested",
			key: input.applicationId,
			payload: {
				applicationId: input.applicationId,
				reference: app.reference,
				reasonCodes,
			},
			dedupeKey: dedupeReviewRequested(input.applicationId),
			applicationId: input.applicationId,
		});
		return { status: "pending_review" };
	});
}

/** 72h-timeout expiry (FR-6.4): conditional — a raced decision/loan or a
 * non-pending status yields { expired: false } instead of overwriting. */
export async function expireReview(input: { applicationId: string }): Promise<ExpireReviewResult> {
	const { db } = getApplicationsDb();
	return withTx(db, async (tx) => {
		const apps = await tx
			.select()
			.from(applications)
			.where(eq(applications.id, input.applicationId))
			.for("update");
		const app = apps[0];
		if (!app) throw new Error(`application not found: ${input.applicationId}`);
		if (app.status !== "pending_review") return { expired: false };
		const decisionRows = await tx
			.select({ id: decisions.id })
			.from(decisions)
			.where(eq(decisions.applicationId, input.applicationId));
		// Loan check is cross-DB (check-then-act, see markFailed).
		const loanRows = await getLoansDb()
			.db.select({ id: loans.id })
			.from(loans)
			.where(eq(loans.applicationId, input.applicationId));
		if (decisionRows[0] || loanRows[0]) return { expired: false };
		await tx
			.update(applications)
			.set({ status: "expired" })
			.where(eq(applications.id, input.applicationId));
		await writeAudit(tx, {
			applicationId: input.applicationId,
			actor: "system",
			action: "review.expired",
			entity: "application",
			payload: { reference: app.reference },
		});
		await insertOutbox(tx, {
			type: "review.expired",
			key: input.applicationId,
			payload: {
				applicationId: input.applicationId,
				reference: app.reference,
			},
			dedupeKey: dedupeReviewExpired(input.applicationId),
			applicationId: input.applicationId,
		});
		return { expired: true };
	});
}
