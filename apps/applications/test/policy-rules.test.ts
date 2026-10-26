// EN-07 rule-context unit tests: pure `buildCaseRuleContextFromRows`, no DB.
// Covers decided/pending/check-only branches, version guard, mapping
// states, secured branches, and the no-PII invariant.
import { describe, expect, it } from "vitest";
import { POLICY_REGISTRY_VERSION, POLICY_VERSION } from "@credit/core";
import {
	buildCaseRuleContextFromRows,
	RuleContextUnavailableError,
	UnsupportedPolicyVersionError,
	type CaseRuleRowInput,
} from "../src/assist/policy-rules.js";

const APP_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const EVAL_ID = "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee";
const DECISION_ID = "dddddddd-dddd-4ddd-dddd-dddddddddddd";

const INDIVIDUAL_REFER = {
	kind: "individual",
	score: 650,
	existingDebtCents: 61_000,
	monthlyIncomeCents: 420_000,
	newPaymentCents: 100_000,
	amountCents: 1_200_000,
	termMonths: 48,
	employmentYears: 6,
} as const;

const INDIVIDUAL_AUTO = {
	kind: "individual",
	score: 760,
	existingDebtCents: 10_000,
	monthlyIncomeCents: 500_000,
	newPaymentCents: 50_000,
	amountCents: 1_000_000,
	termMonths: 48,
	employmentYears: 5,
} as const;

const SME_TRADING_REFER = {
	kind: "sme",
	blendedScore: 720,
	monthlyFcfCents: 200_000,
	existingDebtServiceCents: 0,
	newPaymentCents: 100_000,
	amountCents: 1_000_000,
	termMonths: 36,
	yearsTrading: 1.5,
	annualRevenueCents: 30_000_000,
	industry: "retail",
} as const;

function appRow(over: Partial<CaseRuleRowInput["application"]> = {}) {
	return {
		id: APP_ID,
		status: "pending_review",
		product: "personal_loan",
		amountCents: 1_200_000,
		business: {},
		...over,
	};
}

function evalRow(over: Partial<NonNullable<CaseRuleRowInput["evaluation"]>> = {}) {
	return {
		id: EVAL_ID,
		policyVersion: POLICY_VERSION,
		outcome: "refer",
		reasons: [],
		inputs: INDIVIDUAL_REFER,
		evaluatedAt: new Date("2026-05-01T10:00:00Z"),
		createdAt: new Date("2026-05-01T09:00:00Z"),
		...over,
	};
}

function decisionRow(
	snapshot: unknown,
	over: Partial<NonNullable<CaseRuleRowInput["decision"]>> = {},
) {
	return {
		id: DECISION_ID,
		outcome: "declined",
		snapshot,
		decidedAt: new Date("2026-05-02T10:00:00Z"),
		...over,
	};
}

function creditSnapshot(over: Record<string, unknown> = {}) {
	return {
		kind: "credit",
		inputs: { ...INDIVIDUAL_REFER },
		score: 650,
		grade: "C",
		factors: [],
		rateBps: 1000,
		monthlyPaymentCents: 100_000,
		reasons: [{ code: "SCORE_IN_REFER_BAND", text: "x" }],
		actor: "officer",
		decidedAt: "2026-05-02T10:00:00Z",
		scorecardVersion: "scorecard-v1",
		policyVersion: POLICY_VERSION,
		inputHash: "hash",
		...over,
	};
}

describe("pending cases", () => {
	it("reports refer failures with persisted/decision-relevant flags", () => {
		const context = buildCaseRuleContextFromRows({
			application: appRow(),
			decision: null,
			evaluation: evalRow({
				reasons: [{ code: "SCORE_IN_REFER_BAND" }, { code: "DTI_IN_REFER_BAND" }],
			}),
		});
		expect(context.status).toBe("ok");
		expect(context.policyVersion).toBe(POLICY_VERSION);
		expect(context.registryVersion).toBe(POLICY_REGISTRY_VERSION);
		expect(context.policyAsOf).toBe("2026-05-01");
		expect(context.score).toBe(650);
		expect(context.grade).toBe("C");
		expect(context.scorecardVersion).toBe("scorecard-v1");
		expect(context.evaluationId).toBe(EVAL_ID);
		expect(context.decisionId).toBeNull();
		expect(context.failedRuleCount).toBe(0);
		expect(context.failedRules.map((rule) => rule.ruleId)).toEqual([
			"PL-SCORE-REFER",
			"PL-DTI-REFER",
		]);
		for (const rule of context.failedRules) {
			expect(rule.persisted).toBe(true);
			expect(rule.evaluated).toBe(true);
			expect(rule.decisionRelevant).toBe(true);
			expect(rule.scoreBand).toBe("C");
			expect(rule.mappingState).toBe("mapped");
			expect(rule.ruleSectionRefs.length).toBeGreaterThan(0);
		}
		expect(context.failedRules[0].exception.state).toBe("not_applicable");
		expect(context.failedRules[0].exception.approver).toBe("single_officer");
	});

	it("marks post-decline checks as unevaluated and non-decision-relevant", () => {
		const context = buildCaseRuleContextFromRows({
			application: appRow({ amountCents: 3_000_000 }),
			decision: null,
			evaluation: evalRow({
				outcome: "decline",
				reasons: [{ code: "AMOUNT_OUT_OF_RANGE" }],
				inputs: { ...INDIVIDUAL_REFER, amountCents: 3_000_000, score: 500 },
			}),
		});
		expect(context.status).toBe("ok");
		expect(context.failedRuleCount).toBe(2);
		const [amount, score] = context.failedRules;
		expect(amount.ruleId).toBe("PL-AMOUNT-RANGE");
		expect(amount.evaluated).toBe(true);
		expect(amount.persisted).toBe(true);
		expect(amount.decisionRelevant).toBe(true);
		expect(amount.exception.state).toBe("prohibited");
		expect(score.ruleId).toBe("PL-SCORE-LOW");
		expect(score.evaluated).toBe(false);
		expect(score.persisted).toBe(false);
		expect(score.decisionRelevant).toBe(false);
	});

	it("resolves an allowed DTI decline with mitigants and dual sign-off", () => {
		const context = buildCaseRuleContextFromRows({
			application: appRow(),
			decision: null,
			evaluation: evalRow({
				outcome: "decline",
				reasons: [{ code: "DTI_TOO_HIGH" }],
				inputs: {
					...INDIVIDUAL_REFER,
					score: 700,
					existingDebtCents: 160_000,
					monthlyIncomeCents: 500_000,
				},
			}),
		});
		expect(context.failedRules).toHaveLength(1);
		const [rule] = context.failedRules;
		expect(rule.ruleId).toBe("PL-DTI-HIGH");
		expect(rule.exception.state).toBe("allowed");
		expect(rule.exception.approver).toBe("team_manager");
		expect(rule.exception.dualSignoff).toBe(true);
		expect(rule.exception.mitigants.map((mitigant) => mitigant.code)).toContain(
			"collateral_top_up_10pp",
		);
		expect(context.failedRuleCount).toBe(1);
	});

	it("returns no_failed_rules for a clean auto case", () => {
		const context = buildCaseRuleContextFromRows({
			application: appRow({ amountCents: 1_000_000 }),
			decision: null,
			evaluation: evalRow({
				outcome: "auto_approve",
				reasons: [],
				inputs: { ...INDIVIDUAL_AUTO },
			}),
		});
		expect(context.status).toBe("no_failed_rules");
		expect(context.failedRules).toEqual([]);
		expect(context.failedRuleCount).toBe(0);
	});

	it("rejects a stale engine version", () => {
		expect(() =>
			buildCaseRuleContextFromRows({
				application: appRow(),
				decision: null,
				evaluation: evalRow({ policyVersion: "policy-v0.9" }),
			}),
		).toThrowError(UnsupportedPolicyVersionError);
		try {
			buildCaseRuleContextFromRows({
				application: appRow(),
				decision: null,
				evaluation: evalRow({ policyVersion: "policy-v0.9" }),
			});
		} catch (err) {
			expect((err as UnsupportedPolicyVersionError).code).toBe("UNSUPPORTED_POLICY_VERSION");
		}
	});

	it("fails closed on missing evaluation and unusable inputs", () => {
		expect(() =>
			buildCaseRuleContextFromRows({ application: appRow(), decision: null, evaluation: null }),
		).toThrowError(RuleContextUnavailableError);
		expect(() =>
			buildCaseRuleContextFromRows({
				application: appRow(),
				decision: null,
				evaluation: evalRow({ inputs: { kind: "individual" } }),
			}),
		).toThrowError(RuleContextUnavailableError);
	});
});

describe("decided cases", () => {
	it("uses the frozen snapshot, not the latest evaluation", () => {
		const context = buildCaseRuleContextFromRows({
			application: appRow(),
			decision: decisionRow(creditSnapshot()),
			evaluation: evalRow({
				outcome: "auto_approve",
				reasons: [],
				inputs: { ...INDIVIDUAL_AUTO },
			}),
		});
		expect(context.decisionId).toBe(DECISION_ID);
		expect(context.evaluationId).toBeNull();
		expect(context.score).toBe(650);
		expect(context.grade).toBe("C");
		expect(context.policyAsOf).toBe("2026-05-02");
		expect(context.failedRules.map((rule) => rule.ruleId)).toEqual([
			"PL-SCORE-REFER",
			"PL-DTI-REFER",
		]);
	});

	it("returns not_applicable for check-only decisions", () => {
		const context = buildCaseRuleContextFromRows({
			application: appRow(),
			decision: decisionRow({
				kind: "check_only",
				checks: [],
				reasons: [],
				actor: "officer",
				decidedAt: "2026-05-02T10:00:00Z",
				inputHash: "hash",
			}),
			evaluation: null,
		});
		expect(context.status).toBe("not_applicable");
		expect(context.failedRules).toEqual([]);
		expect(context.failedRuleCount).toBe(0);
		expect(context.score).toBeNull();
		expect(context.limitations).toHaveLength(1);
	});

	it("fails closed on snapshot inputs that fail the schema", () => {
		expect(() =>
			buildCaseRuleContextFromRows({
				application: appRow(),
				decision: decisionRow(creditSnapshot({ inputs: { kind: "individual" }, score: 650 })),
				evaluation: null,
			}),
		).toThrowError(RuleContextUnavailableError);
	});

	it("fails closed on a snapshot without a score", () => {
		expect(() =>
			buildCaseRuleContextFromRows({
				application: appRow(),
				decision: decisionRow(creditSnapshot({ score: undefined })),
				evaluation: null,
			}),
		).toThrowError(RuleContextUnavailableError);
	});
});

describe("secured branches", () => {
	function smeApp(business: unknown) {
		return appRow({
			product: "sme_term_loan",
			amountCents: 1_000_000,
			business,
		});
	}

	function smeEval() {
		return evalRow({
			outcome: "refer",
			reasons: [{ code: "TRADING_HISTORY_IN_REFER_BAND" }],
			inputs: { ...SME_TRADING_REFER },
		});
	}

	it("grants the structural remedy for qualifying collateral", () => {
		const context = buildCaseRuleContextFromRows({
			application: smeApp({ collateral: { hasCollateral: true, valueCents: 5_000_000 } }),
			decision: null,
			evaluation: smeEval(),
		});
		expect(context.secured).toBe(true);
		expect(context.securedQualifying).toBe(true);
		expect(context.status).toBe("ok");
		const [rule] = context.failedRules;
		expect(rule.ruleId).toBe("SME-TRADING-REFER");
		expect(rule.exception.state).toBe("structural_remedy");
		expect(rule.exception.approver).toBe("single_officer");
		expect(rule.exception.dualSignoff).toBe(false);
		expect(rule.explanationLimitation).toBeNull();
	});

	it("fails closed to mapping_unavailable without qualifying collateral", () => {
		for (const business of [{}, { collateral: { hasCollateral: false } }]) {
			const context = buildCaseRuleContextFromRows({
				application: smeApp(business),
				decision: null,
				evaluation: smeEval(),
			});
			expect(context.securedQualifying).toBe(false);
			expect(context.status).toBe("ok");
			expect(context.failedRules[0].mappingState).toBe("mapped");
			expect(context.failedRules[0].exception.state).toBe("mapping_unavailable");
			expect(context.failedRules[0].exception.approver).toBeNull();
			expect(context.limitations.join(" ")).toContain("policy owner is required");
			expect(context.limitations.join(" ")).toContain("unsecured branch");
		}
	});

	it("rejects collateral above the 75% LTV floor", () => {
		const context = buildCaseRuleContextFromRows({
			application: smeApp({ collateral: { hasCollateral: true, valueCents: 1_100_000 } }),
			decision: null,
			evaluation: smeEval(),
		});
		expect(context.secured).toBe(true);
		expect(context.securedQualifying).toBe(false);
		expect(context.status).toBe("ok");
		expect(context.failedRules[0].mappingState).toBe("mapped");
		expect(context.failedRules[0].exception.state).toBe("mapping_unavailable");
	});

	it("keeps the 50% trading cap separate from the general LTV floor", () => {
		const context = buildCaseRuleContextFromRows({
			application: smeApp({ collateral: { hasCollateral: true, valueCents: 1_500_000 } }),
			decision: null,
			evaluation: smeEval(),
		});
		expect(context.secured).toBe(true);
		expect(context.securedQualifying).toBe(true);
		expect(context.failedRules[0].ruleId).toBe("SME-TRADING-REFER");
		expect(context.failedRules[0].exception.state).toBe("mapping_unavailable");
	});

	it("applies the secured DSCR floor only for qualifying collateral", () => {
		const dscrEval = () =>
			evalRow({
				outcome: "refer",
				reasons: [{ code: "DSCR_IN_REFER_BAND" }],
				inputs: { ...SME_TRADING_REFER, monthlyFcfCents: 120_000, yearsTrading: 5 },
			});
		const secured = buildCaseRuleContextFromRows({
			application: smeApp({ collateral: { hasCollateral: true, valueCents: 5_000_000 } }),
			decision: null,
			evaluation: dscrEval(),
		});
		expect(secured.failedRules[0].ruleId).toBe("SME-DSCR-REFER");
		expect(secured.failedRules[0].exception.state).toBe("not_applicable");
		const unsecured = buildCaseRuleContextFromRows({
			application: smeApp({}),
			decision: null,
			evaluation: dscrEval(),
		});
		expect(unsecured.failedRules[0].exception.state).toBe("structural_remedy");
	});
});

describe("mapping states", () => {
	it("reports partial_mapping when only some failures lack a taxonomy", () => {
		const context = buildCaseRuleContextFromRows({
			application: appRow({ product: "sme_term_loan", amountCents: 2_000_000 }),
			decision: null,
			evaluation: evalRow({
				outcome: "decline",
				reasons: [{ code: "REVENUE_TOO_LOW" }],
				inputs: {
					kind: "sme",
					blendedScore: 700,
					monthlyFcfCents: 200_000,
					existingDebtServiceCents: 0,
					newPaymentCents: 100_000,
					amountCents: 2_000_000,
					termMonths: 36,
					yearsTrading: 0.5,
					annualRevenueCents: 3_000_000,
					industry: "retail",
				},
			}),
		});
		expect(context.status).toBe("ok");
		expect(context.failedRules.map((rule) => rule.ruleId)).toEqual([
			"SME-REVENUE-LOW",
			"SME-TRADING-SHORT",
		]);
		expect(context.failedRules.map((rule) => rule.mappingState)).toEqual(["mapped", "mapped"]);
		expect(context.failedRules[0].exception.state).toBe("mapping_unavailable");
		expect(context.failedRules[1].exception.state).toBe("prohibited");
		expect(context.limitations.join(" ")).toContain("policy owner is required");
	});
});

describe("privacy", () => {
	it("never embeds applicant names or business identifiers", () => {
		const context = buildCaseRuleContextFromRows({
			application: appRow({
				business: {
					companyName: "SECRET-ACME-98765",
					collateral: { hasCollateral: true, valueCents: 5_000_000 },
				},
			}),
			decision: null,
			evaluation: evalRow({
				reasons: [{ code: "SCORE_IN_REFER_BAND" }, { code: "DTI_IN_REFER_BAND" }],
			}),
		});
		const serialized = JSON.stringify(context);
		expect(serialized).not.toContain("SECRET-ACME");
		expect(serialized).not.toContain("98765");
	});
});
