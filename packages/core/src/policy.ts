// Policy engine v1.0 (SPEC FR-5.1–5.6): pure, frozen thresholds, integer
// comparisons only. First-match hard declines → auto conditions → refer with
// prioritized reasons (≤ 4). Reason texts come only from reasons.ts.

import { hashCanonical } from "./canonical.js";
import {
	AUTO_LIMIT_PERSONAL_CENTS,
	AUTO_LIMIT_SME_CENTS,
	AUTO_SCORE,
	DSCR_AUTO_MIN_X100,
	DSCR_DECLINE_MIN_X100,
	DTI_AUTO_MAX_PCT_X100,
	DTI_DECLINE_MAX_PCT_X100,
	type Industry,
	MIN_EMPLOYMENT_YEARS,
	MIN_SCORE,
	PERSONAL_MAX_CENTS,
	PERSONAL_MIN_CENTS,
	POLICY_VERSION,
	SME_AUTO_TRADING_YEARS,
	SME_MAX_CENTS,
	SME_MIN_CENTS,
	SME_MIN_REVENUE_CENTS,
	SME_MIN_TRADING_YEARS,
	TERM_MAX_MONTHS,
	TERM_MIN_MONTHS,
} from "./constants.js";
import { dscrGte, dtiLte } from "./money.js";
import { makeReason, type PolicyReason, type ReasonCode } from "./reasons.js";

export type PolicyOutcome = "auto_approve" | "refer" | "decline";

export type PolicyInputs =
	| {
			kind: "individual";
			score: number;
			existingDebtCents: number;
			monthlyIncomeCents: number;
			newPaymentCents: number;
			amountCents: number;
			termMonths: number;
			employmentYears: number;
	  }
	| {
			kind: "sme";
			blendedScore: number;
			monthlyFcfCents: number;
			existingDebtServiceCents: number;
			newPaymentCents: number;
			amountCents: number;
			termMonths: number;
			yearsTrading: number;
			annualRevenueCents: number;
			industry: Industry;
	  };

export interface PolicyEvaluation {
	outcome: PolicyOutcome;
	reasons: PolicyReason[];
	policyVersion: string;
	maxAmountCents: number;
	inputHash: string;
	inputs: PolicyInputs;
}

const MAX_REFER_REASONS = 4;

function decline(code: ReasonCode, inputs: PolicyInputs, amountCents: number): PolicyEvaluation {
	return {
		outcome: "decline",
		reasons: [makeReason(code)],
		policyVersion: POLICY_VERSION,
		maxAmountCents: amountCents,
		inputHash: hashCanonical(inputs),
		inputs,
	};
}

function toReasons(codes: ReasonCode[]): PolicyReason[] {
	return codes.slice(0, MAX_REFER_REASONS).map(makeReason);
}

function evaluateIndividual(
	inputs: Extract<PolicyInputs, { kind: "individual" }>,
): PolicyEvaluation {
	const { score, existingDebtCents, monthlyIncomeCents, newPaymentCents } = inputs;
	if (inputs.amountCents < PERSONAL_MIN_CENTS || inputs.amountCents > PERSONAL_MAX_CENTS) {
		return decline("AMOUNT_OUT_OF_RANGE", inputs, inputs.amountCents);
	}
	if (inputs.termMonths < TERM_MIN_MONTHS || inputs.termMonths > TERM_MAX_MONTHS) {
		return decline("TERM_OUT_OF_RANGE", inputs, inputs.amountCents);
	}
	if (!dtiLte(existingDebtCents, newPaymentCents, monthlyIncomeCents, DTI_DECLINE_MAX_PCT_X100)) {
		return decline("DTI_TOO_HIGH", inputs, inputs.amountCents);
	}
	if (score < MIN_SCORE) return decline("SCORE_TOO_LOW", inputs, inputs.amountCents);

	if (
		score >= AUTO_SCORE &&
		dtiLte(existingDebtCents, newPaymentCents, monthlyIncomeCents, DTI_AUTO_MAX_PCT_X100) &&
		inputs.amountCents <= AUTO_LIMIT_PERSONAL_CENTS &&
		inputs.employmentYears >= MIN_EMPLOYMENT_YEARS
	) {
		return {
			outcome: "auto_approve",
			reasons: [],
			policyVersion: POLICY_VERSION,
			maxAmountCents: inputs.amountCents,
			inputHash: hashCanonical(inputs),
			inputs,
		};
	}

	// Priority: amount → score → affordability → tenure.
	const codes: ReasonCode[] = [];
	if (inputs.amountCents > AUTO_LIMIT_PERSONAL_CENTS) codes.push("AMOUNT_ABOVE_AUTO_LIMIT");
	if (score < AUTO_SCORE) codes.push("SCORE_IN_REFER_BAND");
	if (!dtiLte(existingDebtCents, newPaymentCents, monthlyIncomeCents, DTI_AUTO_MAX_PCT_X100)) {
		codes.push("DTI_IN_REFER_BAND");
	}
	if (inputs.employmentYears < MIN_EMPLOYMENT_YEARS) codes.push("SHORT_EMPLOYMENT");
	return {
		outcome: "refer",
		reasons: toReasons(codes),
		policyVersion: POLICY_VERSION,
		maxAmountCents: inputs.amountCents,
		inputHash: hashCanonical(inputs),
		inputs,
	};
}

function evaluateSme(inputs: Extract<PolicyInputs, { kind: "sme" }>): PolicyEvaluation {
	const { blendedScore, monthlyFcfCents, existingDebtServiceCents, newPaymentCents } = inputs;
	if (inputs.amountCents < SME_MIN_CENTS || inputs.amountCents > SME_MAX_CENTS) {
		return decline("AMOUNT_OUT_OF_RANGE", inputs, inputs.amountCents);
	}
	if (inputs.termMonths < TERM_MIN_MONTHS || inputs.termMonths > TERM_MAX_MONTHS) {
		return decline("TERM_OUT_OF_RANGE", inputs, inputs.amountCents);
	}
	if (inputs.annualRevenueCents < SME_MIN_REVENUE_CENTS) {
		return decline("REVENUE_TOO_LOW", inputs, inputs.amountCents);
	}
	if (inputs.yearsTrading < SME_MIN_TRADING_YEARS) {
		return decline("TRADING_HISTORY_TOO_SHORT", inputs, inputs.amountCents);
	}
	if (!dscrGte(monthlyFcfCents, newPaymentCents, existingDebtServiceCents, DSCR_DECLINE_MIN_X100)) {
		return decline("DSCR_TOO_LOW", inputs, inputs.amountCents);
	}
	if (blendedScore < MIN_SCORE) return decline("SCORE_TOO_LOW", inputs, inputs.amountCents);

	if (
		blendedScore >= AUTO_SCORE &&
		dscrGte(monthlyFcfCents, newPaymentCents, existingDebtServiceCents, DSCR_AUTO_MIN_X100) &&
		inputs.amountCents <= AUTO_LIMIT_SME_CENTS &&
		inputs.yearsTrading >= SME_AUTO_TRADING_YEARS
	) {
		return {
			outcome: "auto_approve",
			reasons: [],
			policyVersion: POLICY_VERSION,
			maxAmountCents: inputs.amountCents,
			inputHash: hashCanonical(inputs),
			inputs,
		};
	}

	// Priority: amount → score → affordability → tenure → sector. SECTOR_REVIEW
	// is explanatory only: the auto check above ignores sector, so a risky
	// sector alone can never force a refer.
	const codes: ReasonCode[] = [];
	if (inputs.amountCents > AUTO_LIMIT_SME_CENTS) codes.push("AMOUNT_ABOVE_AUTO_LIMIT");
	if (blendedScore < AUTO_SCORE) codes.push("SCORE_IN_REFER_BAND");
	if (!dscrGte(monthlyFcfCents, newPaymentCents, existingDebtServiceCents, DSCR_AUTO_MIN_X100)) {
		codes.push("DSCR_IN_REFER_BAND");
	}
	if (inputs.yearsTrading < SME_AUTO_TRADING_YEARS) {
		codes.push("TRADING_HISTORY_IN_REFER_BAND");
	}
	if (inputs.industry === "hospitality" || inputs.industry === "construction") {
		codes.push("SECTOR_REVIEW");
	}
	return {
		outcome: "refer",
		reasons: toReasons(codes),
		policyVersion: POLICY_VERSION,
		maxAmountCents: inputs.amountCents,
		inputHash: hashCanonical(inputs),
		inputs,
	};
}

export function evaluatePolicy(inputs: PolicyInputs): PolicyEvaluation {
	return inputs.kind === "individual" ? evaluateIndividual(inputs) : evaluateSme(inputs);
}
