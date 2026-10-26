// E3 policy-exception orchestrator tests: no DB, no network. A scripted
// runner executes the REAL pure tools (registry + fixture policy client) so
// fakes stay faithful to production tool behavior.
import { describe, expect, it } from "vitest";
import {
	hashQuote,
	resolveExceptionPath,
	ruleDefinitionById,
	type EvidenceBundle,
	type EvidenceItem,
} from "@credit/core";
import {
	PolicyExceptionAgentError,
	policyExceptionReplayKey,
	runPolicyExceptionAgent,
	type PolicyExceptionAgentConfig,
} from "../../src/assist/policy-exception/agent.js";
import { runPolicyExceptionTool } from "../../src/assist/policy-exception/tools.js";
import type {
	CaseRuleContext,
	PolicyClient,
	PolicyExceptionAgentRunner,
	PolicyExceptionAgentRunResult,
	PolicySectionDelivery,
} from "../../src/assist/policy-exception/types.js";

const APP_ID = "55555555-5555-4555-8555-555555555555";
const EVAL_ID = "33333333-3333-4333-8333-333333333333";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const POLICY_ID = "11111111-1111-4111-8111-111111111111";
const APP_REF = "APP-2026-ABCDEF";

const BODY_91 =
	"Individual automatic-processing bands apply to amounts from S$1,000 to S$25,000 with assessment values recorded for the file.";
const QUOTE_A = "amounts from S$1,000 to S$25,000 with assessment values";
const BODY_12 =
	"Scores from 580 to 649 may proceed with a 25% exposure reduction and dual sign-off recorded for the file.";
const QUOTE_B = "may proceed with a 25% exposure reduction and dual sign-off";
const BODY_21 =
	"Total debt servicing ratio above 50% is reviewed, with a hard cap of 55% recorded for the file.";
const QUOTE_D = "is reviewed, with a hard cap of 55% recorded";
const BODY_53 =
	"Standard mitigants are a 50 basis point uplift with a 20% exposure reduction recorded for the file.";
const QUOTE_E = "a 50 basis point uplift with a 20% exposure reduction";
const BODY_51 =
	"Exceptions require dual sign-off with a regularisation plan of up to 12 months recorded for the file.";
const QUOTE_C = "require dual sign-off with a regularisation plan of up to 12 months";

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
		drawerToken: `drawer-token-${policyKey}-${sectionId}`,
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
	const items: EvidenceItem[] = sections.map((section) => ({
		ref: policyRef(section),
		sourceType: "policy_section",
		label: section.heading,
		content: section.body,
		access: { retentionUntil: null, legalHold: false },
		metadata: {},
	}));
	return {
		applicationId: APP_ID,
		asOf: "2026-06-30T00:00:00.000Z",
		assembledAt: "2026-06-30T01:00:00.000Z",
		items,
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
function dtiContext(over: Partial<CaseRuleContext> = {}): CaseRuleContext {
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
		...over,
	};
}

function fixturePolicyClient(sections: PolicySectionDelivery[]): PolicyClient {
	return {
		resolveSections: async () => ({ status: "ok", sections, missing: [] }),
		searchSections: async () => ({ status: "ok", sections, missing: [] }),
	};
}

function agentConfig(over: Partial<PolicyExceptionAgentConfig> = {}): PolicyExceptionAgentConfig {
	return {
		model: "test-model",
		agentVersion: "policy-exception-agent-v1",
		promptVersion: "policy-exception-v1",
		validatorVersion: "policy-exception-validator-v1",
		registryVersion: "policy-registry-v1",
		registryHash: "registry-hash",
		artifactType: "policy_exception_memo",
		maxSteps: 30,
		maxToolCalls: 30,
		timeoutMs: 45_000,
		maxCostUsd: 0.25,
		...over,
	};
}

function explainDraft(over: Record<string, unknown> = {}): string {
	return JSON.stringify({
		status: "succeeded",
		rules: [
			{
				ruleId: "PL-SCORE-REFER",
				segments: [
					{
						text: "The assessment value is recorded below the automatic band for PL-SCORE-REFER.",
						citationIndexes: [0],
					},
				],
				citations: [{ policyKey: "POL-CR-009", sectionId: "9.1", quote: QUOTE_A }],
				confidence: "medium",
			},
		],
		limitations: [],
		...over,
	});
}

function memoDraft(): string {
	return JSON.stringify({
		title: "Policy exception memo draft",
		sections: [
			{
				key: "rule_breached",
				title: "Rule breached",
				claims: [
					{
						text: "The servicing ratio is recorded above the automatic band for PL-DTI-HIGH.",
						citations: [{ ref: "REF_91", quote: QUOTE_A }],
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
						citations: [{ ref: "REF_21", quote: QUOTE_D }],
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
						citations: [{ ref: "REF_53", quote: QUOTE_E }],
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
						citations: [{ ref: "REF_51", quote: QUOTE_C }],
					},
				],
				notAvailable: false,
			},
		],
		openItems: [],
	});
}

interface ScriptStep {
	calls: Array<{ name: string; args: unknown }>;
	rawOutput: string;
	usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}

/** Scripted runner that executes the real tools against fixture state. */
function toolRunner(
	script: ScriptStep[],
	deps: {
		context: CaseRuleContext;
		catalog: PolicySectionDelivery[];
		evidence: EvidenceBundle;
		policyClient: PolicyClient;
	},
): { runner: PolicyExceptionAgentRunner; runCount: () => number } {
	const retrieved: PolicySectionDelivery[] = [];
	let index = 0;
	let runs = 0;
	return {
		runCount: () => runs,
		runner: {
			async run(input): Promise<PolicyExceptionAgentRunResult> {
				runs += 1;
				const step = script[Math.min(index, script.length - 1)];
				index += 1;
				if (!step) throw new Error("no scripted step");
				const toolCalls: PolicyExceptionAgentRunResult["toolCalls"] = [];
				const refs = new Set<string>();
				const fresh: PolicySectionDelivery[] = [];
				for (const call of step.calls) {
					const before = retrieved.length;
					const outcome = await runPolicyExceptionTool(
						{ actorId: "actor", actorRole: "officer", ...deps, retrieved },
						call.name,
						call.args,
					);
					for (const section of retrieved.slice(before)) fresh.push(section);
					toolCalls.push({
						step: toolCalls.length + 1,
						name: call.name,
						resultCount: outcome.resultCount,
						sourceTypes: outcome.sourceTypes,
					});
					for (const ref of outcome.refs) refs.add(ref);
				}
				return {
					rawOutput: step.rawOutput,
					toolCalls,
					sourceRefs: [...refs].sort(),
					policySections: fresh,
					steps: toolCalls.length + 1,
					usage: {
						inputTokens: step.usage?.inputTokens ?? 0,
						outputTokens: step.usage?.outputTokens ?? 0,
						costUsd: step.usage?.costUsd ?? 0,
					},
				};
			},
		},
	};
}

function fullExplainCalls(): ScriptStep["calls"] {
	return [
		{ name: "list_failed_rules", args: {} },
		{ name: "get_exception_path", args: { ruleId: "PL-SCORE-REFER" } },
		{ name: "search_policy", args: { ruleId: "PL-SCORE-REFER", focus: "exception" } },
		{ name: "get_policy_section", args: { policyKey: "POL-CR-009", sectionId: "9.1" } },
	];
}

function withRealRefs(draft: string, sections: PolicySectionDelivery[]): string {
	const [s91, s21, s53, s51] = sections;
	if (!s91 || !s21 || !s53 || !s51) throw new Error("catalog fixture changed");
	return draft
		.replaceAll("REF_91", policyRef(s91))
		.replaceAll("REF_21", policyRef(s21))
		.replaceAll("REF_53", policyRef(s53))
		.replaceAll("REF_51", policyRef(s51));
}

function fullMemoCalls(): ScriptStep["calls"] {
	return [
		{ name: "list_failed_rules", args: {} },
		{ name: "get_exception_path", args: { ruleId: "PL-DTI-HIGH" } },
		{ name: "search_policy", args: { ruleId: "PL-DTI-HIGH", focus: "exception" } },
		{ name: "get_policy_section", args: { policyKey: "POL-CR-009", sectionId: "9.1" } },
	];
}

describe("runPolicyExceptionAgent", () => {
	it("completes the explain happy path with metadata-only trace", async () => {
		const sections = catalog();
		const context = ruleContext();
		const evidence = evidenceFor(sections);
		const { runner } = toolRunner([{ calls: fullExplainCalls(), rawOutput: explainDraft() }], {
			context,
			catalog: sections,
			evidence,
			policyClient: fixturePolicyClient(sections),
		});
		const { content, trace } = await runPolicyExceptionAgent({
			mode: "explain",
			actorId: "test-officer",
			actorRole: "officer",
			context,
			evidence,
			catalog: sections,
			policyClient: fixturePolicyClient(sections),
			config: agentConfig(),
			runner,
		});
		expect((content as { rules: Array<{ ruleId: string }> }).rules[0]?.ruleId).toBe(
			"PL-SCORE-REFER",
		);
		expect(trace.writer).toBe("agent");
		expect(trace.registryVersion).toBe("policy-registry-v1");
		expect(trace.registryHash).toBe("registry-hash");
		expect(trace.validatorVersion).toBe("policy-exception-validator-v1");
		expect(trace.artifactType).toBe("policy_exception_memo");
		expect(trace.evidenceHash).toBe(
			policyExceptionReplayKey({ context, evidence, catalog: sections, config: agentConfig() }),
		);
		expect(trace.repairAttempted).toBe(false);
		expect(trace.repairSucceeded).toBeNull();
		expect(trace.toolCalls.length).toBeGreaterThan(0);
		expect(JSON.stringify(trace)).not.toContain(QUOTE_A);
		expect(JSON.stringify(trace)).not.toContain("drawer-token");
	});

	it("fills a missing decision-relevant rule with a deterministic explanation", async () => {
		const sections = catalog();
		const context = ruleContext();
		const evidence = evidenceFor(sections);
		const empty = JSON.stringify({ status: "succeeded", rules: [], limitations: [] });
		const { runner } = toolRunner([{ calls: fullExplainCalls(), rawOutput: empty }], {
			context,
			catalog: sections,
			evidence,
			policyClient: fixturePolicyClient(sections),
		});
		const { content } = await runPolicyExceptionAgent({
			mode: "explain",
			actorId: "test-officer",
			actorRole: "officer",
			context,
			evidence,
			catalog: sections,
			policyClient: fixturePolicyClient(sections),
			config: agentConfig(),
			runner,
		});
		expect(
			(content as { rules: Array<{ ruleId: string }> }).rules.map((rule) => rule.ruleId),
		).toContain("PL-SCORE-REFER");
	});

	it("fails INVALID_OUTPUT for a citation outside the case catalog", async () => {
		const sections = catalog();
		const context = ruleContext();
		const evidence = evidenceFor(sections);
		const draft = JSON.stringify({
			status: "succeeded",
			rules: [
				{
					ruleId: "PL-SCORE-REFER",
					segments: [
						{
							text: "The assessment value is recorded below the automatic band for PL-SCORE-REFER.",
							citationIndexes: [0],
						},
					],
					citations: [
						{
							policyKey: "POL-CR-005",
							sectionId: "5.2",
							quote: "a sufficiently long fabricated quote here",
						},
					],
					confidence: "medium",
				},
			],
			limitations: [],
		});
		const { runner } = toolRunner(
			[
				{ calls: fullExplainCalls(), rawOutput: draft },
				{ calls: fullExplainCalls(), rawOutput: draft },
			],
			{ context, catalog: sections, evidence, policyClient: fixturePolicyClient(sections) },
		);
		const error = await runPolicyExceptionAgent({
			mode: "explain",
			actorId: "test-officer",
			actorRole: "officer",
			context,
			evidence,
			catalog: sections,
			policyClient: fixturePolicyClient(sections),
			config: agentConfig(),
			runner,
		}).catch((err: unknown) => err);
		expect((error as PolicyExceptionAgentError).code).toBe("INVALID_OUTPUT");
		expect((error as PolicyExceptionAgentError).issues).toContainEqual(
			expect.objectContaining({ code: "CITATION_NOT_FROM_TOOL" }),
		);
	});

	it("fails INVALID_OUTPUT for short quotes, unmapped rules, decision language, foreign refs, and numeric mismatch", async () => {
		const sections = catalog();
		const context = ruleContext();
		const evidence = evidenceFor(sections);
		const segmentFor = (text: string, quote: string, ruleId = "PL-SCORE-REFER") =>
			JSON.stringify({
				status: "succeeded",
				rules: [
					{
						ruleId,
						segments: [{ text, citationIndexes: [0] }],
						citations: [{ policyKey: "POL-CR-009", sectionId: "9.1", quote }],
						confidence: "medium",
					},
				],
				limitations: [],
			});
		const cases: Array<[string, string]> = [
			[
				"short quote",
				segmentFor("The assessment value is recorded below the automatic band.", "too short"),
			],
			[
				"unmapped rule",
				segmentFor("The assessment value is recorded for PL-DTI-HIGH.", QUOTE_A, "PL-DTI-HIGH"),
			],
			[
				"decision language",
				segmentFor("The officer should approve the file for PL-SCORE-REFER.", QUOTE_A),
			],
			[
				"foreign app",
				segmentFor("The file APP-2025-ABCDEF is recorded for PL-SCORE-REFER.", QUOTE_A),
			],
			["numeric mismatch", segmentFor("A 55% charge is recorded for PL-SCORE-REFER.", QUOTE_A)],
		];
		for (const [label, draft] of cases) {
			const { runner } = toolRunner(
				[
					{ calls: fullExplainCalls(), rawOutput: draft },
					{ calls: fullExplainCalls(), rawOutput: draft },
				],
				{ context, catalog: sections, evidence, policyClient: fixturePolicyClient(sections) },
			);
			const error = await runPolicyExceptionAgent({
				mode: "explain",
				actorId: "test-officer",
				actorRole: "officer",
				context,
				evidence,
				catalog: sections,
				policyClient: fixturePolicyClient(sections),
				config: agentConfig(),
				runner,
			}).catch((err: unknown) => err);
			expect((error as PolicyExceptionAgentError).code, label).toBe("INVALID_OUTPUT");
			expect(JSON.stringify((error as PolicyExceptionAgentError).issues), label).not.toContain(
				QUOTE_A,
			);
		}
	});

	it("returns needs_policy_owner for a follow-up without explaining unmapped rules", async () => {
		const sections = catalog();
		const context = ruleContext({ unmappedRuleIds: ["PL-DTI-HIGH"] });
		const evidence = evidenceFor(sections);
		const draft = JSON.stringify({
			status: "needs_policy_owner",
			segments: [],
			citations: [],
			limitations: ["Policy owner review is required for the unmapped rule."],
		});
		const { runner } = toolRunner([{ calls: fullExplainCalls(), rawOutput: draft }], {
			context,
			catalog: sections,
			evidence,
			policyClient: fixturePolicyClient(sections),
		});
		const { content, trace } = await runPolicyExceptionAgent({
			mode: "followup",
			actorId: "test-officer",
			actorRole: "officer",
			context,
			evidence,
			catalog: sections,
			policyClient: fixturePolicyClient(sections),
			config: agentConfig(),
			runner,
			question: "What is the exception route?",
		});
		expect((content as { status: string }).status).toBe("needs_policy_owner");
		expect(trace.repairAttempted).toBe(false);
	});

	it("completes the memo happy path with a server-composed rules block", async () => {
		const sections = memoCatalog();
		const context = dtiContext();
		const evidence = evidenceFor(sections);
		const { runner } = toolRunner(
			[{ calls: fullMemoCalls(), rawOutput: withRealRefs(memoDraft(), sections) }],
			{ context, catalog: sections, evidence, policyClient: fixturePolicyClient(sections) },
		);
		const { content, trace } = await runPolicyExceptionAgent({
			mode: "memo",
			actorId: "test-officer",
			actorRole: "officer",
			context,
			evidence,
			catalog: sections,
			policyClient: fixturePolicyClient(sections),
			config: agentConfig(),
			runner,
		});
		const memo = content as unknown as {
			rules: Array<{ ruleId: string }>;
			regularisationPlanMonths: number | null;
		};
		expect(memo.rules.map((rule) => rule.ruleId)).toEqual(["PL-DTI-HIGH"]);
		expect(memo.regularisationPlanMonths).toBe(12);
		expect(trace.repairAttempted).toBe(false);
		expect(JSON.stringify(trace)).not.toContain(QUOTE_C);
	});

	it("fails INVALID_OUTPUT when a memo mitigation invents a value", async () => {
		const sections = memoCatalog();
		const context = dtiContext();
		const evidence = evidenceFor(sections);
		const parsed = JSON.parse(withRealRefs(memoDraft(), sections)) as {
			sections: Array<Record<string, unknown>>;
		};
		const mitigants = parsed.sections.find((section) => section["key"] === "mitigants");
		if (!mitigants) throw new Error("memo fixture changed");
		const claims = (mitigants["claims"] as Array<{ text: string; citations: unknown[] }>) ?? [];
		if (claims.length === 0) throw new Error("memo fixture has no mitigant claim");
		claims[0] = { ...claims[0], text: "A 60% exposure reduction applies." };
		mitigants["claims"] = claims;
		mitigants["notAvailable"] = false;
		const draft = JSON.stringify(parsed);
		const { runner } = toolRunner(
			[
				{ calls: fullMemoCalls(), rawOutput: draft },
				{ calls: fullMemoCalls(), rawOutput: draft },
			],
			{ context, catalog: sections, evidence, policyClient: fixturePolicyClient(sections) },
		);
		const error = await runPolicyExceptionAgent({
			mode: "memo",
			actorId: "test-officer",
			actorRole: "officer",
			context,
			evidence,
			catalog: sections,
			policyClient: fixturePolicyClient(sections),
			config: agentConfig(),
			runner,
		}).catch((err: unknown) => err);
		expect((error as PolicyExceptionAgentError).code).toBe("INVALID_OUTPUT");
		expect((error as PolicyExceptionAgentError).issues).toContainEqual(
			expect.objectContaining({ code: "NUMERIC_MISMATCH" }),
		);
	});

	it("repairs once after a validation failure, then fails when the repair is still invalid", async () => {
		const sections = catalog();
		const context = ruleContext();
		const evidence = evidenceFor(sections);
		const repaired = toolRunner(
			[
				{ calls: fullExplainCalls(), rawOutput: "not json" },
				{ calls: fullExplainCalls(), rawOutput: explainDraft() },
			],
			{ context, catalog: sections, evidence, policyClient: fixturePolicyClient(sections) },
		);
		const { trace } = await runPolicyExceptionAgent({
			mode: "explain",
			actorId: "test-officer",
			actorRole: "officer",
			context,
			evidence,
			catalog: sections,
			policyClient: fixturePolicyClient(sections),
			config: agentConfig(),
			runner: repaired.runner,
		});
		expect(trace.repairAttempted).toBe(true);
		expect(trace.repairSucceeded).toBe(true);

		const failing = toolRunner(
			[
				{ calls: fullExplainCalls(), rawOutput: "not json" },
				{ calls: fullExplainCalls(), rawOutput: "not json" },
			],
			{ context, catalog: sections, evidence, policyClient: fixturePolicyClient(sections) },
		);
		const error = await runPolicyExceptionAgent({
			mode: "explain",
			actorId: "test-officer",
			actorRole: "officer",
			context,
			evidence,
			catalog: sections,
			policyClient: fixturePolicyClient(sections),
			config: agentConfig(),
			runner: failing.runner,
		}).catch((err: unknown) => err);
		expect((error as PolicyExceptionAgentError).code).toBe("INVALID_OUTPUT");
	});

	it("fails TOOL_CALL_LIMIT, TIMEOUT, and BUDGET_EXCEEDED on bounds", async () => {
		const sections = catalog();
		const context = ruleContext();
		const evidence = evidenceFor(sections);
		const deps = {
			context,
			catalog: sections,
			evidence,
			policyClient: fixturePolicyClient(sections),
		};

		const budgeted = toolRunner([{ calls: fullExplainCalls(), rawOutput: explainDraft() }], deps);
		const budgetError = await runPolicyExceptionAgent({
			mode: "explain",
			actorId: "test-officer",
			actorRole: "officer",
			context,
			evidence,
			catalog: sections,
			policyClient: fixturePolicyClient(sections),
			config: agentConfig({ maxToolCalls: 1 }),
			runner: budgeted.runner,
		}).catch((err: unknown) => err);
		expect((budgetError as PolicyExceptionAgentError).code).toBe("TOOL_CALL_LIMIT");

		const timed = toolRunner([{ calls: fullExplainCalls(), rawOutput: explainDraft() }], deps);
		const timeoutError = await runPolicyExceptionAgent({
			mode: "explain",
			actorId: "test-officer",
			actorRole: "officer",
			context,
			evidence,
			catalog: sections,
			policyClient: fixturePolicyClient(sections),
			config: agentConfig({ timeoutMs: 0 }),
			runner: timed.runner,
		}).catch((err: unknown) => err);
		expect((timeoutError as PolicyExceptionAgentError).code).toBe("TIMEOUT");
		expect(timed.runCount()).toBe(0);

		const costly = toolRunner(
			[{ calls: fullExplainCalls(), rawOutput: explainDraft(), usage: { costUsd: 1 } }],
			deps,
		);
		const costError = await runPolicyExceptionAgent({
			mode: "explain",
			actorId: "test-officer",
			actorRole: "officer",
			context,
			evidence,
			catalog: sections,
			policyClient: fixturePolicyClient(sections),
			config: agentConfig({ maxCostUsd: 0.25 }),
			runner: costly.runner,
		}).catch((err: unknown) => err);
		expect((costError as PolicyExceptionAgentError).code).toBe("BUDGET_EXCEEDED");
	});

	it("computes a stable replay key that excludes drawer tokens", () => {
		const sections = catalog();
		const context = ruleContext();
		const evidence = evidenceFor(sections);
		const config = agentConfig();
		const first = policyExceptionReplayKey({ context, evidence, catalog: sections, config });
		const redacted = sections.map((section) => ({
			...section,
			drawerToken: "redacted",
			body: "changed",
		}));
		const second = policyExceptionReplayKey({ context, evidence, catalog: redacted, config });
		expect(first).toBe(second);
		expect(first).toBe(
			policyExceptionReplayKey({ context, evidence, catalog: sections, config: { ...config } }),
		);
	});

	it("runs the pure tools without throwing on unknown names and bad args", async () => {
		const sections = catalog();
		const context = ruleContext();
		const deps = {
			context,
			catalog: sections,
			evidence: evidenceFor(sections),
			policyClient: fixturePolicyClient(sections),
			actorId: "actor",
			actorRole: "officer",
		};
		for (const [name, args] of [
			["nope", {}],
			["search_policy", { ruleId: "NOPE", focus: "exception" }],
			["get_policy_section", { policyKey: "POL-CR-009", sectionId: "9.9" }],
			["search_policy", {}],
		] as const) {
			const outcome = await runPolicyExceptionTool(deps, name, args);
			expect(outcome.payload).toMatchObject({ error: expect.any(String) });
			expect(outcome.resultCount).toBe(0);
		}
		const first = await runPolicyExceptionTool(deps, "search_policy", {
			ruleId: "PL-SCORE-REFER",
			focus: "exception",
		});
		const second = await runPolicyExceptionTool(deps, "search_policy", {
			ruleId: "PL-SCORE-REFER",
			focus: "exception",
		});
		expect((first.payload as { query: string }).query).toBe(
			(second.payload as { query: string }).query,
		);
		expect(first.policySections.length).toBeGreaterThan(0);
	});
});
