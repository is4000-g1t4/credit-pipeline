// EN-06 policy decision registry (pure, versioned).
//
// Deterministic rule -> policy-section mapping and exception taxonomy for the
// credit decision engine. The model never chooses a mapping, approver,
// mitigant, or state: this module owns them. Rule sections cite POL-CR-009
// (the automatic-processing standard); exception sections cite the existing
// exception/affordability/underwriting policies.

import {
	AUTO_LIMIT_PERSONAL_CENTS,
	AUTO_LIMIT_SME_CENTS,
	AUTO_SCORE,
	DSCR_AUTO_MIN_X100,
	DSCR_DECLINE_MIN_X100,
	DTI_AUTO_MAX_PCT_X100,
	DTI_DECLINE_MAX_PCT_X100,
	MIN_EMPLOYMENT_YEARS,
	MIN_SCORE,
	PERSONAL_MAX_CENTS,
	PERSONAL_MIN_CENTS,
	SME_AUTO_TRADING_YEARS,
	SME_MAX_CENTS,
	SME_MIN_CENTS,
	SME_MIN_REVENUE_CENTS,
	SME_MIN_TRADING_YEARS,
	TERM_MAX_MONTHS,
	TERM_MIN_MONTHS,
	type Product,
} from "./constants.js";
import { hashCanonical } from "./canonical.js";
import type { PolicyReasonCode } from "./reasons.js";

export const POLICY_REGISTRY_VERSION = "policy-registry-v1";
/** Hash of the 9.0-9.4 bodies in POL-CR-009 (checked by seed/approval). */
export const POLICY_ENGINE_STANDARD_HASH =
	"423725bd2c35c3eaf3184dcc796f7432feed9ada01cb1f3033ef04e3982dbecd";

export interface PolicySectionRef {
	policyKey: string;
	sectionId: string;
}

export type PolicyRuleId =
	| "PL-AMOUNT-RANGE"
	| "SME-AMOUNT-RANGE"
	| "PL-TERM-RANGE"
	| "SME-TERM-RANGE"
	| "PL-DTI-HIGH"
	| "PL-SCORE-LOW"
	| "SME-REVENUE-LOW"
	| "SME-TRADING-SHORT"
	| "SME-DSCR-LOW"
	| "SME-SCORE-LOW"
	| "PL-AMOUNT-AUTO"
	| "SME-AMOUNT-AUTO"
	| "PL-SCORE-REFER"
	| "SME-SCORE-REFER"
	| "PL-DTI-REFER"
	| "SME-DSCR-REFER"
	| "PL-EMPLOYMENT-SHORT"
	| "SME-TRADING-REFER"
	| "SME-SECTOR";

export type PolicyRuleEffect = "decline" | "refer" | "informational";
export type PolicyApplicationKind = "individual" | "sme";
export type ExceptionState =
	| "allowed"
	| "prohibited"
	| "not_applicable"
	| "structural_remedy"
	| "mapping_unavailable";
export type ExceptionKind = ExceptionState | "conditional";
export type ApproverLevel = "single_officer" | "team_manager" | "credit_committee";

export type ThresholdKind = "money" | "months" | "years" | "percent" | "ratio" | "score" | "sector";

export interface ThresholdSpec {
	kind: ThresholdKind;
	/** Display string, e.g. "> 50%" or "S$1,000–S$25,000". */
	display: string;
	/** Engine constant or band descriptor; static, never per case. */
	value: number | string;
}

export interface PolicyRuleDefinition {
	ruleId: PolicyRuleId;
	reasonCode: PolicyReasonCode;
	product: Product;
	applicationKind: PolicyApplicationKind;
	effect: PolicyRuleEffect;
	ruleSectionRefs: PolicySectionRef[];
	exceptionSectionRefs: PolicySectionRef[];
	threshold: ThresholdSpec;
	exceptionKind: ExceptionKind;
	notes: string[];
}

export type MitigantCode =
	| "pricing_uplift_50bps"
	| "limit_reduction_20pct"
	| "limit_reduction_25pct"
	| "reviewable_tenor_12m_quarterly"
	| "collateral_top_up_10pp"
	| "secured_cap_50pct"
	| "director_guarantee_full";

export interface PolicyMitigant {
	code: MitigantCode;
	label: string;
	citations: PolicySectionRef[];
}

export interface PolicyExceptionPath {
	state: ExceptionState;
	approver: ApproverLevel | null;
	approverBasis: "standard_authority" | "one_level_above" | "multi_rule" | null;
	approverVerification: "minimum" | "complete";
	committeeCheckRequired: boolean;
	dualSignoff: boolean;
	mitigants: PolicyMitigant[];
	citations: PolicySectionRef[];
	conditions: string[];
	regularisationPlanMaxMonths: number | null;
	reason: string | null;
}

const ref = (policyKey: string, sectionId: string): PolicySectionRef => ({
	policyKey,
	sectionId,
});

const R009_1 = ref("POL-CR-009", "9.1");
const R009_2 = ref("POL-CR-009", "9.2");
const R009_3 = ref("POL-CR-009", "9.3");
const R009_4 = ref("POL-CR-009", "9.4");
const R005_1 = ref("POL-CR-005", "5.1");
const R005_2 = ref("POL-CR-005", "5.2");
const R005_3 = ref("POL-CR-005", "5.3");
const R001_2 = ref("POL-CR-001", "1.2");
const R002_1 = ref("POL-CR-002", "2.1");
const R002_2 = ref("POL-CR-002", "2.2");
const R003_1 = ref("POL-CR-003", "3.1");

function sgd(cents: number): string {
	const whole = Math.floor(cents / 100);
	const fraction = cents % 100;
	const formatted = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	return `S$${formatted}${fraction === 0 ? "" : `.${fraction.toString().padStart(2, "0")}`}`;
}

function def(input: Omit<PolicyRuleDefinition, "threshold"> & { threshold: ThresholdSpec }) {
	return input;
}

export const POLICY_RULE_DEFINITIONS: readonly PolicyRuleDefinition[] = [
	def({
		ruleId: "PL-AMOUNT-RANGE",
		reasonCode: "AMOUNT_OUT_OF_RANGE",
		product: "personal_loan",
		applicationKind: "individual",
		effect: "decline",
		ruleSectionRefs: [R009_1, R009_4],
		exceptionSectionRefs: [R009_1, R009_4],
		threshold: {
			kind: "money",
			display: `${sgd(PERSONAL_MIN_CENTS)}–${sgd(PERSONAL_MAX_CENTS)}`,
			value: PERSONAL_MAX_CENTS,
		},
		exceptionKind: "prohibited",
		notes: ["Outside product bounds; POL-CR-009 9.4 makes this ineligible for exception."],
	}),
	def({
		ruleId: "SME-AMOUNT-RANGE",
		reasonCode: "AMOUNT_OUT_OF_RANGE",
		product: "sme_term_loan",
		applicationKind: "sme",
		effect: "decline",
		ruleSectionRefs: [R009_2, R009_4],
		exceptionSectionRefs: [R009_2, R009_4],
		threshold: {
			kind: "money",
			display: `${sgd(SME_MIN_CENTS)}–${sgd(SME_MAX_CENTS)}`,
			value: SME_MAX_CENTS,
		},
		exceptionKind: "prohibited",
		notes: ["Outside product bounds; POL-CR-009 9.4 makes this ineligible for exception."],
	}),
	def({
		ruleId: "PL-TERM-RANGE",
		reasonCode: "TERM_OUT_OF_RANGE",
		product: "personal_loan",
		applicationKind: "individual",
		effect: "decline",
		ruleSectionRefs: [R009_1, R009_4],
		exceptionSectionRefs: [R009_1, R009_4],
		threshold: {
			kind: "months",
			display: `${TERM_MIN_MONTHS}–${TERM_MAX_MONTHS} months`,
			value: TERM_MAX_MONTHS,
		},
		exceptionKind: "prohibited",
		notes: ["Outside product bounds; POL-CR-009 9.4 makes this ineligible for exception."],
	}),
	def({
		ruleId: "SME-TERM-RANGE",
		reasonCode: "TERM_OUT_OF_RANGE",
		product: "sme_term_loan",
		applicationKind: "sme",
		effect: "decline",
		ruleSectionRefs: [R009_2, R009_4],
		exceptionSectionRefs: [R009_2, R009_4],
		threshold: {
			kind: "months",
			display: `${TERM_MIN_MONTHS}–${TERM_MAX_MONTHS} months`,
			value: TERM_MAX_MONTHS,
		},
		exceptionKind: "prohibited",
		notes: ["Outside product bounds; POL-CR-009 9.4 makes this ineligible for exception."],
	}),
	def({
		ruleId: "PL-DTI-HIGH",
		reasonCode: "DTI_TOO_HIGH",
		product: "personal_loan",
		applicationKind: "individual",
		effect: "decline",
		ruleSectionRefs: [R009_1],
		exceptionSectionRefs: [R002_1, R005_1, R005_2, R005_3, R009_4],
		threshold: { kind: "percent", display: "> 50%", value: DTI_DECLINE_MAX_PCT_X100 },
		exceptionKind: "conditional",
		notes: ["Allowed only up to 55%; above 55% is prohibited by POL-CR-005 5.2."],
	}),
	def({
		ruleId: "PL-SCORE-LOW",
		reasonCode: "SCORE_TOO_LOW",
		product: "personal_loan",
		applicationKind: "individual",
		effect: "decline",
		ruleSectionRefs: [R009_1, R009_4],
		exceptionSectionRefs: [R005_2, R009_4],
		threshold: { kind: "score", display: "< 580", value: MIN_SCORE },
		exceptionKind: "prohibited",
		notes: ["POL-CR-005 5.2 prohibits an exception below 580."],
	}),
	def({
		ruleId: "SME-REVENUE-LOW",
		reasonCode: "REVENUE_TOO_LOW",
		product: "sme_term_loan",
		applicationKind: "sme",
		effect: "decline",
		ruleSectionRefs: [R009_2],
		exceptionSectionRefs: [R009_2],
		threshold: {
			kind: "money",
			display: `< ${sgd(SME_MIN_REVENUE_CENTS)}`,
			value: SME_MIN_REVENUE_CENTS,
		},
		exceptionKind: "mapping_unavailable",
		notes: [
			"No explicit exception taxonomy for revenue. POL-CR-003 3.1's S$200,000 eligibility gate may also apply.",
		],
	}),
	def({
		ruleId: "SME-TRADING-SHORT",
		reasonCode: "TRADING_HISTORY_TOO_SHORT",
		product: "sme_term_loan",
		applicationKind: "sme",
		effect: "decline",
		ruleSectionRefs: [R009_2, R009_4],
		exceptionSectionRefs: [R003_1, R009_4],
		threshold: {
			kind: "years",
			display: `< ${SME_MIN_TRADING_YEARS} year`,
			value: SME_MIN_TRADING_YEARS,
		},
		exceptionKind: "prohibited",
		notes: ["POL-CR-009 9.4 makes trading below 1 year ineligible for exception."],
	}),
	def({
		ruleId: "SME-DSCR-LOW",
		reasonCode: "DSCR_TOO_LOW",
		product: "sme_term_loan",
		applicationKind: "sme",
		effect: "decline",
		ruleSectionRefs: [R009_2, R009_4],
		exceptionSectionRefs: [R002_2, R005_2, R009_4],
		threshold: {
			kind: "ratio",
			display: "< 1.00x",
			value: DSCR_DECLINE_MIN_X100,
		},
		exceptionKind: "prohibited",
		notes: ["POL-CR-005 5.2 prohibits an exception below 1.0x DSCR."],
	}),
	def({
		ruleId: "SME-SCORE-LOW",
		reasonCode: "SCORE_TOO_LOW",
		product: "sme_term_loan",
		applicationKind: "sme",
		effect: "decline",
		ruleSectionRefs: [R009_2, R009_4],
		exceptionSectionRefs: [R005_2, R009_4],
		threshold: { kind: "score", display: "< 580", value: MIN_SCORE },
		exceptionKind: "prohibited",
		notes: ["POL-CR-005 5.2 prohibits an exception below 580."],
	}),
	def({
		ruleId: "PL-AMOUNT-AUTO",
		reasonCode: "AMOUNT_ABOVE_AUTO_LIMIT",
		product: "personal_loan",
		applicationKind: "individual",
		effect: "refer",
		ruleSectionRefs: [R009_1],
		exceptionSectionRefs: [R009_3, R005_1],
		threshold: {
			kind: "money",
			display: `≤ ${sgd(AUTO_LIMIT_PERSONAL_CENTS)}`,
			value: AUTO_LIMIT_PERSONAL_CENTS,
		},
		exceptionKind: "not_applicable",
		notes: ["Refer trigger; standard approval authority applies, not an exception."],
	}),
	def({
		ruleId: "SME-AMOUNT-AUTO",
		reasonCode: "AMOUNT_ABOVE_AUTO_LIMIT",
		product: "sme_term_loan",
		applicationKind: "sme",
		effect: "refer",
		ruleSectionRefs: [R009_2],
		exceptionSectionRefs: [R009_3, R005_1],
		threshold: {
			kind: "money",
			display: `≤ ${sgd(AUTO_LIMIT_SME_CENTS)}`,
			value: AUTO_LIMIT_SME_CENTS,
		},
		exceptionKind: "not_applicable",
		notes: ["Refer trigger; standard approval authority applies, not an exception."],
	}),
	def({
		ruleId: "PL-SCORE-REFER",
		reasonCode: "SCORE_IN_REFER_BAND",
		product: "personal_loan",
		applicationKind: "individual",
		effect: "refer",
		ruleSectionRefs: [R009_1],
		exceptionSectionRefs: [R001_2, R005_1, R005_3],
		threshold: {
			kind: "score",
			display: `${MIN_SCORE}–${AUTO_SCORE - 1}`,
			value: AUTO_SCORE - 1,
		},
		exceptionKind: "conditional",
		notes: [
			"580–649 may proceed under POL-CR-001 1.2 with a 25% exposure reduction and dual sign-off; 650–699 is a standard-authority review.",
		],
	}),
	def({
		ruleId: "SME-SCORE-REFER",
		reasonCode: "SCORE_IN_REFER_BAND",
		product: "sme_term_loan",
		applicationKind: "sme",
		effect: "refer",
		ruleSectionRefs: [R009_2],
		exceptionSectionRefs: [R005_1],
		threshold: {
			kind: "score",
			display: `${MIN_SCORE}–${AUTO_SCORE - 1}`,
			value: AUTO_SCORE - 1,
		},
		exceptionKind: "not_applicable",
		notes: ["Refer trigger; standard approval authority applies, not an exception."],
	}),
	def({
		ruleId: "PL-DTI-REFER",
		reasonCode: "DTI_IN_REFER_BAND",
		product: "personal_loan",
		applicationKind: "individual",
		effect: "refer",
		ruleSectionRefs: [R009_1],
		exceptionSectionRefs: [R002_1, R005_1],
		threshold: {
			kind: "percent",
			display: `> ${DTI_AUTO_MAX_PCT_X100 / 100}%–${DTI_DECLINE_MAX_PCT_X100 / 100}%`,
			value: DTI_AUTO_MAX_PCT_X100,
		},
		exceptionKind: "not_applicable",
		notes: ["Inside POL-CR-002 2.1's 55% cap; this is a review trigger, not an exception."],
	}),
	def({
		ruleId: "SME-DSCR-REFER",
		reasonCode: "DSCR_IN_REFER_BAND",
		product: "sme_term_loan",
		applicationKind: "sme",
		effect: "refer",
		ruleSectionRefs: [R009_2],
		exceptionSectionRefs: [R002_2, R005_1],
		threshold: {
			kind: "ratio",
			display: `${DSCR_DECLINE_MIN_X100 / 100}x–<${DSCR_AUTO_MIN_X100 / 100}x`,
			value: DSCR_AUTO_MIN_X100,
		},
		exceptionKind: "conditional",
		notes: [
			"POL-CR-002 2.2: between 1.0x and the applicable floor (1.25x unsecured, 1.15x secured) is a 12-month reviewable facility; at or above the floor is a standard review.",
		],
	}),
	def({
		ruleId: "PL-EMPLOYMENT-SHORT",
		reasonCode: "SHORT_EMPLOYMENT",
		product: "personal_loan",
		applicationKind: "individual",
		effect: "refer",
		ruleSectionRefs: [R009_1],
		exceptionSectionRefs: [R005_1],
		threshold: {
			kind: "years",
			display: `< ${MIN_EMPLOYMENT_YEARS} year`,
			value: MIN_EMPLOYMENT_YEARS,
		},
		exceptionKind: "not_applicable",
		notes: ["Review trigger; standard approval authority applies."],
	}),
	def({
		ruleId: "SME-TRADING-REFER",
		reasonCode: "TRADING_HISTORY_IN_REFER_BAND",
		product: "sme_term_loan",
		applicationKind: "sme",
		effect: "refer",
		ruleSectionRefs: [R009_2],
		exceptionSectionRefs: [R003_1, R005_1],
		threshold: {
			kind: "years",
			display: `${SME_MIN_TRADING_YEARS}–<${SME_AUTO_TRADING_YEARS} years`,
			value: SME_AUTO_TRADING_YEARS,
		},
		exceptionKind: "structural_remedy",
		notes: [
			"POL-CR-003 3.1 permits 12–24 months only for a secured facility capped at 50% with a full director guarantee.",
		],
	}),
	def({
		ruleId: "SME-SECTOR",
		reasonCode: "SECTOR_REVIEW",
		product: "sme_term_loan",
		applicationKind: "sme",
		effect: "informational",
		ruleSectionRefs: [R009_2],
		exceptionSectionRefs: [R005_1],
		threshold: {
			kind: "sector",
			display: "hospitality|construction",
			value: "hospitality|construction",
		},
		exceptionKind: "not_applicable",
		notes: ["Informational review trigger; no exception required."],
	}),
];

/** Hash of the canonical registry definitions; bump the version on change. */
export const POLICY_REGISTRY_HASH =
	"ef9cb12cc19d3871db10f527a14cafc323c48f58147db8ae0fa39458d989dabb";

/** Recomputed hash for the checked-in integrity test. */
export function computedPolicyRegistryHash(): string {
	return hashCanonical(POLICY_RULE_DEFINITIONS);
}

const BY_REASON_AND_KIND = new Map<string, PolicyRuleDefinition>();
for (const definition of POLICY_RULE_DEFINITIONS) {
	const key = `${definition.reasonCode}:${definition.applicationKind}`;
	if (BY_REASON_AND_KIND.has(key)) {
		throw new Error(`duplicate policy rule for ${key}`);
	}
	BY_REASON_AND_KIND.set(key, definition);
}

export function ruleDefinitionFor(
	reasonCode: PolicyReasonCode | string,
	applicationKind: PolicyApplicationKind,
): PolicyRuleDefinition | undefined {
	return BY_REASON_AND_KIND.get(`${reasonCode}:${applicationKind}`);
}

export function ruleDefinitionById(ruleId: string): PolicyRuleDefinition | undefined {
	return POLICY_RULE_DEFINITIONS.find((definition) => definition.ruleId === ruleId);
}

export interface RegistryCoverage {
	total: number;
	ruleSectionMapped: number;
	exceptionMapped: number;
	unmappedRuleIds: PolicyRuleId[];
	unmappedExceptionRuleIds: PolicyRuleId[];
	duplicateRuleIds: PolicyRuleId[];
	missingReasonCodes: PolicyReasonCode[];
}

const ALL_POLICY_REASON_CODES: readonly PolicyReasonCode[] = [
	"AMOUNT_OUT_OF_RANGE",
	"TERM_OUT_OF_RANGE",
	"DTI_TOO_HIGH",
	"SCORE_TOO_LOW",
	"REVENUE_TOO_LOW",
	"TRADING_HISTORY_TOO_SHORT",
	"DSCR_TOO_LOW",
	"AMOUNT_ABOVE_AUTO_LIMIT",
	"SCORE_IN_REFER_BAND",
	"DTI_IN_REFER_BAND",
	"DSCR_IN_REFER_BAND",
	"SHORT_EMPLOYMENT",
	"TRADING_HISTORY_IN_REFER_BAND",
	"SECTOR_REVIEW",
];

export function registryCoverage(): RegistryCoverage {
	const counts = new Map<string, number>();
	for (const definition of POLICY_RULE_DEFINITIONS) {
		counts.set(definition.ruleId, (counts.get(definition.ruleId) ?? 0) + 1);
	}
	const duplicateRuleIds = [...counts.entries()]
		.filter(([, count]) => count > 1)
		.map(([id]) => id as PolicyRuleId);
	const presentCodes = new Set(POLICY_RULE_DEFINITIONS.map((definition) => definition.reasonCode));
	return {
		total: POLICY_RULE_DEFINITIONS.length,
		ruleSectionMapped: POLICY_RULE_DEFINITIONS.filter(
			(definition) => definition.ruleSectionRefs.length > 0,
		).length,
		exceptionMapped: POLICY_RULE_DEFINITIONS.filter(
			(definition) => definition.exceptionKind !== "mapping_unavailable",
		).length,
		unmappedRuleIds: POLICY_RULE_DEFINITIONS.filter(
			(definition) => definition.ruleSectionRefs.length === 0,
		).map((definition) => definition.ruleId),
		unmappedExceptionRuleIds: POLICY_RULE_DEFINITIONS.filter(
			(definition) => definition.exceptionKind === "mapping_unavailable",
		).map((definition) => definition.ruleId),
		duplicateRuleIds,
		missingReasonCodes: ALL_POLICY_REASON_CODES.filter((code) => !presentCodes.has(code)),
	};
}

export interface RegistryCorpusSection {
	policyKey: string;
	sectionId: string;
	productScope: "individual" | "sme" | "all";
}

export interface RegistryRefValidation {
	missingRefs: string[];
	scopeMismatches: string[];
	missingExceptionRuleIds: PolicyRuleId[];
}

/** Validate every registry ref against the parsed/approved corpus for a case
 * kind. A missing ref or a cross-product section fails closed. */
export function validateRegistryRefs(
	refs: ReadonlySet<string>,
	corpus: readonly RegistryCorpusSection[],
	applicationKind: PolicyApplicationKind,
	requireException: boolean,
): RegistryRefValidation {
	const byRef = new Map(
		corpus.map((section) => [`${section.policyKey}#${section.sectionId}`, section]),
	);
	const missingRefs: string[] = [];
	const scopeMismatches: string[] = [];
	const missingExceptionRuleIds: PolicyRuleId[] = [];
	const check = (refsToCheck: readonly PolicySectionRef[], ruleId: PolicyRuleId): void => {
		for (const sectionRef of refsToCheck) {
			const key = `${sectionRef.policyKey}#${sectionRef.sectionId}`;
			if (!refs.has(key)) {
				if (!missingRefs.includes(key)) missingRefs.push(key);
				continue;
			}
			const row = byRef.get(key);
			if (row && row.productScope !== "all" && row.productScope !== applicationKind) {
				if (!scopeMismatches.includes(key)) scopeMismatches.push(key);
			}
		}
		if (requireException && refsToCheck.length === 0) missingExceptionRuleIds.push(ruleId);
	};
	for (const definition of POLICY_RULE_DEFINITIONS) {
		if (definition.applicationKind !== applicationKind) continue;
		check(definition.ruleSectionRefs, definition.ruleId);
		if (definition.exceptionKind !== "mapping_unavailable") {
			check(definition.exceptionSectionRefs, definition.ruleId);
		}
	}
	return { missingRefs, scopeMismatches, missingExceptionRuleIds };
}

export function standardApproverForAmount(amountCents: number): ApproverLevel {
	if (amountCents <= 5_000_000) return "single_officer";
	if (amountCents <= 20_000_000) return "team_manager";
	return "credit_committee";
}

function exceptionApproverFor(standard: ApproverLevel): ApproverLevel {
	return standard === "single_officer"
		? "team_manager"
		: standard === "team_manager"
			? "credit_committee"
			: "credit_committee";
}

const mitigation = {
	pricing: {
		code: "pricing_uplift_50bps" as const,
		label: "Minimum 50 basis point pricing uplift above the standard risk-based price",
		citations: [R005_3],
	},
	limit20: {
		code: "limit_reduction_20pct" as const,
		label: "20% reduction in exposure versus the applied amount",
		citations: [R005_3],
	},
	limit25: {
		code: "limit_reduction_25pct" as const,
		label: "25% reduction in exposure, overriding the 20% baseline",
		citations: [R001_2],
	},
	reviewable: {
		code: "reviewable_tenor_12m_quarterly" as const,
		label: "12-month reviewable tenor with quarterly covenant testing",
		citations: [R005_3],
	},
	collateral: {
		code: "collateral_top_up_10pp" as const,
		label: "Collateral top-up of at least 10 percentage points of loan-to-value",
		citations: [R005_3],
	},
	secured50: {
		code: "secured_cap_50pct" as const,
		label: "Secured facility capped at 50% of the standard limit",
		citations: [R003_1],
	},
	guarantee: {
		code: "director_guarantee_full" as const,
		label: "Full joint and several director guarantee",
		citations: [R003_1],
	},
};

function basePath(definition: PolicyRuleDefinition): PolicyExceptionPath {
	return {
		state: "mapping_unavailable",
		approver: null,
		approverBasis: null,
		approverVerification: "minimum",
		committeeCheckRequired: true,
		dualSignoff: false,
		mitigants: [],
		citations: definition.exceptionSectionRefs,
		conditions: [],
		regularisationPlanMaxMonths: null,
		reason: null,
	};
}

export interface ResolveExceptionInput {
	definition: PolicyRuleDefinition;
	/** Numeric observed value: cents, months, years, pctX100, ratioX100, score, or sector text. */
	observedValue: number | string;
	amountCents: number;
	/** Count of decline breaches + allowed exceptions, not refer triggers. */
	failedRuleCount: number;
	securedQualifying: boolean;
	/** POL-CR-003 3.1's 50% secured cap; defaults to the general flag. */
	tradingSecured?: boolean;
}

export function resolveExceptionPath(input: ResolveExceptionInput): PolicyExceptionPath {
	const { definition } = input;
	const standard = standardApproverForAmount(input.amountCents);
	const exception = exceptionApproverFor(standard);
	const path = basePath(definition);
	const allowed = (
		mitigants: PolicyMitigant[],
		citations: PolicySectionRef[],
		reason: string | null = null,
	): PolicyExceptionPath => ({
		...path,
		state: "allowed",
		approver: input.failedRuleCount >= 2 ? "credit_committee" : exception,
		approverBasis: input.failedRuleCount >= 2 ? "multi_rule" : "one_level_above",
		dualSignoff: true,
		mitigants,
		citations,
		regularisationPlanMaxMonths: 12,
		reason,
	});
	const structural = (
		mitigants: PolicyMitigant[],
		conditions: string[],
		citations: PolicySectionRef[],
	): PolicyExceptionPath => ({
		...path,
		state: "structural_remedy",
		approver: standard,
		approverBasis: "standard_authority",
		mitigants,
		conditions,
		citations,
		reason: null,
	});
	const notApplicable = (citations: PolicySectionRef[]): PolicyExceptionPath => ({
		...path,
		state: "not_applicable",
		approver: standard,
		approverBasis: "standard_authority",
		citations,
		reason: null,
	});
	const prohibited = (reason: string): PolicyExceptionPath => ({
		...path,
		state: "prohibited",
		reason,
	});
	const unavailable = (reason: string): PolicyExceptionPath => ({
		...path,
		state: "mapping_unavailable",
		reason,
	});

	switch (definition.ruleId) {
		case "PL-DTI-HIGH": {
			const observed = typeof input.observedValue === "number" ? input.observedValue : 0;
			if (observed > 5_500) {
				return prohibited("TDSR above 55% is not exception-eligible under POL-CR-005 5.2.");
			}
			return allowed(
				[mitigation.pricing, mitigation.limit20, mitigation.reviewable, mitigation.collateral],
				[R002_1, R005_1, R005_3, R009_4],
			);
		}
		case "PL-SCORE-REFER": {
			const observed = typeof input.observedValue === "number" ? input.observedValue : 0;
			if (observed < 650) {
				return allowed(
					[mitigation.pricing, mitigation.limit25, mitigation.reviewable],
					[R001_2, R005_1],
				);
			}
			return notApplicable([R001_2, R009_1]);
		}
		case "SME-DSCR-REFER": {
			const observed = typeof input.observedValue === "number" ? input.observedValue : 0;
			const floor = input.securedQualifying ? 115 : 125;
			if (observed >= floor) return notApplicable([R002_2, R009_2]);
			return structural(
				[mitigation.reviewable],
				[
					"12-month reviewable facility",
					"quarterly covenant testing",
					input.securedQualifying
						? "qualifying collateral maintained at or above the secured floor"
						: "unsecured floor 1.25x applies",
				],
				[R002_2],
			);
		}
		case "SME-TRADING-REFER": {
			if (!(input.tradingSecured ?? input.securedQualifying)) {
				return unavailable(
					"POL-CR-003 3.1 permits 12–24 months only for a secured facility with a documented value and LTV; collateral is not qualifying here.",
				);
			}
			return structural(
				[mitigation.secured50, mitigation.guarantee],
				[
					"secured facility capped at 50% of the standard limit",
					"full joint and several director guarantee",
				],
				[R003_1],
			);
		}
		default:
			break;
	}

	switch (definition.exceptionKind) {
		case "allowed":
			return allowed(
				[mitigation.pricing, mitigation.limit20, mitigation.reviewable],
				[R005_1, R005_3],
			);
		case "structural_remedy":
			return structural([], [], definition.exceptionSectionRefs);
		case "not_applicable":
			return notApplicable(definition.exceptionSectionRefs);
		case "prohibited":
			return prohibited(`POL-CR-009 9.4 marks ${definition.ruleId} as not exception-eligible.`);
		case "mapping_unavailable":
			return unavailable(
				"No exception taxonomy is recorded for this rule; a policy owner is required.",
			);
	}
	return unavailable(
		"No exception taxonomy is recorded for this rule; a policy owner is required.",
	);
}
