// Shared domain constants — SPEC FR-4.4, FR-5, FR-8.1. Single source of truth
// for versions, grade bands, the rate card, and product bounds.

export const SCORECARD_VERSION = "scorecard-v1";
export const POLICY_VERSION = "policy-v1.0";

export type Grade = "A" | "B" | "C" | "D" | "E";
export type Product = "personal_loan" | "sme_term_loan";
export type Industry = "hospitality" | "retail" | "services" | "construction" | "other";

/** Minimum score for each grade (A ≥ 760, B 700–759, C 640–699, D 580–639, E < 580). */
export const GRADE_MIN_SCORE: Record<Grade, number> = {
	A: 760,
	B: 700,
	C: 640,
	D: 580,
	E: Number.NEGATIVE_INFINITY,
};

export function gradeForScore(score: number): Grade {
	if (score >= GRADE_MIN_SCORE.A) return "A";
	if (score >= GRADE_MIN_SCORE.B) return "B";
	if (score >= GRADE_MIN_SCORE.C) return "C";
	if (score >= GRADE_MIN_SCORE.D) return "D";
	return "E";
}

// --- Rate card (FR-8.1): rateBps = 650 + gradeSpread + productMargin, cap 2400.
export const BASE_RATE_BPS = 650;
export const GRADE_SPREAD_BPS: Record<Grade, number> = {
	A: 0,
	B: 100,
	C: 250,
	D: 400,
	E: 600,
};
export const PRODUCT_MARGIN_BPS: Record<Product, number> = {
	personal_loan: 0,
	sme_term_loan: 90,
};
export const MAX_RATE_BPS = 2400;

// --- Product bounds (FR-1.5), integer cents.
export const PERSONAL_MIN_CENTS = 100000; // $1,000
export const PERSONAL_MAX_CENTS = 2500000; // $25,000
export const SME_MIN_CENTS = 500000; // $5,000
export const SME_MAX_CENTS = 10000000; // $100,000
export const TERM_MIN_MONTHS = 12;
export const TERM_MAX_MONTHS = 60;

// --- Auto-approval amount limits (FR-5.2), integer cents.
export const AUTO_LIMIT_PERSONAL_CENTS = 1500000; // $15,000
export const AUTO_LIMIT_SME_CENTS = 2500000; // $25,000

// --- Policy thresholds (FR-5.1/5.2), integer-friendly units.
export const MIN_SCORE = 580;
export const AUTO_SCORE = 700;
export const DTI_AUTO_MAX_PCT_X100 = 3500; // 35%
export const DTI_DECLINE_MAX_PCT_X100 = 5000; // 50%
export const DSCR_AUTO_MIN_X100 = 150; // 1.5
export const DSCR_DECLINE_MIN_X100 = 100; // 1.0
export const SME_MIN_REVENUE_CENTS = 5000000; // $50,000
export const MIN_EMPLOYMENT_YEARS = 1;
export const SME_MIN_TRADING_YEARS = 1;
export const SME_AUTO_TRADING_YEARS = 2;
export const MIN_MONTHLY_INCOME_CENTS = 100000; // $1,000 (FR-1.3)
