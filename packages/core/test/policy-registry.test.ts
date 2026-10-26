import { describe, expect, it } from "vitest";
import {
	POLICY_ENGINE_STANDARD_HASH,
	POLICY_REGISTRY_HASH,
	POLICY_RULE_DEFINITIONS,
	computedPolicyRegistryHash,
	registryCoverage,
	resolveExceptionPath,
	ruleDefinitionFor,
	standardApproverForAmount,
	validateRegistryRefs,
	type RegistryCorpusSection,
} from "../src/index.js";
import {
	evaluatePolicy,
	explainPolicyRules,
	policyInputsSchema,
	type PolicyInputs,
} from "../src/index.js";

type Ind = Extract<PolicyInputs, { kind: "individual" }>;
type Sme = Extract<PolicyInputs, { kind: "sme" }>;

const indBase: Ind = {
	kind: "individual",
	score: 750,
	existingDebtCents: 20_000,
	monthlyIncomeCents: 100_000,
	newPaymentCents: 15_000,
	amountCents: 1_200_000,
	termMonths: 36,
	employmentYears: 3,
};

const smeBase: Sme = {
	kind: "sme",
	blendedScore: 750,
	monthlyFcfCents: 1_500_000,
	existingDebtServiceCents: 0,
	newPaymentCents: 1_000_000,
	amountCents: 2_000_000,
	termMonths: 36,
	yearsTrading: 4,
	annualRevenueCents: 120_000_000,
	industry: "services",
};

function corpusFor(kind: "individual" | "sme"): RegistryCorpusSection[] {
	const refs = new Map<string, RegistryCorpusSection>();
	for (const definition of POLICY_RULE_DEFINITIONS) {
		if (definition.applicationKind !== kind) continue;
		for (const section of [...definition.ruleSectionRefs, ...definition.exceptionSectionRefs]) {
			refs.set(`${section.policyKey}#${section.sectionId}`, {
				policyKey: section.policyKey,
				sectionId: section.sectionId,
				productScope:
					section.policyKey === "POL-CR-001"
						? "individual"
						: section.policyKey === "POL-CR-003"
							? "sme"
							: "all",
			});
		}
	}
	return [...refs.values()];
}

describe("EN-06 policy registry", () => {
	it("covers all 19 rules and every engine reason code", () => {
		const coverage = registryCoverage();
		expect(POLICY_RULE_DEFINITIONS).toHaveLength(19);
		expect(coverage.missingReasonCodes).toEqual([]);
		expect(coverage.duplicateRuleIds).toEqual([]);
		expect(coverage.unmappedRuleIds).toEqual([]);
		expect(coverage.unmappedExceptionRuleIds).toEqual(["SME-REVENUE-LOW"]);
	});

	it("has a stable registry and engine-standard hash", () => {
		expect(computedPolicyRegistryHash()).toBe(POLICY_REGISTRY_HASH);
		expect(POLICY_ENGINE_STANDARD_HASH).toMatch(/^[a-f0-9]{64}$/);
	});

	it("validates refs and product scope for both case kinds", () => {
		for (const kind of ["individual", "sme"] as const) {
			const corpus = corpusFor(kind);
			const refs = new Set(corpus.map((section) => `${section.policyKey}#${section.sectionId}`));
			expect(validateRegistryRefs(refs, corpus, kind, true)).toEqual({
				missingRefs: [],
				scopeMismatches: [],
				missingExceptionRuleIds: [],
			});
		}
		const sme = corpusFor("sme");
		const refs = new Set(sme.map((section) => `${section.policyKey}#${section.sectionId}`));
		const mismatch = validateRegistryRefs(refs, sme, "individual", true);
		expect(mismatch.scopeMismatches).toEqual([]);
	});

	it("resolves the approver ladder", () => {
		expect(standardApproverForAmount(5_000_000)).toBe("single_officer");
		expect(standardApproverForAmount(5_000_001)).toBe("team_manager");
		expect(standardApproverForAmount(20_000_000)).toBe("team_manager");
		expect(standardApproverForAmount(20_000_001)).toBe("credit_committee");
	});

	it("resolves DTI exceptions and the 55% prohibition boundary", () => {
		const definition = ruleDefinitionFor("DTI_TOO_HIGH", "individual")!;
		const allowed = resolveExceptionPath({
			definition,
			observedValue: 5_200,
			amountCents: 3_000_000,
			failedRuleCount: 1,
			securedQualifying: false,
		});
		expect(allowed.state).toBe("allowed");
		expect(allowed.approver).toBe("team_manager");
		expect(allowed.dualSignoff).toBe(true);
		expect(allowed.regularisationPlanMaxMonths).toBe(12);
		expect(allowed.mitigants.map((mitigant) => mitigant.code)).toContain("limit_reduction_20pct");

		const prohibited = resolveExceptionPath({
			definition,
			observedValue: 5_501,
			amountCents: 3_000_000,
			failedRuleCount: 1,
			securedQualifying: false,
		});
		expect(prohibited.state).toBe("prohibited");
		expect(prohibited.approver).toBeNull();
	});

	it("escalates only when two exception-eligible rules fail", () => {
		const definition = ruleDefinitionFor("DTI_TOO_HIGH", "individual")!;
		const escalated = resolveExceptionPath({
			definition,
			observedValue: 5_200,
			amountCents: 3_000_000,
			failedRuleCount: 2,
			securedQualifying: false,
		});
		expect(escalated.approver).toBe("credit_committee");
		expect(escalated.approverBasis).toBe("multi_rule");

		const single = resolveExceptionPath({
			definition,
			observedValue: 5_200,
			amountCents: 3_000_000,
			failedRuleCount: 1,
			securedQualifying: false,
		});
		expect(single.approver).toBe("team_manager");
	});

	it("uses the 1.2 25% reduction for a 580-649 score refer", () => {
		const definition = ruleDefinitionFor("SCORE_IN_REFER_BAND", "individual")!;
		const allowed = resolveExceptionPath({
			definition,
			observedValue: 620,
			amountCents: 2_000_000,
			failedRuleCount: 1,
			securedQualifying: false,
		});
		expect(allowed.state).toBe("allowed");
		const codes = allowed.mitigants.map((mitigant) => mitigant.code);
		expect(codes).toContain("limit_reduction_25pct");
		expect(codes).not.toContain("limit_reduction_20pct");

		const standard = resolveExceptionPath({
			definition,
			observedValue: 680,
			amountCents: 2_000_000,
			failedRuleCount: 1,
			securedQualifying: false,
		});
		expect(standard.state).toBe("not_applicable");
	});

	it("handles DSCR structural remedies with and without qualifying collateral", () => {
		const definition = ruleDefinitionFor("DSCR_IN_REFER_BAND", "sme")!;
		const unsecured = resolveExceptionPath({
			definition,
			observedValue: 120,
			amountCents: 6_000_000,
			failedRuleCount: 1,
			securedQualifying: false,
		});
		expect(unsecured.state).toBe("structural_remedy");
		expect(unsecured.approver).toBe("team_manager");
		expect(unsecured.dualSignoff).toBe(false);

		const secured = resolveExceptionPath({
			definition,
			observedValue: 120,
			amountCents: 6_000_000,
			failedRuleCount: 1,
			securedQualifying: true,
		});
		expect(secured.state).toBe("not_applicable");

		const securedBelowFloor = resolveExceptionPath({
			definition,
			observedValue: 110,
			amountCents: 6_000_000,
			failedRuleCount: 1,
			securedQualifying: true,
		});
		expect(securedBelowFloor.state).toBe("structural_remedy");
	});

	it("fails closed for unsecured trading and revenue rules", () => {
		const trading = ruleDefinitionFor("TRADING_HISTORY_IN_REFER_BAND", "sme")!;
		expect(
			resolveExceptionPath({
				definition: trading,
				observedValue: 1.5,
				amountCents: 6_000_000,
				failedRuleCount: 1,
				securedQualifying: false,
			}).state,
		).toBe("mapping_unavailable");
		expect(
			resolveExceptionPath({
				definition: trading,
				observedValue: 1.5,
				amountCents: 6_000_000,
				failedRuleCount: 1,
				securedQualifying: true,
			}).state,
		).toBe("structural_remedy");

		const revenue = ruleDefinitionFor("REVENUE_TOO_LOW", "sme")!;
		expect(
			resolveExceptionPath({
				definition: revenue,
				observedValue: 4_000_000,
				amountCents: 6_000_000,
				failedRuleCount: 1,
				securedQualifying: false,
			}).state,
		).toBe("mapping_unavailable");
	});

	it("marks out-of-product and below-minimum rules prohibited", () => {
		for (const reason of ["AMOUNT_OUT_OF_RANGE", "TERM_OUT_OF_RANGE"] as const) {
			const definition = ruleDefinitionFor(reason, "individual")!;
			const path = resolveExceptionPath({
				definition,
				observedValue: 1,
				amountCents: 1_000_000,
				failedRuleCount: 1,
				securedQualifying: false,
			});
			expect(path.state).toBe("prohibited");
			expect(path.approver).toBeNull();
		}
		const score = ruleDefinitionFor("SCORE_TOO_LOW", "individual")!;
		expect(
			resolveExceptionPath({
				definition: score,
				observedValue: 520,
				amountCents: 1_000_000,
				failedRuleCount: 1,
				securedQualifying: false,
			}).state,
		).toBe("prohibited");
	});

	it("strips booking extras from policy inputs", () => {
		const parsed = policyInputsSchema.parse({
			...indBase,
			approvedAmountCents: 1_000_000,
			requestId: "extra",
		});
		expect(parsed).toEqual(indBase);
	});
});

describe("explainPolicyRules", () => {
	it("returns no failures for an auto-approved case", () => {
		const evaluation = evaluatePolicy(indBase);
		expect(evaluation.outcome).toBe("auto_approve");
		expect(explainPolicyRules(indBase, evaluation.reasons)).toEqual([]);
	});

	it("matches the persisted reason set for a refer case", () => {
		const inputs: Ind = {
			...indBase,
			score: 680,
			amountCents: 1_800_000,
			existingDebtCents: 35_000,
			newPaymentCents: 15_000,
		};
		const evaluation = evaluatePolicy(inputs);
		expect(evaluation.outcome).toBe("refer");
		const failures = explainPolicyRules(inputs, evaluation.reasons);
		const persisted = failures
			.filter((failure) => failure.persisted)
			.map((failure) => failure.reasonCode);
		expect(persisted).toEqual(evaluation.reasons.map((reason) => reason.code));
		expect(failures.map((failure) => failure.ruleId)).toEqual(
			expect.arrayContaining(["PL-AMOUNT-AUTO", "PL-SCORE-REFER", "PL-DTI-REFER"]),
		);
	});

	it("reports post-decline checks as not evaluated", () => {
		const inputs: Ind = {
			...indBase,
			amountCents: 3_000_000,
			score: 500,
			existingDebtCents: 60_000,
			newPaymentCents: 15_000,
		};
		const evaluation = evaluatePolicy(inputs);
		expect(evaluation.reasons.map((reason) => reason.code)).toEqual(["AMOUNT_OUT_OF_RANGE"]);
		const failures = explainPolicyRules(inputs, evaluation.reasons);
		expect(failures[0]?.reasonCode).toBe("AMOUNT_OUT_OF_RANGE");
		expect(failures[0]?.evaluated).toBe(true);
		expect(failures[0]?.persisted).toBe(true);
		expect(failures.slice(1).every((failure) => failure.evaluated === false)).toBe(true);
		expect(failures.slice(1).every((failure) => failure.persisted === false)).toBe(true);
	});

	it("includes the informational sector trigger and the refer cap", () => {
		const inputs: Sme = {
			...smeBase,
			amountCents: 6_000_000,
			blendedScore: 680,
			monthlyFcfCents: 1_200_000,
			newPaymentCents: 1_000_000,
			yearsTrading: 1.5,
			industry: "hospitality",
		};
		const evaluation = evaluatePolicy(inputs);
		expect(evaluation.outcome).toBe("refer");
		expect(evaluation.reasons).toHaveLength(4);
		expect(evaluation.reasons.map((reason) => reason.code)).not.toContain("SECTOR_REVIEW");
		const failures = explainPolicyRules(inputs, evaluation.reasons);
		const sector = failures.find((failure) => failure.reasonCode === "SECTOR_REVIEW");
		expect(sector?.effect).toBe("informational");
		expect(sector?.persisted).toBe(false);
		expect(sector?.evaluated).toBe(true);
	});
});
