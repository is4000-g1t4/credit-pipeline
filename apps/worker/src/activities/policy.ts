// Policy evaluation (SPEC FR-5): builds PolicyInputs from the application +
// persisted score, runs core evaluatePolicy, upserts policy_evaluations on
// (application_id,policy_version) with the inputs snapshot + input_hash.

import { evaluatePolicy, type PolicyInputs } from "@credit/core";
import { policyEvaluations, scores, withTx } from "@credit/db/applications";
import { eq } from "drizzle-orm";
import { getApplicationsDb } from "../db.js";
import { loadApplicationRow } from "./application.js";
import { writeAudit } from "@credit/service-kit";
import type { PolicyDecision } from "./types.js";

export async function evaluateAndPersistPolicy(input: {
	applicationId: string;
}): Promise<PolicyDecision> {
	const app = await loadApplicationRow(input.applicationId);
	const { db } = getApplicationsDb();
	const scoreRows = await db
		.select()
		.from(scores)
		.where(eq(scores.applicationId, input.applicationId));
	const scoreRow = scoreRows[0];
	if (!scoreRow) {
		throw new Error(`evaluateAndPersistPolicy: missing score for ${input.applicationId}`);
	}
	const affordability = scoreRow.affordability as { newPaymentCents: number };

	let policyInputs: PolicyInputs;
	if (app.type === "individual") {
		const fin = app.financial as {
			employmentYears: number;
			monthlyIncomeCents: number;
			existingDebtCents: number;
		};
		policyInputs = {
			kind: "individual",
			score: scoreRow.score,
			existingDebtCents: fin.existingDebtCents,
			monthlyIncomeCents: fin.monthlyIncomeCents,
			newPaymentCents: affordability.newPaymentCents,
			amountCents: app.amountCents,
			termMonths: app.termMonths,
			employmentYears: fin.employmentYears,
		};
	} else {
		const biz = app.business as {
			yearsTrading: number;
			annualRevenueCents: number;
			industry: "hospitality" | "retail" | "services" | "construction" | "other";
			existingDebtServiceCents: number;
			monthlyFcfCents: number;
		};
		policyInputs = {
			kind: "sme",
			blendedScore: scoreRow.score,
			monthlyFcfCents: biz.monthlyFcfCents,
			existingDebtServiceCents: biz.existingDebtServiceCents,
			newPaymentCents: affordability.newPaymentCents,
			amountCents: app.amountCents,
			termMonths: app.termMonths,
			yearsTrading: biz.yearsTrading,
			annualRevenueCents: biz.annualRevenueCents,
			industry: biz.industry,
		};
	}

	const evaluation = evaluatePolicy(policyInputs);
	await withTx(db, async (tx) => {
		await tx
			.insert(policyEvaluations)
			.values({
				applicationId: input.applicationId,
				policyVersion: evaluation.policyVersion,
				outcome: evaluation.outcome,
				reasons: evaluation.reasons,
				maxAmountCents: evaluation.maxAmountCents,
				inputs: evaluation.inputs,
				inputHash: evaluation.inputHash,
			})
			.onConflictDoUpdate({
				target: [policyEvaluations.applicationId, policyEvaluations.policyVersion],
				set: {
					outcome: evaluation.outcome,
					reasons: evaluation.reasons,
					maxAmountCents: evaluation.maxAmountCents,
					inputs: evaluation.inputs,
					inputHash: evaluation.inputHash,
				},
			});
		await writeAudit(tx, {
			applicationId: input.applicationId,
			actor: "system",
			action: "policy.evaluated",
			entity: "policy_evaluation",
			payload: {
				policyVersion: evaluation.policyVersion,
				outcome: evaluation.outcome,
				reasonCodes: evaluation.reasons.map((r) => r.code),
				maxAmountCents: evaluation.maxAmountCents,
			},
		});
	});

	return {
		outcome: evaluation.outcome,
		reasons: evaluation.reasons,
		maxAmountCents: evaluation.maxAmountCents,
	};
}
