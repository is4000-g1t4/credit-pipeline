// Pure E3 validator tests: no DB, no network, no runner.
import { describe, expect, it } from "vitest";
import {
	hashQuote,
	resolveExceptionPath,
	ruleDefinitionById,
	type EvidenceBundle,
	type EvidenceItem,
} from "@credit/core";
import {
	validateExplanation,
	validateFollowUp,
	validatePolicyMemoDraft,
	type CaseRuleContext,
	type PolicySectionDelivery,
} from "../../src/agents/policy-exception/index.js";

const APP_ID = "55555555-5555-4555-8555-555555555555";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const POLICY_ID = "11111111-1111-4111-8111-111111111111";
const APP_REF = "APP-2026-ABCDEF";

const BODY_91 =
	"Individual automatic-processing bands apply to amounts from S$1,000 to S$25,000 with assessment values recorded for the file.";
const QUOTE_A = "amounts from S$1,000 to S$25,000 with assessment values";
const BODY_12 =
	"Scores from 580 to 649 may proceed with a 25% exposure reduction and dual sign-off recorded for the file.";
const QUOTE_B = "may proceed with a 25% exposure reduction and dual sign-off";
const BODY_51 =
	"Exceptions require dual sign-off with a regularisation plan of up to 12 months recorded for the file.";
const QUOTE_C = "require dual sign-off with a regularisation plan of up to 12 months";
const BODY_21 =
	"Total debt servicing ratio above 50% is reviewed, with a hard cap of 55% recorded for the file.";
const QUOTE_D = "is reviewed, with a hard cap of 55% recorded";
const BODY_53 =
	"Standard mitigants are a 50 basis point uplift with a 20% exposure reduction recorded for the file.";
const QUOTE_E = "a 50 basis point uplift with a 20% exposure reduction";

function delivery(
	policyKey: string,
	sectionId: string,
	heading: string,
	body: string,
): PolicySectionDelivery {
	return {
		policyId: POLICY_ID,
		policyVersionId: VERSION_ID,
		policyKey,
		sectionId,
		version: "v1",
		heading,
		body,
		truncated: false,
		effectiveFrom: "2026-01-01",
		effectiveTo: null,
		contentHash: "0123456789abcdef0123456789abcdef",
		quoteHash: hashQuote(body),
		drawerToken: "drawer-token",
	};
}

function catalog(): PolicySectionDelivery[] {
	return [
		delivery("POL-CR-009", "9.1", "Individual automatic-processing bands", BODY_91),
		delivery("POL-CR-001", "1.2", "Assessment band review", BODY_12),
		delivery("POL-CR-005", "5.1", "Exception approval route", BODY_51),
	];
}

function policyRef(section: PolicySectionDelivery): string {
	return `policy_section:${section.policyKey}:${section.policyVersionId}:${section.sectionId}:${section.quoteHash}`;
}

function evidenceFor(sections: PolicySectionDelivery[]): EvidenceBundle {
	return {
		applicationId: APP_ID,
		asOf: "2026-06-30T00:00:00.000Z",
		assembledAt: "2026-06-30T01:00:00.000Z",
		items: sections.map((section): EvidenceItem => ({
			ref: policyRef(section),
			sourceType: "policy_section",
			label: section.heading,
			content: section.body,
			access: { retentionUntil: null, legalHold: false },
			metadata: {},
		})),
		unavailable: [],
	};
}

function ruleContext(over: Partial<CaseRuleContext> = {}): CaseRuleContext {
	const definition = ruleDefinitionById("PL-SCORE-REFER");
	if (!definition) throw new Error("registry missing PL-SCORE-REFER");
	return {
		applicationId: APP_ID,
		applicationReference: APP_REF,
		policyAsOf: "2026-06-30",
		product: "personal_loan",
		applicationKind: "individual",
		outcome: "refer",
		policyVersion: "v1",
		scorecardVersion: "scorecard-v1",
		registryVersion: "policy-registry-v1",
		score: 620,
		grade: "C",
		scoreBand: "review",
		amountCents: 6_000_000,
		secured: false,
		securedQualifying: false,
		status: "ok",
		failedRules: [
			{
				ruleId: "PL-SCORE-REFER",
				reasonCode: "SCORE_IN_REFER_BAND",
				effect: "refer",
				evaluated: true,
				persisted: true,
				decisionRelevant: true,
				observedValue: 620,
				observed: "620",
				threshold: definition.threshold.display,
				scoreBand: "review",
				ruleSectionRefs: definition.ruleSectionRefs,
				exception: resolveExceptionPath({
					definition,
					observedValue: 620,
					amountCents: 6_000_000,
					failedRuleCount: 1,
					securedQualifying: false,
				}),
				mappingState: "mapped",
				explanationLimitation: null,
			},
		],
		unmappedRuleIds: [],
		unmappedExceptionRuleIds: [],
		limitations: [],
		...over,
	};
}

function explainRule(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		ruleId: "PL-SCORE-REFER",
		segments: [
			{
				text: "The assessment value is recorded below the automatic band for PL-SCORE-REFER.",
				citationIndexes: [0],
			},
		],
		citations: [{ policyKey: "POL-CR-009", sectionId: "9.1", quote: QUOTE_A }],
		confidence: "medium",
		...over,
	};
}

function explainAnswer(over: Record<string, unknown> = {}): unknown {
	return { status: "succeeded", rules: [explainRule()], limitations: [], ...over };
}

function memoCatalog(): PolicySectionDelivery[] {
	return [
		delivery("POL-CR-009", "9.1", "Individual automatic-processing bands", BODY_91),
		delivery("POL-CR-002", "2.1", "Servicing ratio cap", BODY_21),
		delivery("POL-CR-005", "5.3", "Standard mitigants", BODY_53),
		delivery("POL-CR-005", "5.1", "Exception approval route", BODY_51),
	];
}

/** DTI-high context: an allowed exception whose ids prose can quote without
 * tripping the EN-03 descriptor ban (score/rate/limit/terms still banned in
 * core memo scans until the action-only profile lands). */
function dtiContext(): CaseRuleContext {
	const definition = ruleDefinitionById("PL-DTI-HIGH");
	if (!definition) throw new Error("registry missing PL-DTI-HIGH");
	const base = ruleContext();
	return {
		...base,
		failedRules: [
			{
				ruleId: "PL-DTI-HIGH",
				reasonCode: "DTI_TOO_HIGH",
				effect: "decline",
				evaluated: true,
				persisted: true,
				decisionRelevant: true,
				observedValue: 5200,
				observed: "52.00%",
				threshold: "> 50%",
				scoreBand: "review",
				ruleSectionRefs: definition.ruleSectionRefs,
				exception: resolveExceptionPath({
					definition,
					observedValue: 5200,
					amountCents: 6_000_000,
					failedRuleCount: 1,
					securedQualifying: false,
				}),
				mappingState: "mapped",
				explanationLimitation: null,
			},
		],
	};
}

function memoContent(sections: PolicySectionDelivery[]): unknown {
	const [s91, s21, s53, s51] = sections;
	if (!s91 || !s21 || !s53 || !s51) throw new Error("catalog fixture changed");
	return {
		title: "Policy exception memo draft",
		sections: [
			{
				key: "rule_breached",
				title: "Rule breached",
				claims: [
					{
						text: "The servicing ratio is recorded above the automatic band for PL-DTI-HIGH.",
						citations: [{ ref: policyRef(s91), quote: QUOTE_A }],
					},
				],
				notAvailable: false,
			},
			{
				key: "compensating_factors",
				title: "Compensating factors",
				claims: [
					{
						text: "The file shows steady repayment capacity for the period.",
						citations: [{ ref: policyRef(s21), quote: QUOTE_D }],
					},
				],
				notAvailable: false,
			},
			{
				key: "mitigants",
				title: "Mitigants",
				claims: [
					{
						text: "A 20% exposure reduction is recorded with dual sign-off.",
						citations: [{ ref: policyRef(s53), quote: QUOTE_E }],
					},
				],
				notAvailable: false,
			},
			{
				key: "regularisation_plan",
				title: "Regularisation plan",
				claims: [
					{
						text: "A regularisation plan of up to 12 months is recorded.",
						citations: [{ ref: policyRef(s51), quote: QUOTE_C }],
					},
				],
				notAvailable: false,
			},
		],
		openItems: [],
		rules: [
			{
				ruleId: "PL-DTI-HIGH",
				reasonCode: "DTI_TOO_HIGH",
				observed: "52.00%",
				threshold: "> 50%",
				effect: "decline",
				persisted: true,
				exceptionState: "allowed",
				approver: "credit_committee",
				mitigantCodes: [
					"pricing_uplift_50bps",
					"limit_reduction_20pct",
					"reviewable_tenor_12m_quarterly",
					"collateral_top_up_10pp",
				],
				ruleSectionRefs: [{ policyKey: "POL-CR-009", sectionId: "9.1" }],
			},
		],
		regularisationPlanMonths: 12,
	};
}

describe("validateExplanation", () => {
	it("accepts a grounded explanation", () => {
		const result = validateExplanation(explainAnswer(), ruleContext(), catalog());
		expect(result.ok).toBe(true);
		expect(result.answer?.rules).toHaveLength(1);
		expect(result.issues).toEqual([]);
	});

	it("rejects non-JSON and duplicate rules, and fills missing coverage", () => {
		expect(validateExplanation("not json", ruleContext(), catalog()).ok).toBe(false);
		const missing = validateExplanation(explainAnswer({ rules: [] }), ruleContext(), catalog());
		expect(missing.ok).toBe(true);
		expect(missing.answer?.rules.map((rule) => rule.ruleId)).toContain("PL-SCORE-REFER");
		const duplicate = validateExplanation(
			explainAnswer({ rules: [explainRule(), explainRule()] }),
			ruleContext(),
			catalog(),
		);
		expect(duplicate.ok).toBe(false);
		expect(duplicate.issues).toContainEqual(expect.objectContaining({ code: "RULE_COVERAGE" }));
	});

	it("rejects wrong sections, short quotes, and quote mismatches", () => {
		const extended = [...catalog(), delivery("POL-CR-002", "2.1", "Servicing ratio cap", BODY_21)];
		const wrongSection = validateExplanation(
			explainAnswer({
				rules: [
					explainRule({
						citations: [{ policyKey: "POL-CR-002", sectionId: "2.1", quote: QUOTE_D }],
					}),
				],
			}),
			ruleContext(),
			extended,
		);
		expect(wrongSection.ok).toBe(false);
		expect(wrongSection.issues).toContainEqual(
			expect.objectContaining({ code: "CITATION_SECTION_MISMATCH" }),
		);

		const short = validateExplanation(
			explainAnswer({
				rules: [
					explainRule({
						citations: [{ policyKey: "POL-CR-009", sectionId: "9.1", quote: "too short" }],
					}),
				],
			}),
			ruleContext(),
			catalog(),
		);
		expect(short.issues).toContainEqual(expect.objectContaining({ code: "QUOTE_TOO_SHORT" }));

		const mismatch = validateExplanation(
			explainAnswer({
				rules: [
					explainRule({
						citations: [{ policyKey: "POL-CR-009", sectionId: "9.1", quote: QUOTE_C }],
					}),
				],
			}),
			ruleContext(),
			catalog(),
		);
		expect(mismatch.issues).toContainEqual(
			expect.objectContaining({ code: "CITATION_QUOTE_MISMATCH" }),
		);
	});

	it("rejects unmapped rules, decision language, foreign refs, and numeric mismatch", () => {
		const segmentWith = (text: string) =>
			explainAnswer({ rules: [explainRule({ segments: [{ text, citationIndexes: [0] }] })] });
		const unmapped = validateExplanation(
			explainAnswer({ rules: [explainRule({ ruleId: "PL-DTI-HIGH" })] }),
			ruleContext(),
			catalog(),
		);
		expect(unmapped.issues).toContainEqual(expect.objectContaining({ code: "UNMAPPED_RULE" }));

		const language = validateExplanation(
			segmentWith("The officer should approve the file for PL-SCORE-REFER."),
			ruleContext(),
			catalog(),
		);
		expect(language.issues).toContainEqual(expect.objectContaining({ code: "ACTION_LANGUAGE" }));

		const foreign = validateExplanation(
			segmentWith("The file APP-2025-ABCDEF is recorded for PL-SCORE-REFER."),
			ruleContext(),
			catalog(),
		);
		expect(foreign.issues).toContainEqual(expect.objectContaining({ code: "FOREIGN_REFERENCE" }));

		const numeric = validateExplanation(
			segmentWith("A 55% charge is recorded for PL-SCORE-REFER."),
			ruleContext(),
			catalog(),
		);
		expect(numeric.issues).toContainEqual(expect.objectContaining({ code: "NUMERIC_MISMATCH" }));

		for (const result of [unmapped, language, foreign, numeric]) {
			expect(result.ok).toBe(false);
		}
	});

	it("accepts the current application reference but rejects out-of-range citations", () => {
		const current = validateExplanation(
			explainAnswer({
				rules: [
					explainRule({
						segments: [
							{
								text: `The file ${APP_REF} notes PL-SCORE-REFER for the record.`,
								citationIndexes: [0],
							},
						],
					}),
				],
			}),
			ruleContext(),
			catalog(),
		);
		expect(current.ok).toBe(true);

		const badIndex = validateExplanation(
			explainAnswer({
				rules: [
					explainRule({
						segments: [{ text: "The assessment value is recorded.", citationIndexes: [3] }],
					}),
				],
			}),
			ruleContext(),
			catalog(),
		);
		expect(badIndex.issues).toContainEqual(expect.objectContaining({ code: "CITATION_MISSING" }));
	});
});

describe("validateFollowUp", () => {
	it("accepts needs_policy_owner and rejects uncited success prose", () => {
		const sections = catalog();
		const owned = validateFollowUp(
			{
				status: "needs_policy_owner",
				segments: [],
				citations: [],
				limitations: ["Policy owner review is required for the unmapped rule."],
			},
			ruleContext({ unmappedRuleIds: ["PL-DTI-HIGH"] }),
			sections,
		);
		expect(owned.ok).toBe(true);

		const uncited = validateFollowUp(
			{
				status: "succeeded",
				segments: [{ text: "The assessment value is recorded.", citationIndexes: [0] }],
				citations: [],
				limitations: [],
			},
			ruleContext(),
			sections,
		);
		expect(uncited.ok).toBe(false);
	});
});

describe("validatePolicyMemoDraft", () => {
	it("accepts a composed memo", () => {
		const sections = memoCatalog();
		const result = validatePolicyMemoDraft(
			memoContent(sections),
			dtiContext(),
			sections,
			evidenceFor(sections),
		);
		expect(result.ok).toBe(true);
		expect(result.content?.regularisationPlanMonths).toBe(12);
		expect(result.issues).toEqual([]);
	});

	it("rejects plans over 12 months and mitigant contradictions", () => {
		const sections = memoCatalog();
		const over = memoContent(sections) as Record<string, unknown>;
		over["regularisationPlanMonths"] = 13;
		const planned = validatePolicyMemoDraft(over, dtiContext(), sections, evidenceFor(sections));
		expect(planned.issues).toContainEqual(expect.objectContaining({ code: "PLAN_MONTHS" }));

		const contradicted = memoContent(sections) as {
			sections: Array<{ key: string; claims: unknown[]; notAvailable: boolean }>;
		};
		const mitigants = contradicted.sections.find((section) => section.key === "mitigants");
		if (!mitigants) throw new Error("memo fixture changed");
		mitigants.claims = [];
		mitigants.notAvailable = true;
		const missing = validatePolicyMemoDraft(
			contradicted,
			dtiContext(),
			sections,
			evidenceFor(sections),
		);
		expect(missing.issues).toContainEqual(expect.objectContaining({ code: "SECTION_STATE" }));
	});

	it("rejects foreign rules and missing decision-relevant coverage", () => {
		const sections = memoCatalog();
		const foreign = memoContent(sections) as {
			sections: Array<{ key: string; claims: Array<{ text: string }> }>;
		};
		const breach = foreign.sections.find((section) => section.key === "rule_breached");
		if (!breach) throw new Error("memo fixture changed");
		breach.claims[0]!.text = "The file notes PL-AMOUNT-RANGE for the record.";
		const result = validatePolicyMemoDraft(foreign, dtiContext(), sections, evidenceFor(sections));
		expect(result.ok).toBe(false);
		expect(result.issues).toContainEqual(expect.objectContaining({ code: "FOREIGN_RULE" }));
	});
});
