// Pure E3 view tests: context mapping, catalog refs, evidence ref formats,
// replay-key stability (drawer tokens excluded), and source-unavailable.
import { describe, expect, it } from "vitest";
import { hashQuote, parseSourceRef, resolveExceptionPath, ruleDefinitionById } from "@credit/core";
import { policyExceptionReplayKey } from "../../src/assist/policy-exception/agent.js";
import {
	policyCatalogRefs,
	policySectionRefFor,
	resolvePolicyCatalog,
	ruleFailureRef,
	toSharedCaseRuleContext,
} from "../../src/assist/policy-exception/view.js";
import { PolicySourceError } from "../../src/assist/policy-exception/types.js";
import type { CaseRuleContext as SharedContext } from "../../src/assist/policy-exception/types.js";

const APP_ID = "55555555-5555-4555-8555-555555555555";
const EVAL_ID = "33333333-3333-4333-8333-333333333333";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const POLICY_ID = "11111111-1111-4111-8111-111111111111";

function deterministic(
	over: Record<string, unknown> = {},
): Parameters<typeof toSharedCaseRuleContext>[0] {
	const definition = ruleDefinitionById("PL-SCORE-REFER");
	if (!definition) throw new Error("registry missing");
	return {
		applicationId: APP_ID,
		caseStatus: "pending_review",
		status: "ok",
		policyVersion: "policy-v1.0",
		policyAsOf: "2026-06-30",
		registryVersion: "policy-registry-v1",
		score: 620,
		grade: "C",
		scorecardVersion: "scorecard-v1",
		outcome: "refer",
		product: "personal_loan",
		reasonCodes: ["SCORE_IN_REFER_BAND"],
		secured: false,
		securedQualifying: false,
		failedRuleCount: 0,
		failedRules: [
			{
				ruleId: "PL-SCORE-REFER",
				reasonCode: "SCORE_IN_REFER_BAND",
				effect: "refer",
				product: "personal_loan",
				persisted: true,
				evaluated: true,
				decisionRelevant: true,
				observed: "620",
				observedValue: 620,
				threshold: definition.threshold.display,
				scoreBand: "C",
				ruleSectionRefs: definition.ruleSectionRefs,
				exception: resolveExceptionPath({
					definition,
					observedValue: 620,
					amountCents: 6_000_000,
					failedRuleCount: 0,
					securedQualifying: false,
				}),
				mappingState: "mapped",
				explanationLimitation: null,
			},
		],
		limitations: [],
		evaluationId: EVAL_ID,
		decisionId: null,
		...over,
	} as unknown as Parameters<typeof toSharedCaseRuleContext>[0];
}

function kase(over: Record<string, unknown> = {}) {
	return {
		application: {
			id: APP_ID,
			reference: "APP-2026-ABCDEF",
			product: "personal_loan",
			amountCents: 6_000_000,
		},
		assignedToMe: true,
		...over,
	} as unknown as Parameters<typeof toSharedCaseRuleContext>[1];
}

function delivery(
	policyKey: string,
	sectionId: string,
	body: string,
	drawerToken = "token",
): {
	policyId: string;
	policyVersionId: string;
	policyKey: string;
	sectionId: string;
	version: string;
	heading: string;
	body: string;
	truncated: boolean;
	effectiveFrom: string;
	effectiveTo: null;
	contentHash: string;
	quoteHash: string;
	drawerToken: string;
} {
	return {
		policyId: POLICY_ID,
		policyVersionId: VERSION_ID,
		policyKey,
		sectionId,
		version: "v1",
		heading: `${policyKey} ${sectionId}`,
		body,
		truncated: false,
		effectiveFrom: "2026-01-01",
		effectiveTo: null,
		contentHash: "0123456789abcdef0123456789abcdef",
		quoteHash: hashQuote(body),
		drawerToken,
	};
}

const agentConfig = {
	model: "test-model",
	agentVersion: "policy-exception-agent-v1",
	promptVersion: "policy-exception-v1",
	validatorVersion: "policy-exception-validator-v1",
	registryVersion: "policy-registry-v1",
	registryHash: "registry-hash",
	artifactType: "policy_exception_memo",
	maxSteps: 20,
	maxToolCalls: 12,
	timeoutMs: 45_000,
	maxCostUsd: 0.25,
};

function shared(): SharedContext {
	return toSharedCaseRuleContext(deterministic(), kase());
}

describe("toSharedCaseRuleContext", () => {
	it("maps product, amount, reference, score band, and unmapped arrays", () => {
		const context = toSharedCaseRuleContext(deterministic(), kase());
		expect(context.applicationReference).toBe("APP-2026-ABCDEF");
		expect(context.product).toBe("personal_loan");
		expect(context.applicationKind).toBe("individual");
		expect(context.amountCents).toBe(6_000_000);
		expect(context.scoreBand).toBe("C");
		expect(context.scorecardVersion).toBe("scorecard-v1");
		expect(context.unmappedRuleIds).toEqual([]);
		expect(context.failedRules[0]?.ruleSectionRefs.length).toBeGreaterThan(0);
	});

	it("normalizes decided approved/declined and check-only outcomes", () => {
		const approvedRefer = toSharedCaseRuleContext(
			deterministic({ decisionId: "d1", outcome: "approved", reasonCodes: ["X"] }),
			kase(),
		);
		expect(approvedRefer.outcome).toBe("refer");
		const approvedAuto = toSharedCaseRuleContext(
			deterministic({ decisionId: "d1", outcome: "approved", reasonCodes: [] }),
			kase(),
		);
		expect(approvedAuto.outcome).toBe("auto_approve");
		const declined = toSharedCaseRuleContext(
			deterministic({ decisionId: "d1", outcome: "declined" }),
			kase(),
		);
		expect(declined.outcome).toBe("decline");
		const checkOnly = toSharedCaseRuleContext(
			deterministic({ status: "not_applicable", failedRules: [], reasonCodes: [] }),
			kase(),
		);
		expect(checkOnly.outcome).toBe("not_applicable");
	});

	it("collects unmapped rule ids from mapping_unavailable failures", () => {
		const context = toSharedCaseRuleContext(
			deterministic({
				status: "mapping_unavailable",
				failedRules: [
					{
						...deterministic().failedRules[0],
						mappingState: "mapping_unavailable",
						exception: {
							...deterministic().failedRules[0]!.exception,
							state: "mapping_unavailable",
							approver: null,
						},
					},
				],
			}),
			kase(),
		);
		expect(context.unmappedRuleIds).toEqual(["PL-SCORE-REFER"]);
		expect(context.unmappedExceptionRuleIds).toEqual(["PL-SCORE-REFER"]);
	});
});

describe("catalog refs", () => {
	it("dedupes rule and exception refs", () => {
		const context = shared();
		const refs = policyCatalogRefs(context);
		const keys = refs.map((ref) => `${ref.policyKey}#${ref.sectionId}`);
		expect(new Set(keys).size).toBe(keys.length);
		expect(keys).toContain("POL-CR-009#9.1");
	});
});

describe("evidence refs", () => {
	it("namespaces rule failures as RULE_<CODE> and parses as score_reason", () => {
		const ref = ruleFailureRef(EVAL_ID, "SCORE_IN_REFER_BAND");
		expect(ref).toBe(`score_reason:${EVAL_ID}:RULE_SCORE_IN_REFER_BAND`);
		expect(parseSourceRef(ref)?.type).toBe("score_reason");
	});

	it("builds stable policy refs keyed by ids and quote hash", () => {
		const section = delivery("POL-CR-009", "9.1", "Individual bands apply to the file for review.");
		const ref = policySectionRefFor(section);
		expect(ref).toBe(`policy_section:POL-CR-009:${VERSION_ID}:9.1:${hashQuote(section.body)}`);
		expect(parseSourceRef(ref)?.type).toBe("policy_section");
	});
});

describe("replay key", () => {
	it("excludes drawer tokens but covers catalog refs", () => {
		const context = shared();
		const evidence = {
			applicationId: APP_ID,
			asOf: "2026-06-30T00:00:00.000Z",
			assembledAt: "2026-06-30T01:00:00.000Z",
			items: [],
			unavailable: [],
		};
		const a = [
			delivery("POL-CR-009", "9.1", "Individual bands apply to the file for review.", "token-a"),
		];
		const b = [
			delivery("POL-CR-009", "9.1", "Individual bands apply to the file for review.", "token-b"),
		];
		expect(policyExceptionReplayKey({ context, evidence, catalog: a, config: agentConfig })).toBe(
			policyExceptionReplayKey({ context, evidence, catalog: b, config: agentConfig }),
		);
		const c = [
			...a,
			delivery("POL-CR-001", "1.2", "A different section body for the file review.", "token-a"),
		];
		expect(
			policyExceptionReplayKey({ context, evidence, catalog: c, config: agentConfig }),
		).not.toBe(policyExceptionReplayKey({ context, evidence, catalog: a, config: agentConfig }));
	});
});

describe("source status", () => {
	it("returns unavailable without a client and partial on missing refs", async () => {
		const context = shared();
		const actor = {
			id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
			email: "officer@example.com",
			role: "officer" as const,
		};
		const withoutClient = await resolvePolicyCatalog({ context, actor });
		expect(withoutClient).toEqual({ sections: [], sourceStatus: "unavailable" });

		const down = {
			resolveSections: async () => {
				throw new PolicySourceError("POLICY_SOURCE_UNAVAILABLE");
			},
			searchSections: async () => {
				throw new PolicySourceError("POLICY_SOURCE_UNAVAILABLE");
			},
		};
		const unavailable = await resolvePolicyCatalog({ policyClient: down, context, actor });
		expect(unavailable.sourceStatus).toBe("unavailable");
		expect(unavailable.sections).toEqual([]);

		const section = delivery("POL-CR-009", "9.1", "Individual bands apply to the file for review.");
		const partialClient = {
			resolveSections: async () => ({
				status: "partial" as const,
				sections: [section],
				missing: [{ policyKey: "POL-CR-001", sectionId: "1.2", reason: "not_found" as const }],
			}),
			searchSections: async () => ({ status: "ok" as const, sections: [], missing: [] }),
		};
		const partial = await resolvePolicyCatalog({ policyClient: partialClient, context, actor });
		expect(partial.sourceStatus).toBe("partial");
		expect(partial.sections).toHaveLength(1);
	});
});
