// Shared activity helpers (one home so booking and the decline paths
// can't drift): the score+policy context every credit snapshot needs, plus
// the non-retryable Temporal failure constructors.
import type { Factor, Grade, PolicyReason } from "@credit/core";
import { policyEvaluations, scores, type Db } from "@credit/db/applications";
import { ApplicationFailure } from "@temporalio/activity";
import { eq } from "drizzle-orm";
import { loadApplicationRow, type ApplicationRow } from "./application.js";

export interface CreditContext {
	app: ApplicationRow;
	score: number;
	grade: Grade;
	factors: Factor[];
	newPaymentCents: number;
	policyInputs: unknown;
	policyReasons: PolicyReason[];
}

/** Score + policy rows every credit snapshot needs (both ran upstream). */
export async function loadCreditContext(db: Db, applicationId: string): Promise<CreditContext> {
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

/** Non-retryable: caller-supplied terms fail validation. */
export function invalid(message: string): Error {
	return ApplicationFailure.create({
		message,
		type: "InvalidTerms",
		nonRetryable: true,
	});
}

/** Non-retryable: the case state conflicts with the decision. */
export function conflict(message: string): Error {
	return ApplicationFailure.create({
		message,
		type: "DecisionConflict",
		nonRetryable: true,
	});
}
