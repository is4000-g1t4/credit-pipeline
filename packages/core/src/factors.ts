// Single source of truth for score factor codes/points (SPEC FR-4.5).

export type FactorImpact = "positive" | "negative" | "neutral";

export type FactorCode =
	| "EMPLOYMENT_TENURE"
	| "DELINQUENCIES"
	| "CREDIT_UTILIZATION"
	| "BANK_RELATIONSHIP"
	| "TRADING_HISTORY"
	| "REVENUE_SCALE"
	| "SECTOR_RISK"
	| "DEBT_BURDEN";

export interface Factor {
	code: FactorCode;
	label: string;
	points: number;
	impact: FactorImpact;
}

export const FACTOR_LABELS: Record<FactorCode, string> = {
	EMPLOYMENT_TENURE: "Employment tenure",
	DELINQUENCIES: "Delinquencies",
	CREDIT_UTILIZATION: "Credit utilization",
	BANK_RELATIONSHIP: "Bank relationship",
	TRADING_HISTORY: "Trading history",
	REVENUE_SCALE: "Revenue scale",
	SECTOR_RISK: "Sector risk",
	DEBT_BURDEN: "Debt burden",
};

export function makeFactor(code: FactorCode, points: number): Factor {
	const clean = points === 0 ? 0 : points; // normalize -0 (e.g. -40 * 0 delinquencies)
	return {
		code,
		label: FACTOR_LABELS[code],
		points: clean,
		impact: clean > 0 ? "positive" : clean < 0 ? "negative" : "neutral",
	};
}

/** Deterministic order: |points| desc, then code asc. */
export function sortFactors(factors: Factor[]): Factor[] {
	return [...factors].sort((a, b) => {
		const byPoints = Math.abs(b.points) - Math.abs(a.points);
		if (byPoints !== 0) return byPoints;
		return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
	});
}
