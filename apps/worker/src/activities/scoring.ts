// Scoring (SPEC FR-4): score → grade → rate → payment → affordability, then
// upsert scores on (application_id,model_version). This is the one place the
// payment is computed before policy (FR-4.1: score/grade amount-independent;
// DTI/DSCR need the priced payment).

import {
	computeAffordability,
	type Grade,
	individualScore,
	monthlyPaymentCents,
	type Product,
	rateBps,
	smeScores,
} from "@credit/core";
import { externalReports, scores, withTx } from "@credit/db/applications";
import { eq } from "drizzle-orm";
import { getApplicationsDb } from "../db.js";
import { loadApplicationRow } from "./application.js";
import { writeAudit } from "@credit/service-kit";
import type { ScoringSummary } from "./types.js";

export async function scoreAndPersist(input: { applicationId: string }): Promise<ScoringSummary> {
	const app = await loadApplicationRow(input.applicationId);
	const product = app.product as Product;
	const { db } = getApplicationsDb();
	const reports = await db
		.select()
		.from(externalReports)
		.where(eq(externalReports.applicationId, input.applicationId));
	const bureau = reports.find((r) => r.kind === "bureau")?.payload as {
		bureauScore: number;
		delinquencies: number;
		utilizationPct: number;
	} | null;
	const bank = reports.find((r) => r.kind === "bank")?.payload as {
		monthlyFreeCashFlowCents: number;
	} | null;
	if (!bureau || !bank) {
		throw new Error(`scoreAndPersist: missing bureau/bank reports for ${input.applicationId}`);
	}

	let score: number;
	let grade: Grade;
	let modelVersion: string;
	let factors: unknown;
	let components: unknown;
	let affordability: { newPaymentCents: number } & Record<string, unknown>;
	let monthlyIncomeCents: number | null = null;
	let existingDebtCents: number | null = null;
	let monthlyFcfCents: number | null = null;
	let existingDebtServiceCents: number | null = null;

	if (app.type === "individual") {
		const fin = app.financial as {
			employmentYears: number;
			monthlyIncomeCents: number;
			existingDebtCents: number;
			bankRelationshipYears: number;
		};
		const result = individualScore({
			bureauScore: bureau.bureauScore,
			employmentYears: fin.employmentYears,
			delinquencies: bureau.delinquencies,
			utilizationPct: bureau.utilizationPct,
			bankRelationshipYears: fin.bankRelationshipYears,
		});
		score = result.score;
		grade = result.grade;
		modelVersion = result.scorecardVersion;
		factors = result.factors;
		components = null;
		monthlyIncomeCents = fin.monthlyIncomeCents;
		existingDebtCents = fin.existingDebtCents;
		const rate = rateBps(grade, product);
		const payment = monthlyPaymentCents(app.amountCents, rate, app.termMonths);
		affordability = {
			...computeAffordability({
				kind: "individual",
				monthlyIncomeCents: fin.monthlyIncomeCents,
				existingDebtCents: fin.existingDebtCents,
				newPaymentCents: payment,
			}),
		};
	} else {
		const biz = app.business as {
			yearsTrading: number;
			annualRevenueCents: number;
			industry: "hospitality" | "retail" | "services" | "construction" | "other";
			existingDebtServiceCents: number;
			monthlyFcfCents: number;
		};
		const result = smeScores({
			ownerBureauScore: bureau.bureauScore,
			yearsTrading: biz.yearsTrading,
			annualRevenueCents: biz.annualRevenueCents,
			industry: biz.industry,
			existingDebtServiceCents: biz.existingDebtServiceCents,
		});
		score = result.blendedScore;
		grade = result.grade;
		modelVersion = result.scorecardVersion;
		factors = result.factors;
		components = {
			ownerScore: result.ownerScore,
			businessScore: result.businessScore,
		};
		monthlyFcfCents = bank.monthlyFreeCashFlowCents;
		existingDebtServiceCents = biz.existingDebtServiceCents;
		const rate = rateBps(grade, product);
		const payment = monthlyPaymentCents(app.amountCents, rate, app.termMonths);
		affordability = {
			...computeAffordability({
				kind: "sme",
				monthlyFreeCashFlowCents: bank.monthlyFreeCashFlowCents,
				existingDebtServiceCents: biz.existingDebtServiceCents,
				newPaymentCents: payment,
			}),
		};
	}

	const rate = rateBps(grade, product);
	const newPaymentCents = affordability.newPaymentCents;
	await withTx(db, async (tx) => {
		await tx
			.insert(scores)
			.values({
				applicationId: input.applicationId,
				modelVersion,
				score,
				grade,
				components,
				factors,
				affordability,
			})
			.onConflictDoUpdate({
				target: [scores.applicationId, scores.modelVersion],
				set: { score, grade, components, factors, affordability },
			});
		await writeAudit(tx, {
			applicationId: input.applicationId,
			actor: "system",
			action: "score.computed",
			entity: "score",
			payload: { modelVersion, score, grade, newPaymentCents, mock: true },
		});
	});

	return {
		kind: app.type,
		score,
		grade,
		product,
		requestedAmountCents: app.amountCents,
		requestedTermMonths: app.termMonths,
		rateBps: rate,
		newPaymentCents,
		monthlyIncomeCents,
		existingDebtCents,
		monthlyFcfCents,
		existingDebtServiceCents,
	};
}
