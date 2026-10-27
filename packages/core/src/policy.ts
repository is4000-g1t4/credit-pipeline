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
import { dscrGte, dtiLte, roundHalfUpDiv } from "./money.js";
import {
	ruleDefinitionFor,
	type PolicyRuleDefinition,
	type PolicyRuleEffect,
	type PolicyRuleId,
} from "./policy-registry.js";
import {
	makeReason,
	type PolicyReason,
	type PolicyReasonCode,
	type ReasonCode,
} from "./reasons.js";
import { z } from "zod";

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

// ---------------------------------------------------------------------------
// EN-07 runtime schema and deterministic rule-failure explainer.
// The engine above is unchanged; this reports every evaluated check for the
// case-rule navigator. Persisted reasons are a subset (first-match decline,
// 4-reason refer cap).

const industrySchema = z.enum(["hospitality", "retail", "services", "construction", "other"]);

const individualInputsSchema = z.object({
	kind: z.literal("individual"),
	score: z.number().int().min(0).max(1_000),
	existingDebtCents: z.number().int().nonnegative(),
	monthlyIncomeCents: z.number().int().positive(),
	newPaymentCents: z.number().int().nonnegative(),
	amountCents: z.number().int().nonnegative(),
	termMonths: z.number().int().positive(),
	employmentYears: z.number().min(0),
});

const smeInputsSchema = z.object({
	kind: z.literal("sme"),
	blendedScore: z.number().int().min(0).max(1_000),
	monthlyFcfCents: z.number().int().nonnegative(),
	existingDebtServiceCents: z.number().int().nonnegative(),
	newPaymentCents: z.number().int().nonnegative(),
	amountCents: z.number().int().nonnegative(),
	termMonths: z.number().int().positive(),
	yearsTrading: z.number().min(0),
	annualRevenueCents: z.number().int().nonnegative(),
	industry: industrySchema,
});

/** Known engine fields only; booking/snapshot extras are stripped, not
 * rejected (officer-approved snapshots add approvedAmountCents/requestId). */
export const policyInputsSchema = z.discriminatedUnion("kind", [
	individualInputsSchema,
	smeInputsSchema,
]);

export interface PolicyRuleFailure {
	ruleId: PolicyRuleId;
	reasonCode: PolicyReasonCode;
	effect: PolicyRuleEffect;
	/** True when the engine actually evaluated this check before returning. */
	evaluated: boolean;
	/** True when this code is in the persisted reason list. */
	persisted: boolean;
	/** Persisted reasons are the decision drivers; also-evaluated checks are not. */
	decisionRelevant: boolean;
	observedValue: number | string;
	observed: string;
	threshold: string;
}

function sgdDisplay(cents: number): string {
	const whole = Math.floor(cents / 100);
	const fraction = cents % 100;
	const formatted = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	return `S$${formatted}${fraction === 0 ? "" : `.${fraction.toString().padStart(2, "0")}`}`;
}

function yearsDisplay(value: number): string {
	return `${value} ${value === 1 ? "year" : "years"}`;
}

function dtiObservedX100(inputs: Extract<PolicyInputs, { kind: "individual" }>): number {
	return roundHalfUpDiv(
		(inputs.existingDebtCents + inputs.newPaymentCents) * 10_000,
		inputs.monthlyIncomeCents,
	);
}

function dscrObservedX100(inputs: Extract<PolicyInputs, { kind: "sme" }>): number {
	const debtService = inputs.newPaymentCents + inputs.existingDebtServiceCents;
	if (debtService <= 0) return Number.POSITIVE_INFINITY;
	return roundHalfUpDiv(inputs.monthlyFcfCents * 100, debtService);
}

function observedDisplay(
	kind: PolicyRuleDefinition["threshold"]["kind"],
	value: number | string,
): string {
	if (typeof value === "string") return value;
	switch (kind) {
		case "money":
			return sgdDisplay(value);
		case "months":
			return `${value} months`;
		case "years":
			return yearsDisplay(value);
		case "percent":
			return `${(value / 100).toFixed(2)}%`;
		case "ratio":
			return value === Number.POSITIVE_INFINITY ? "∞" : `${(value / 100).toFixed(2)}x`;
		case "score":
			return String(value);
		case "sector":
			return String(value);
	}
}

interface FailedCheck {
	reasonCode: PolicyReasonCode;
	effect: "decline" | "refer";
	observedValue: number | string;
}

function failureFor(
	check: FailedCheck,
	applicationKind: "individual" | "sme",
	evaluated: boolean,
	persistedCodes: ReadonlySet<string>,
): PolicyRuleFailure {
	const definition = ruleDefinitionFor(check.reasonCode, applicationKind);
	if (!definition) {
		throw new Error(`policy registry missing ${check.reasonCode}:${applicationKind}`);
	}
	return {
		ruleId: definition.ruleId,
		reasonCode: check.reasonCode,
		effect: definition.effect,
		evaluated,
		persisted: persistedCodes.has(check.reasonCode),
		decisionRelevant: persistedCodes.has(check.reasonCode),
		observedValue: check.observedValue,
		observed: observedDisplay(definition.threshold.kind, check.observedValue),
		threshold: definition.threshold.display,
	};
}

/** Every evaluated engine check plus the informational sector trigger.
 * Declines are first-match (later decline checks are reported evaluated:false);
 * refer checks are all evaluated and the persisted list is capped at 4. */
export function explainPolicyRules(
	inputs: PolicyInputs,
	persistedReasons: ReadonlyArray<Pick<PolicyReason, "code">> = [],
): PolicyRuleFailure[] {
	const persistedCodes = new Set(persistedReasons.map((reason) => reason.code));
	if (inputs.kind === "individual") {
		const dti = dtiObservedX100(inputs);
		const declineChecks: FailedCheck[] = [];
		if (inputs.amountCents < PERSONAL_MIN_CENTS || inputs.amountCents > PERSONAL_MAX_CENTS) {
			declineChecks.push({
				reasonCode: "AMOUNT_OUT_OF_RANGE",
				effect: "decline",
				observedValue: inputs.amountCents,
			});
		}
		if (inputs.termMonths < TERM_MIN_MONTHS || inputs.termMonths > TERM_MAX_MONTHS) {
			declineChecks.push({
				reasonCode: "TERM_OUT_OF_RANGE",
				effect: "decline",
				observedValue: inputs.termMonths,
			});
		}
		if (
			!dtiLte(
				inputs.existingDebtCents,
				inputs.newPaymentCents,
				inputs.monthlyIncomeCents,
				DTI_DECLINE_MAX_PCT_X100,
			)
		) {
			declineChecks.push({ reasonCode: "DTI_TOO_HIGH", effect: "decline", observedValue: dti });
		}
		if (inputs.score < MIN_SCORE) {
			declineChecks.push({
				reasonCode: "SCORE_TOO_LOW",
				effect: "decline",
				observedValue: inputs.score,
			});
		}
		if (declineChecks.length > 0) {
			return declineChecks.map((check, index) =>
				failureFor(check, "individual", index === 0, persistedCodes),
			);
		}
		const refer: FailedCheck[] = [];
		if (inputs.amountCents > AUTO_LIMIT_PERSONAL_CENTS) {
			refer.push({
				reasonCode: "AMOUNT_ABOVE_AUTO_LIMIT",
				effect: "refer",
				observedValue: inputs.amountCents,
			});
		}
		if (inputs.score < AUTO_SCORE) {
			refer.push({
				reasonCode: "SCORE_IN_REFER_BAND",
				effect: "refer",
				observedValue: inputs.score,
			});
		}
		if (
			!dtiLte(
				inputs.existingDebtCents,
				inputs.newPaymentCents,
				inputs.monthlyIncomeCents,
				DTI_AUTO_MAX_PCT_X100,
			)
		) {
			refer.push({ reasonCode: "DTI_IN_REFER_BAND", effect: "refer", observedValue: dti });
		}
		if (inputs.employmentYears < MIN_EMPLOYMENT_YEARS) {
			refer.push({
				reasonCode: "SHORT_EMPLOYMENT",
				effect: "refer",
				observedValue: inputs.employmentYears,
			});
		}
		return refer.map((check) => failureFor(check, "individual", true, persistedCodes));
	}

	const dscr = dscrObservedX100(inputs);
	const declineChecks: FailedCheck[] = [];
	if (inputs.amountCents < SME_MIN_CENTS || inputs.amountCents > SME_MAX_CENTS) {
		declineChecks.push({
			reasonCode: "AMOUNT_OUT_OF_RANGE",
			effect: "decline",
			observedValue: inputs.amountCents,
		});
	}
	if (inputs.termMonths < TERM_MIN_MONTHS || inputs.termMonths > TERM_MAX_MONTHS) {
		declineChecks.push({
			reasonCode: "TERM_OUT_OF_RANGE",
			effect: "decline",
			observedValue: inputs.termMonths,
		});
	}
	if (inputs.annualRevenueCents < SME_MIN_REVENUE_CENTS) {
		declineChecks.push({
			reasonCode: "REVENUE_TOO_LOW",
			effect: "decline",
			observedValue: inputs.annualRevenueCents,
		});
	}
	if (inputs.yearsTrading < SME_MIN_TRADING_YEARS) {
		declineChecks.push({
			reasonCode: "TRADING_HISTORY_TOO_SHORT",
			effect: "decline",
			observedValue: inputs.yearsTrading,
		});
	}
	if (
		!dscrGte(
			inputs.monthlyFcfCents,
			inputs.newPaymentCents,
			inputs.existingDebtServiceCents,
			DSCR_DECLINE_MIN_X100,
		)
	) {
		declineChecks.push({ reasonCode: "DSCR_TOO_LOW", effect: "decline", observedValue: dscr });
	}
	if (inputs.blendedScore < MIN_SCORE) {
		declineChecks.push({
			reasonCode: "SCORE_TOO_LOW",
			effect: "decline",
			observedValue: inputs.blendedScore,
		});
	}
	if (declineChecks.length > 0) {
		return declineChecks.map((check, index) =>
			failureFor(check, "sme", index === 0, persistedCodes),
		);
	}
	const refer: FailedCheck[] = [];
	if (inputs.amountCents > AUTO_LIMIT_SME_CENTS) {
		refer.push({
			reasonCode: "AMOUNT_ABOVE_AUTO_LIMIT",
			effect: "refer",
			observedValue: inputs.amountCents,
		});
	}
	if (inputs.blendedScore < AUTO_SCORE) {
		refer.push({
			reasonCode: "SCORE_IN_REFER_BAND",
			effect: "refer",
			observedValue: inputs.blendedScore,
		});
	}
	if (
		!dscrGte(
			inputs.monthlyFcfCents,
			inputs.newPaymentCents,
			inputs.existingDebtServiceCents,
			DSCR_AUTO_MIN_X100,
		)
	) {
		refer.push({ reasonCode: "DSCR_IN_REFER_BAND", effect: "refer", observedValue: dscr });
	}
	if (inputs.yearsTrading < SME_AUTO_TRADING_YEARS) {
		refer.push({
			reasonCode: "TRADING_HISTORY_IN_REFER_BAND",
			effect: "refer",
			observedValue: inputs.yearsTrading,
		});
	}
	const failures = refer.map((check) => failureFor(check, "sme", true, persistedCodes));
	if (inputs.industry === "hospitality" || inputs.industry === "construction") {
		const definition = ruleDefinitionFor("SECTOR_REVIEW", "sme");
		if (!definition) throw new Error("policy registry missing SECTOR_REVIEW:sme");
		failures.push({
			ruleId: definition.ruleId,
			reasonCode: "SECTOR_REVIEW",
			effect: "informational",
			evaluated: true,
			persisted: persistedCodes.has("SECTOR_REVIEW"),
			decisionRelevant: false,
			observedValue: inputs.industry,
			observed: inputs.industry,
			threshold: definition.threshold.display,
		});
	}
	return failures;
}
