// EN-08 / US-ADV-1..5 — adverse-action taxonomy and jurisdiction profiles.
//
// The taxonomy maps every deterministic reason code (policy, check, officer,
// and score-factor) to a principal-reason category and an applicant-safe
// template. It is a total `Record`, so adding a reason code without a mapping
// fails the build. Runtime selection applies the specificity rules: at most
// four reasons, at least the profile minimum, at most one generic reason, and
// at least one specific reason. Unmapped or insufficient inputs fail closed
// with `NEEDS_OFFICER_INPUT`; nothing is invented.
//
// Jurisdiction profiles are code-defined and versioned. Every profile carries
// its legal-review reference and a change log; changing wording or notices
// requires a new version and a new legal review entry. The feature records
// the selected profile version on every generated letter.
import { hashCanonical } from "./canonical.js";
import {
	AUTO_LIMIT_PERSONAL_CENTS,
	AUTO_LIMIT_SME_CENTS,
	DSCR_DECLINE_MIN_X100,
	DTI_DECLINE_MAX_PCT_X100,
	MIN_EMPLOYMENT_YEARS,
	MIN_SCORE,
	PERSONAL_MAX_CENTS,
	PERSONAL_MIN_CENTS,
	SME_MAX_CENTS,
	SME_MIN_CENTS,
	SME_MIN_REVENUE_CENTS,
	SME_MIN_TRADING_YEARS,
	TERM_MAX_MONTHS,
	TERM_MIN_MONTHS,
} from "./constants.js";
import { scanFairLending } from "./fair-lending.js";
import { FACTOR_LABELS, type FactorCode } from "./factors.js";
import { parseSourceRef } from "./evidence.js";
import type { AdverseActionLetterContent } from "./generated-text.js";
import { REASON_TEXT, type ReasonCode } from "./reasons.js";

export const ADVERSE_TAXONOMY_VERSION = "adverse-taxonomy-v2";

export type AdverseReasonCode = ReasonCode | FactorCode;
export type AdverseReasonSpecificity = "specific" | "generic";

export interface AdverseReasonFacts {
	product: string;
	amountCents?: number | null;
	termMonths?: number | null;
	annualRevenueCents?: number | null;
	yearsTrading?: number | null;
	employmentYears?: number | null;
	bankRelationshipYears?: number | null;
	existingDebtServiceCents?: number | null;
	industry?: string | null;
	delinquencies?: number | null;
	utilizationPct?: number | null;
	assessmentResult?: number | null;
}

export interface AdverseReasonDefinition {
	category: string;
	specificity: AdverseReasonSpecificity;
	render: (facts: AdverseReasonFacts) => string;
}

function usd(cents: number | null | undefined): string {
	if (cents === null || cents === undefined || !Number.isFinite(cents)) {
		return "the amount stated in the case record";
	}
	return `USD ${(cents / 100).toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;
}

function years(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value)) {
		return "the period stated in the case record";
	}
	return `${value} ${value === 1 ? "year" : "years"}`;
}

function pct(x100: number): string {
	return `${x100 / 100}%`;
}

function ratio(x100: number): string {
	return (x100 / 100).toFixed(1);
}

function assessmentResult(facts: AdverseReasonFacts): string {
	return facts.assessmentResult === null || facts.assessmentResult === undefined
		? "The credit assessment result"
		: `The credit assessment result of ${facts.assessmentResult}`;
}

function industryText(facts: AdverseReasonFacts): string {
	return facts.industry === null || facts.industry === undefined
		? "The business sector"
		: `The ${facts.industry} sector`;
}

function productBounds(facts: AdverseReasonFacts): { min: number; max: number; auto: number } {
	if (facts.product === "personal_loan") {
		return {
			min: PERSONAL_MIN_CENTS,
			max: PERSONAL_MAX_CENTS,
			auto: AUTO_LIMIT_PERSONAL_CENTS,
		};
	}
	return { min: SME_MIN_CENTS, max: SME_MAX_CENTS, auto: AUTO_LIMIT_SME_CENTS };
}

function amountRange(facts: AdverseReasonFacts): string {
	const bounds = productBounds(facts);
	return `${usd(bounds.min)} to ${usd(bounds.max)}`;
}

/** Total mapping: every `ReasonCode` and every `FactorCode`. */
export const ADVERSE_REASON_TAXONOMY: Record<AdverseReasonCode, AdverseReasonDefinition> = {
	AMOUNT_OUT_OF_RANGE: {
		category: "request_outside_product_bounds",
		specificity: "specific",
		render: (facts) =>
			`The requested amount of ${usd(facts.amountCents)} is outside the supported range for this product (${amountRange(facts)}).`,
	},
	TERM_OUT_OF_RANGE: {
		category: "repayment_period_outside_bounds",
		specificity: "specific",
		render: (facts) =>
			`The requested repayment period of ${facts.termMonths ?? "the stated number of"} months is outside the supported range (${TERM_MIN_MONTHS} to ${TERM_MAX_MONTHS} months).`,
	},
	DTI_TOO_HIGH: {
		category: "affordability_debt_burden",
		specificity: "specific",
		render: () =>
			`The total monthly debt commitments exceed ${pct(DTI_DECLINE_MAX_PCT_X100)} of monthly income.`,
	},
	SCORE_TOO_LOW: {
		category: "assessment_result_below_minimum",
		specificity: "specific",
		render: (facts) =>
			`${assessmentResult(facts)} is below the minimum required level of ${MIN_SCORE}.`,
	},
	REVENUE_TOO_LOW: {
		category: "revenue_below_minimum",
		specificity: "specific",
		render: (facts) =>
			`Annual revenue of ${usd(facts.annualRevenueCents)} is below the minimum required level of ${usd(SME_MIN_REVENUE_CENTS)}.`,
	},
	TRADING_HISTORY_TOO_SHORT: {
		category: "trading_history_below_minimum",
		specificity: "specific",
		render: (facts) =>
			`Trading history of ${years(facts.yearsTrading)} is below the minimum required period of ${years(SME_MIN_TRADING_YEARS)}.`,
	},
	DSCR_TOO_LOW: {
		category: "affordability_debt_service_coverage",
		specificity: "specific",
		render: () =>
			`Monthly free cash flow does not cover existing debt service and the proposed repayment at the required coverage level of ${ratio(DSCR_DECLINE_MIN_X100)}x.`,
	},
	AMOUNT_ABOVE_AUTO_LIMIT: {
		category: "request_above_standard_path",
		specificity: "specific",
		render: (facts) =>
			`The requested amount of ${usd(facts.amountCents)} exceeds the maximum amount that can be processed under the standard assessment path (${usd(productBounds(facts).auto)}).`,
	},
	SCORE_IN_REFER_BAND: {
		category: "assessment_result_requires_individual_assessment",
		specificity: "specific",
		render: (facts) =>
			`${assessmentResult(facts)} is within the range that requires individual assessment.`,
	},
	DTI_IN_REFER_BAND: {
		category: "affordability_requires_individual_assessment",
		specificity: "specific",
		render: () =>
			"The total monthly debt commitments are within the range that requires individual assessment.",
	},
	DSCR_IN_REFER_BAND: {
		category: "debt_service_coverage_requires_individual_assessment",
		specificity: "specific",
		render: () => "Debt-service coverage is within the range that requires individual assessment.",
	},
	SHORT_EMPLOYMENT: {
		category: "employment_history_below_minimum",
		specificity: "specific",
		render: (facts) =>
			`Employment history of ${years(facts.employmentYears)} is below the minimum required period of ${years(MIN_EMPLOYMENT_YEARS)}.`,
	},
	TRADING_HISTORY_IN_REFER_BAND: {
		category: "trading_history_requires_individual_assessment",
		specificity: "specific",
		render: (facts) =>
			`Trading history of ${years(facts.yearsTrading)} is within the range that requires individual assessment.`,
	},
	SECTOR_REVIEW: {
		category: "sector_review",
		specificity: "specific",
		render: (facts) => `${industryText(facts)} is associated with higher risk characteristics.`,
	},
	IDENTITY_FAILED: {
		category: "identity_verification",
		specificity: "specific",
		render: () => "Identity verification could not be completed with the information provided.",
	},
	SANCTIONS_HIT: {
		category: "regulatory_screening",
		specificity: "specific",
		render: () =>
			"A required regulatory screening check could not be completed for this application.",
	},
	OFFICER_JUDGEMENT: {
		category: "officer_assessment",
		specificity: "generic",
		render: () => "The information provided did not establish that the request could be supported.",
	},
	INSUFFICIENT_EVIDENCE: {
		category: "insufficient_information",
		specificity: "generic",
		render: () => "The information provided was not sufficient to complete the assessment.",
	},
	POLICY_EXCEPTION: {
		category: "lending_criteria_exception",
		specificity: "generic",
		render: () => "The request did not meet the conditions required for an exception.",
	},
	EMPLOYMENT_TENURE: {
		category: "employment_tenure",
		specificity: "specific",
		render: (facts) =>
			`Employment history of ${years(facts.employmentYears)} is shorter than the preferred level.`,
	},
	DELINQUENCIES: {
		category: "payment_history",
		specificity: "specific",
		render: (facts) => {
			const count = facts.delinquencies;
			if (count === null || count === undefined || !Number.isFinite(count)) {
				return "The credit record shows past payment delinquencies.";
			}
			return `The credit record shows ${count} past payment ${count === 1 ? "delinquency" : "delinquencies"}.`;
		},
	},
	CREDIT_UTILIZATION: {
		category: "credit_utilization",
		specificity: "specific",
		render: (facts) => {
			const utilization = facts.utilizationPct;
			if (utilization === null || utilization === undefined || !Number.isFinite(utilization)) {
				return "Credit utilization is above the preferred level.";
			}
			return `Credit utilization of ${utilization}% is above the preferred level.`;
		},
	},
	BANK_RELATIONSHIP: {
		category: "banking_relationship",
		specificity: "specific",
		render: (facts) =>
			`The banking relationship of ${years(facts.bankRelationshipYears)} is shorter than the preferred level.`,
	},
	TRADING_HISTORY: {
		category: "trading_history",
		specificity: "specific",
		render: (facts) =>
			`Trading history of ${years(facts.yearsTrading)} is shorter than the preferred level.`,
	},
	REVENUE_SCALE: {
		category: "revenue_scale",
		specificity: "specific",
		render: (facts) =>
			`Annual revenue of ${usd(facts.annualRevenueCents)} is below the preferred level.`,
	},
	SECTOR_RISK: {
		category: "sector_risk",
		specificity: "specific",
		render: (facts) => `${industryText(facts)} carries higher risk characteristics.`,
	},
	DEBT_BURDEN: {
		category: "debt_burden",
		specificity: "specific",
		render: (facts) =>
			`Monthly debt service of ${usd(facts.existingDebtServiceCents)} is high relative to revenue.`,
	},
};

export function isAdverseReasonCode(code: string): code is AdverseReasonCode {
	return Object.prototype.hasOwnProperty.call(ADVERSE_REASON_TAXONOMY, code);
}

/** Coverage report: every supplied code is either mapped or listed. */
export function adverseTaxonomyCoverage(codes: readonly string[]): {
	mapped: AdverseReasonCode[];
	unmapped: string[];
} {
	const mapped: AdverseReasonCode[] = [];
	const unmapped: string[] = [];
	for (const code of new Set(codes)) {
		if (isAdverseReasonCode(code)) mapped.push(code);
		else unmapped.push(code);
	}
	return { mapped, unmapped };
}

/** All codes the taxonomy is expected to cover (policy + check + officer + factor). */
export function adverseTaxonomyExpectedCodes(): string[] {
	return [...Object.keys(REASON_TEXT), ...Object.keys(FACTOR_LABELS)].sort();
}

export interface AdverseJurisdictionProfile {
	code: "SG" | "US";
	version: string;
	title: string;
	decision: "declined" | "not_successful";
	minReasons: number;
	maxReasons: number;
	disclosures: ReadonlyArray<{ id: string; text: string }>;
	legalReview: {
		status: "approved";
		reviewedAt: string;
		reference: string;
		scope: string;
	};
	/** Hash of the applicant-facing wording under this version. A wording
	 * edit without a version bump fails profile validation. */
	wordingHash: string;
	changeLog: ReadonlyArray<{
		version: string;
		at: string;
		summary: string;
		legalReviewRef: string;
		wordingHash: string;
	}>;
}

/** Stable hash of the profile-controlled applicant wording and reason count. */
export function adverseProfileWordingHash(input: {
	title: string;
	decision: string;
	minReasons: number;
	maxReasons: number;
	disclosures: ReadonlyArray<{ id: string; text: string }>;
}): string {
	return hashCanonical({
		taxonomyVersion: ADVERSE_TAXONOMY_VERSION,
		title: input.title,
		decision: input.decision,
		minReasons: input.minReasons,
		maxReasons: input.maxReasons,
		disclosures: input.disclosures.map((disclosure) => ({
			id: disclosure.id,
			text: disclosure.text,
		})),
	});
}

export const ADVERSE_JURISDICTION_PROFILES: Record<"SG" | "US", AdverseJurisdictionProfile> = {
	SG: {
		code: "SG",
		version: "sg-feat-v2",
		title: "Notice of credit outcome",
		decision: "not_successful",
		minReasons: 3,
		maxReasons: 4,
		disclosures: [
			{
				id: "SG-FEAT-TRANSPARENCY",
				text: "This notice explains the principal reasons for the outcome of your application.",
			},
			{
				id: "SG-FEAT-REVIEW",
				text: "You may contact us to request a review of this outcome and to correct any information that is inaccurate.",
			},
			{
				id: "SG-FEAT-FAIRNESS",
				text: "Applications are assessed on consistent, objective criteria. Characteristics unrelated to creditworthiness are not used.",
			},
		],
		legalReview: {
			status: "approved",
			reviewedAt: "2026-09-15",
			reference: "LEGAL-SG-ADV-2026-09",
			scope: "SG FEAT-aligned adverse-action notice wording",
		},
		// Literal on purpose: editing title/decision/count/disclosures or the
		// taxonomy without bumping the version leaves this hash stale.
		wordingHash: "c1c5538e47b3b8a7a17904ca401099c382c987e370b787640a1b26c6652b0f04",
		changeLog: [
			{
				version: "sg-feat-v1",
				at: "2026-09-15",
				summary: "Initial SG profile",
				legalReviewRef: "LEGAL-SG-ADV-2026-09",
				wordingHash: "f5b40b3f2fa403d753f2bfc33ea868dbf36c7edd654889477e753d3d8a31ad06",
			},
			{
				version: "sg-feat-v2",
				at: "2026-10-25",
				summary: "Specific delinquency/utilization wording and taxonomy v2",
				legalReviewRef: "LEGAL-SG-ADV-2026-09",
				wordingHash: "c1c5538e47b3b8a7a17904ca401099c382c987e370b787640a1b26c6652b0f04",
			},
		],
	},
	US: {
		code: "US",
		version: "us-ecoa-v2",
		title: "Adverse action notice",
		decision: "declined",
		minReasons: 3,
		maxReasons: 4,
		disclosures: [
			{
				id: "US-ECOA-NOTICE",
				text: "This notice is provided under the Equal Credit Opportunity Act and Regulation B.",
			},
			{
				id: "US-ECOA-REASONS",
				text: "You may request a statement of the reasons for the action taken within 60 days.",
			},
			{
				id: "US-ECOA-REVIEW",
				text: "You may contact us to request a review or to correct inaccurate information.",
			},
			{
				id: "US-ECOA-AGENCY",
				text: "The Consumer Financial Protection Bureau administers compliance with the Equal Credit Opportunity Act.",
			},
		],
		legalReview: {
			status: "approved",
			reviewedAt: "2026-09-15",
			reference: "LEGAL-US-ADV-2026-09",
			scope: "US ECOA / Regulation B adverse-action notice wording",
		},
		wordingHash: "e6b4606cabfb11369b31d64dc94a98425bdeef08676688bb4cc43479b9ab5e8f",
		changeLog: [
			{
				version: "us-ecoa-v1",
				at: "2026-09-15",
				summary: "Initial US profile",
				legalReviewRef: "LEGAL-US-ADV-2026-09",
				wordingHash: "e6f3fddb884a48cde747d2add05b06cb21e9280d1e11c33ce508acef190c66d3",
			},
			{
				version: "us-ecoa-v2",
				at: "2026-10-25",
				summary: "Specific delinquency/utilization wording and taxonomy v2",
				legalReviewRef: "LEGAL-US-ADV-2026-09",
				wordingHash: "e6b4606cabfb11369b31d64dc94a98425bdeef08676688bb4cc43479b9ab5e8f",
			},
		],
	},
};

/** Resolve a configured jurisdiction; unsupported values return null so the
 * route can fail closed with a clear error. */
export function resolveAdverseJurisdictionProfile(
	code: string | null | undefined,
): AdverseJurisdictionProfile | null {
	if (typeof code !== "string") return null;
	const normalized = code.trim().toUpperCase();
	if (normalized === "SG") return ADVERSE_JURISDICTION_PROFILES.SG;
	if (normalized === "US") return ADVERSE_JURISDICTION_PROFILES.US;
	return null;
}

export interface ProfileValidationIssue {
	code:
		| "PROFILE_CODE"
		| "PROFILE_VERSION"
		| "PROFILE_TITLE"
		| "PROFILE_DECISION"
		| "PROFILE_REASON_COUNT"
		| "PROFILE_DISCLOSURE"
		| "PROFILE_LEGAL_REVIEW"
		| "PROFILE_CHANGELOG"
		| "PROFILE_WORDING_HASH";
	message: string;
}

/** Structural and legal-review validation for a profile before use. */
export function validateAdverseJurisdictionProfile(
	profile: AdverseJurisdictionProfile,
): { ok: true } | { ok: false; issues: ProfileValidationIssue[] } {
	const issues: ProfileValidationIssue[] = [];
	if (profile.code !== "SG" && profile.code !== "US") {
		issues.push({ code: "PROFILE_CODE", message: "profile code is not supported" });
	}
	if (profile.version.trim().length === 0 || profile.version.length > 80) {
		issues.push({
			code: "PROFILE_VERSION",
			message: "profile version must be 1-80 characters",
		});
	}
	if (profile.title.trim().length === 0 || profile.title.length > 200) {
		issues.push({
			code: "PROFILE_TITLE",
			message: "profile title must be 1-200 characters",
		});
	}
	if (
		profile.title.trim().length > 0 &&
		(scanFairLending(profile.title).protectedAttributes.length > 0 ||
			scanFairLending(profile.title).proxies.length > 0)
	) {
		issues.push({
			code: "PROFILE_TITLE",
			message: "profile title contains a protected attribute or proxy",
		});
	}
	if (profile.decision !== "declined" && profile.decision !== "not_successful") {
		issues.push({ code: "PROFILE_DECISION", message: "profile decision wording is invalid" });
	}
	if (
		!Number.isInteger(profile.minReasons) ||
		!Number.isInteger(profile.maxReasons) ||
		profile.minReasons < 3 ||
		profile.maxReasons > 4 ||
		profile.minReasons > profile.maxReasons
	) {
		issues.push({
			code: "PROFILE_REASON_COUNT",
			message: "profile reason count must be 3-4",
		});
	}
	const disclosureIds = new Set<string>();
	if (profile.disclosures.length === 0 || profile.disclosures.length > 10) {
		issues.push({
			code: "PROFILE_DISCLOSURE",
			message: "profile must have 1-10 required disclosures",
		});
	}
	for (const disclosure of profile.disclosures) {
		if (
			disclosure.id.trim().length === 0 ||
			disclosure.text.trim().length === 0 ||
			disclosure.text.length > 1_000
		) {
			issues.push({
				code: "PROFILE_DISCLOSURE",
				message: "profile disclosure must be 1-1000 characters",
			});
			continue;
		}
		if (disclosureIds.has(disclosure.id)) {
			issues.push({ code: "PROFILE_DISCLOSURE", message: "profile disclosure id is duplicated" });
		}
		disclosureIds.add(disclosure.id);
		const scan = scanFairLending(disclosure.text);
		if (scan.protectedAttributes.length > 0 || scan.proxies.length > 0) {
			issues.push({
				code: "PROFILE_DISCLOSURE",
				message: "profile disclosure contains a protected attribute or proxy",
			});
		}
	}
	if (
		profile.legalReview.status !== "approved" ||
		profile.legalReview.reference.trim().length === 0 ||
		profile.legalReview.reviewedAt.trim().length === 0
	) {
		issues.push({ code: "PROFILE_LEGAL_REVIEW", message: "legal review is not recorded" });
	}
	const matchingChange = profile.changeLog.find(
		(entry) =>
			entry.version === profile.version && entry.legalReviewRef === profile.legalReview.reference,
	);
	if (!matchingChange) {
		issues.push({
			code: "PROFILE_CHANGELOG",
			message: "profile version is not linked to its legal review",
		});
	}
	const computedWordingHash = adverseProfileWordingHash(profile);
	if (profile.wordingHash !== computedWordingHash) {
		issues.push({
			code: "PROFILE_WORDING_HASH",
			message: "profile wording changed without a version bump",
		});
	}
	if (matchingChange && matchingChange.wordingHash !== computedWordingHash) {
		issues.push({
			code: "PROFILE_WORDING_HASH",
			message: "profile change log wording does not match the current wording",
		});
	}
	return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

export interface SelectedPrincipalReason {
	code: AdverseReasonCode;
	category: string;
	specificity: AdverseReasonSpecificity;
	text: string;
}

export type AdverseReasonFailure =
	| {
			code: "NEEDS_OFFICER_INPUT";
			detail:
				| "unmapped_code"
				| "insufficient_reasons"
				| "insufficient_specificity"
				| "template_invalid";
			reasonCodes: string[];
			unmappedCodes: string[];
			minReasons: number;
			maxReasons: number;
	  }
	| {
			code: "FAIR_LENDING_BLOCKED";
			stage: "input" | "generated_text";
			terms: string[];
			reasonCodes: string[];
	  };

export type AdverseReasonSelection =
	| {
			ok: true;
			reasons: SelectedPrincipalReason[];
			droppedCodes: string[];
	  }
	| { ok: false; failure: AdverseReasonFailure };

/** Deterministic principal-reason selection + specificity rules. */
export function selectAdverseReasons(input: {
	reasonCodes: readonly string[];
	inputLabels?: readonly string[];
	facts: AdverseReasonFacts;
	profile: Pick<AdverseJurisdictionProfile, "minReasons" | "maxReasons">;
}): AdverseReasonSelection {
	const reasonCodes = [...new Set(input.reasonCodes)];
	const inputScan = scanFairLending([...reasonCodes, ...(input.inputLabels ?? [])].join(" "));
	if (inputScan.protectedAttributes.length > 0 || inputScan.proxies.length > 0) {
		return {
			ok: false,
			failure: {
				code: "FAIR_LENDING_BLOCKED",
				stage: "input",
				terms: [...inputScan.protectedAttributes, ...inputScan.proxies].sort(),
				reasonCodes,
			},
		};
	}
	const mapped: AdverseReasonCode[] = [];
	const unmappedCodes: string[] = [];
	for (const code of reasonCodes) {
		if (isAdverseReasonCode(code)) mapped.push(code);
		else unmappedCodes.push(code);
	}
	if (unmappedCodes.length > 0) {
		return {
			ok: false,
			failure: {
				code: "NEEDS_OFFICER_INPUT",
				detail: "unmapped_code",
				reasonCodes,
				unmappedCodes,
				minReasons: input.profile.minReasons,
				maxReasons: input.profile.maxReasons,
			},
		};
	}
	const specific = mapped.filter(
		(code) => ADVERSE_REASON_TAXONOMY[code].specificity === "specific",
	);
	const generic = mapped.filter((code) => ADVERSE_REASON_TAXONOMY[code].specificity === "generic");
	const selected: AdverseReasonCode[] = specific.slice(0, input.profile.maxReasons);
	// At most one generic reason, and only as a supporting reason.
	if (selected.length < input.profile.maxReasons && generic.length > 0) {
		selected.push(generic[0] as AdverseReasonCode);
	}
	if (selected.length < input.profile.minReasons) {
		return {
			ok: false,
			failure: {
				code: "NEEDS_OFFICER_INPUT",
				detail: specific.length === 0 ? "insufficient_specificity" : "insufficient_reasons",
				reasonCodes,
				unmappedCodes: [],
				minReasons: input.profile.minReasons,
				maxReasons: input.profile.maxReasons,
			},
		};
	}
	if (specific.length === 0) {
		return {
			ok: false,
			failure: {
				code: "NEEDS_OFFICER_INPUT",
				detail: "insufficient_specificity",
				reasonCodes,
				unmappedCodes: [],
				minReasons: input.profile.minReasons,
				maxReasons: input.profile.maxReasons,
			},
		};
	}
	const reasons: SelectedPrincipalReason[] = [];
	for (const code of selected) {
		const definition = ADVERSE_REASON_TAXONOMY[code];
		const text = definition.render(input.facts);
		if (text.trim().length === 0 || text.length > 500) {
			return {
				ok: false,
				failure: {
					code: "NEEDS_OFFICER_INPUT",
					detail: "template_invalid",
					reasonCodes,
					unmappedCodes: [],
					minReasons: input.profile.minReasons,
					maxReasons: input.profile.maxReasons,
				},
			};
		}
		const generatedScan = scanFairLending(text);
		if (generatedScan.protectedAttributes.length > 0 || generatedScan.proxies.length > 0) {
			return {
				ok: false,
				failure: {
					code: "FAIR_LENDING_BLOCKED",
					stage: "generated_text",
					terms: [...generatedScan.protectedAttributes, ...generatedScan.proxies].sort(),
					reasonCodes,
				},
			};
		}
		reasons.push({
			code,
			category: definition.category,
			specificity: definition.specificity,
			text,
		});
	}
	const selectedSet = new Set(selected);
	return {
		ok: true,
		reasons,
		droppedCodes: mapped.filter((code) => !selectedSet.has(code)),
	};
}

export interface AdverseLetterProfileIssue {
	code:
		| "JURISDICTION_MISMATCH"
		| "PROFILE_VERSION_MISMATCH"
		| "DECISION_MISMATCH"
		| "TITLE_MISMATCH"
		| "REASON_COUNT"
		| "REASON_CODE_UNMAPPED"
		| "REASON_SPECIFICITY"
		| "DUPLICATE_REASON_CODE"
		| "DISCLOSURE_MISSING"
		| "NOTICE_MISMATCH"
		| "CONTACT_PATH_MISSING";
	message: string;
}

/** Validate a generated/edited letter against its jurisdiction profile. The
 * shared generated-text validator still runs afterwards for citations, PII,
 * decision-language, and fair-lending scans. */
export function validateAdverseLetterContent(
	content: AdverseActionLetterContent,
	profile: AdverseJurisdictionProfile,
): { ok: true } | { ok: false; issues: AdverseLetterProfileIssue[] } {
	const issues: AdverseLetterProfileIssue[] = [];
	if (content.jurisdiction !== profile.code) {
		issues.push({
			code: "JURISDICTION_MISMATCH",
			message: "letter jurisdiction does not match the active profile",
		});
	}
	if (content.profileVersion !== profile.version) {
		issues.push({
			code: "PROFILE_VERSION_MISMATCH",
			message: "letter profile version does not match the active profile",
		});
	}
	if (content.decision !== profile.decision) {
		issues.push({
			code: "DECISION_MISMATCH",
			message: "letter decision wording does not match the profile",
		});
	}
	if (content.title !== profile.title) {
		issues.push({
			code: "TITLE_MISMATCH",
			message: "letter title does not match the profile wording",
		});
	}
	if (
		content.principalReasons.length < profile.minReasons ||
		content.principalReasons.length > profile.maxReasons
	) {
		issues.push({
			code: "REASON_COUNT",
			message: `letter must contain ${profile.minReasons}-${profile.maxReasons} principal reasons`,
		});
	}
	let genericCount = 0;
	const seenCodes = new Set<string>();
	for (const reason of content.principalReasons) {
		if (seenCodes.has(reason.code)) {
			issues.push({
				code: "DUPLICATE_REASON_CODE",
				message: "principal reason codes must be unique",
			});
		}
		seenCodes.add(reason.code);
		if (!isAdverseReasonCode(reason.code)) {
			issues.push({
				code: "REASON_CODE_UNMAPPED",
				message: "principal reason code is not in the taxonomy",
			});
			continue;
		}
		if (ADVERSE_REASON_TAXONOMY[reason.code].specificity === "generic") genericCount++;
	}
	if (genericCount > 1) {
		issues.push({
			code: "REASON_SPECIFICITY",
			message: "at most one generic principal reason is allowed",
		});
	}
	if (genericCount === content.principalReasons.length) {
		issues.push({
			code: "REASON_SPECIFICITY",
			message: "at least one specific principal reason is required",
		});
	}
	if (content.notices.length !== profile.disclosures.length) {
		issues.push({
			code: "NOTICE_MISMATCH",
			message: "letter notices must match the profile disclosures exactly",
		});
	}
	for (const [index, disclosure] of profile.disclosures.entries()) {
		if (content.notices[index]?.trim() !== disclosure.text.trim()) {
			issues.push({
				code: "DISCLOSURE_MISSING",
				message: `required disclosure ${disclosure.id} is missing or out of order`,
			});
		}
	}
	if (content.contactPath.trim().length === 0) {
		issues.push({ code: "CONTACT_PATH_MISSING", message: "contact path is missing" });
	}
	return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

export interface AdverseLetterBindingIssue {
	code:
		| "DECISION_ID_MISMATCH"
		| "TITLE_MISMATCH"
		| "CONTACT_PATH_MISMATCH"
		| "REASON_CODE_NOT_IN_DECISION"
		| "REASON_TEXT_MISMATCH"
		| "DUPLICATE_REASON_CODE"
		| "CITATION_NOT_DECISION_REASON";
	message: string;
}

/** Bind an edited/approved letter back to the terminal decision and the
 * profile/config. This is the edit-time guard that stops a client from
 * rewriting provenance while keeping a valid-looking letter. */
function supportingFactField(code: string): string | null {
	if (code === "DELINQUENCIES") return "bureau.delinquencies";
	if (code === "CREDIT_UTILIZATION") return "bureau.utilizationPct";
	return null;
}

export function validateAdverseLetterDecisionBinding(input: {
	content: AdverseActionLetterContent;
	applicationId: string;
	decisionId: string;
	decisionReasonCodes: readonly string[];
	profile: AdverseJurisdictionProfile;
	contactPath: string;
	facts: AdverseReasonFacts;
}): { ok: true } | { ok: false; issues: AdverseLetterBindingIssue[] } {
	const issues: AdverseLetterBindingIssue[] = [];
	const allowed = new Set(input.decisionReasonCodes);
	if (input.content.decisionId !== input.decisionId) {
		issues.push({
			code: "DECISION_ID_MISMATCH",
			message: "letter decision id does not match the case decision",
		});
	}
	if (input.content.title !== input.profile.title) {
		issues.push({
			code: "TITLE_MISMATCH",
			message: "letter title does not match the profile wording",
		});
	}
	if (input.content.contactPath !== input.contactPath) {
		issues.push({
			code: "CONTACT_PATH_MISMATCH",
			message: "letter contact path does not match the configured contact path",
		});
	}
	const seenCodes = new Set<string>();
	for (const reason of input.content.principalReasons) {
		if (seenCodes.has(reason.code)) {
			issues.push({
				code: "DUPLICATE_REASON_CODE",
				message: "principal reason codes must be unique",
			});
		}
		seenCodes.add(reason.code);
		if (!allowed.has(reason.code)) {
			issues.push({
				code: "REASON_CODE_NOT_IN_DECISION",
				message: `reason code ${reason.code} is not part of the decision`,
			});
		}
		if (
			isAdverseReasonCode(reason.code) &&
			reason.text !== ADVERSE_REASON_TAXONOMY[reason.code].render(input.facts)
		) {
			issues.push({
				code: "REASON_TEXT_MISMATCH",
				message: `reason text for ${reason.code} does not match the approved taxonomy wording`,
			});
		}
		const factField = supportingFactField(reason.code);
		for (const citation of reason.citations) {
			const parsed = parseSourceRef(citation.ref);
			const decisionReason =
				parsed !== null &&
				parsed.type === "score_reason" &&
				parsed.scoreId === input.decisionId &&
				parsed.code === reason.code;
			const supportingFact =
				factField !== null &&
				parsed !== null &&
				parsed.type === "case_fact" &&
				parsed.applicationId === input.applicationId &&
				parsed.field === factField;
			if (!decisionReason && !supportingFact) {
				issues.push({
					code: "CITATION_NOT_DECISION_REASON",
					message: `citation for ${reason.code} is not the matching decision reason or supporting fact`,
				});
			}
		}
	}
	return issues.length === 0 ? { ok: true } : { ok: false, issues };
}
