// Scorecard v1 (SPEC FR-4.2/4.3): pure, amount-independent. Score/grade never
// depend on payment, amount, or term — pricing and affordability come after.
import { type Grade, gradeForScore, type Industry, SCORECARD_VERSION } from "./constants.js";
import { type Factor, makeFactor, sortFactors } from "./factors.js";

export interface IndividualScoreInputs {
	bureauScore: number;
	employmentYears: number;
	delinquencies: number;
	/** Credit utilization percent, 0–100. */
	utilizationPct: number;
	bankRelationshipYears: number;
}

export interface IndividualScoreResult {
	score: number;
	grade: Grade;
	factors: Factor[];
	scorecardVersion: string;
}

function clampScore(score: number): number {
	return Math.min(850, Math.max(300, Math.round(score)));
}

export function individualScore(inputs: IndividualScoreInputs): IndividualScoreResult {
	const employmentAdj = Math.min(inputs.employmentYears, 10) * 3;
	const delinquencyAdj = -40 * Math.min(inputs.delinquencies, 3);
	const utilizationAdj = inputs.utilizationPct > 50 ? -20 : inputs.utilizationPct > 30 ? -10 : 5;
	const relationshipAdj = Math.min(inputs.bankRelationshipYears, 5) * 4;
	const score = clampScore(
		inputs.bureauScore + employmentAdj + delinquencyAdj + utilizationAdj + relationshipAdj,
	);
	const factors = sortFactors([
		makeFactor("EMPLOYMENT_TENURE", employmentAdj),
		makeFactor("DELINQUENCIES", delinquencyAdj),
		makeFactor("CREDIT_UTILIZATION", utilizationAdj),
		makeFactor("BANK_RELATIONSHIP", relationshipAdj),
	]);
	return {
		score,
		grade: gradeForScore(score),
		factors,
		scorecardVersion: SCORECARD_VERSION,
	};
}

export interface SmeScoreInputs {
	ownerBureauScore: number;
	yearsTrading: number;
	annualRevenueCents: number;
	industry: Industry;
	existingDebtServiceCents: number;
}

export interface SmeScoreResult {
	ownerScore: number;
	businessScore: number;
	blendedScore: number;
	grade: Grade;
	factors: Factor[];
	scorecardVersion: string;
}

const SECTOR_ADJ: Record<Industry, number> = {
	hospitality: -30,
	retail: -10,
	construction: -20,
	services: 0,
	other: 0,
};

export function smeScores(inputs: SmeScoreInputs): SmeScoreResult {
	const tradingAdj = Math.min(inputs.yearsTrading, 10) * 13;
	const revenueAdj =
		inputs.annualRevenueCents >= 100000000
			? 40
			: inputs.annualRevenueCents >= 50000000
				? 30
				: inputs.annualRevenueCents >= 25000000
					? 20
					: 0;
	const sectorAdj = SECTOR_ADJ[inputs.industry];
	// Integer rule: debtService > 0.25 * (annualRevenue/12) ⇔ debtService * 48 > annualRevenue.
	const debtAdj =
		BigInt(inputs.existingDebtServiceCents) * 48n > BigInt(inputs.annualRevenueCents) ? -40 : 0;
	const businessScore = clampScore(560 + tradingAdj + revenueAdj + sectorAdj + debtAdj);
	const blendedScore = clampScore(Math.round(0.4 * inputs.ownerBureauScore + 0.6 * businessScore));
	const factors = sortFactors([
		makeFactor("TRADING_HISTORY", tradingAdj),
		makeFactor("REVENUE_SCALE", revenueAdj),
		makeFactor("SECTOR_RISK", sectorAdj),
		makeFactor("DEBT_BURDEN", debtAdj),
	]);
	return {
		ownerScore: inputs.ownerBureauScore,
		businessScore,
		blendedScore,
		grade: gradeForScore(blendedScore),
		factors,
		scorecardVersion: SCORECARD_VERSION,
	};
}
