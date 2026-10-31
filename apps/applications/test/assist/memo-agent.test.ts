// runMemoAgent unit tests: no DB, no network. A scripted fake
// MemoAgentRunner drives the orchestrator; evidence fixtures are built from
// EvidenceItem directly.
import { describe, expect, it } from "vitest";
import {
	hashQuote,
	sourceRefKey,
	validateGeneratedText,
	type EvidenceBundle,
	type EvidenceItem,
} from "@credit/core";
import type { applications } from "@credit/db/applications";
import {
	MemoAgentError,
	runMemoAgent,
	type MemoAgentConfig,
	type MemoAgentRunResult,
	type MemoAgentRunner,
	MEMO_TOOL_NAMES,
} from "../../src/agents/memo-writer/index.js";
import { evidenceHash } from "../../src/agents/shared/trace.js";

type ApplicationRow = typeof applications.$inferSelect;

const APP_ID = "55555555-5555-4555-8555-555555555555";
const SCORE_ID = "33333333-3333-4333-8333-333333333333";
const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const EXTERNAL_ID = "44444444-4444-4444-8444-444444444444";
const POLICY_QUOTE = "Coverage must stay above 1.25x for the facility under review.";
const POLICY_REF = sourceRefKey({
	type: "policy_section",
	policyKey: "POL-CR-002",
	policyVersionId: VERSION_ID,
	sectionId: "4.2",
	quoteHash: hashQuote(POLICY_QUOTE),
});
const MISSING_DOC_REF = `document:${DOCUMENT_ID}:p9:0-5`;
const AMOUNT_REF = `case_fact:${APP_ID}:amountCents`;
const TERM_REF = `case_fact:${APP_ID}:termMonths`;
const PRODUCT_REF = `case_fact:${APP_ID}:product`;
const INDUSTRY_REF = `case_fact:${APP_ID}:industry`;
const COMPANY_REF = `case_fact:${APP_ID}:companyName`;
const REVENUE_REF = `case_fact:${APP_ID}:business.annualRevenueCents`;
const FACTOR_REF = `score_reason:${SCORE_ID}:BANK_RELATIONSHIP`;
const FACTOR_CONTENT = "BANK_RELATIONSHIP +40";

const ALL_TYPES = [
	"case_fact",
	"score_reason",
	"document",
	"context_signal",
	"external_evidence",
	"policy_section",
];

const ALL_CITED_REFS = [
	AMOUNT_REF,
	TERM_REF,
	PRODUCT_REF,
	INDUSTRY_REF,
	COMPANY_REF,
	REVENUE_REF,
	FACTOR_REF,
	POLICY_REF,
];

function fact(field: string, content: string): EvidenceItem {
	return {
		ref: `case_fact:${APP_ID}:${field}`,
		sourceType: "case_fact",
		label: field,
		content,
		access: { retentionUntil: null, legalHold: false },
		metadata: { field },
	};
}

function item(
	ref: string,
	sourceType: EvidenceItem["sourceType"],
	label: string,
	content: string,
	metadata: Record<string, string | number | boolean | null> = {},
): EvidenceItem {
	return {
		ref,
		sourceType,
		label,
		content,
		access: { retentionUntil: null, legalHold: false },
		metadata,
	};
}

function smeApp(): ApplicationRow {
	return {
		id: APP_ID,
		reference: "APP-2026-0001",
		applicantUserId: "99999999-9999-4999-8999-999999999999",
		type: "sme",
		product: "sme_term_loan",
		status: "pending_review",
		amountCents: 6000000,
		termMonths: 60,
		purpose: "Working capital",
		identity: { fullName: "Owner Name", city: "Singapore" },
		financial: null,
		business: {
			companyName: "Cafe Aurora",
			industry: "hospitality",
			yearsTrading: 4,
			annualRevenueCents: 120000000,
			monthlyFcfCents: 8000000,
			existingDebtServiceCents: 1500000,
		},
		consents: [true, true, true],
		aiResearchConsent: false,
		documentProcessingConsent: false,
		documentConsentAt: null,
		documentConsentVersion: null,
		source: "live",
		fixtureKey: null,
		contextAnalysisConsent: false,
		contextConsentAt: null,
		contextConsentVersion: null,
		submittedAt: new Date("2026-06-30T00:00:00.000Z"),
		workflowStartedAt: null,
		decidedAt: null,
		failedReason: null,
		createdAt: new Date("2026-06-30T00:00:00.000Z"),
		updatedAt: new Date("2026-06-30T00:00:00.000Z"),
	};
}

function bundle(): EvidenceBundle {
	return {
		applicationId: APP_ID,
		asOf: "2026-06-30T00:00:00.000Z",
		assembledAt: "2026-06-30T01:00:00.000Z",
		items: [
			fact("amountCents", "6000000"),
			fact("termMonths", "60"),
			fact("product", "sme_term_loan"),
			fact("companyName", "Cafe Aurora"),
			fact("industry", "hospitality"),
			fact("yearsTrading", "4"),
			fact("city", "Singapore"),
			fact("business.annualRevenueCents", "120000000"),
			item(FACTOR_REF, "score_reason", "factor", FACTOR_CONTENT, {
				kind: "factor",
				impact: "positive",
				label: "Bank relationship",
			}),
			item(`document:${DOCUMENT_ID}:p1:0-16`, "document", "document", "Cafe Aurora Pte Ltd", {
				field: "company_name",
				status: "match",
			}),
			item(
				`context_signal:signal:negative_balance:days:2026-01-01:2026-06-30:all`,
				"context_signal",
				"signal",
				"observed=2 status=review confidence=high",
				{},
			),
			item(
				`external_evidence:${EXTERNAL_ID}`,
				"external_evidence",
				"report",
				"Bureau file on file for review.",
				{},
			),
			item(POLICY_REF, "policy_section", "policy", POLICY_QUOTE, {}),
		],
		unavailable: [{ ref: MISSING_DOC_REF, sourceType: "document", code: "missing" }],
	};
}

function agentConfig(over: Partial<MemoAgentConfig> = {}): MemoAgentConfig {
	return {
		model: "test-model",
		promptVersion: "memo-agent-v1",
		agentVersion: "memo-agent-v1",
		maxSteps: 8,
		maxToolCalls: 12,
		timeoutMs: 45_000,
		maxCostUsd: 0.25,
		...over,
	};
}

function section(
	key: string,
	title: string,
	claims: Array<{ text: string; citations: Array<{ ref: string; quote: string }> }>,
) {
	return claims.length > 0
		? { key, title, claims, notAvailable: false }
		: { key, title, claims: [], notAvailable: true };
}

/** Prose mirrors the deterministic builder's neutral wording so it passes
 * the EN-03 scans (no decision language, PII, or proxy terms). */
function validMemo(): Record<string, unknown> {
	return {
		title: "Credit memorandum draft — APP-2026-0001",
		sections: [
			section("request", "Request", [
				{
					text: "The request is for USD 60,000.00 over 60 months under the SME lending product.",
					citations: [
						{ ref: AMOUNT_REF, quote: "6000000" },
						{ ref: TERM_REF, quote: "60" },
						{ ref: PRODUCT_REF, quote: "sme_term_loan" },
					],
				},
			]),
			section("entity", "Entity", [
				{
					text: "The applicant company operates in the sector stated in the case record.",
					citations: [
						{ ref: INDUSTRY_REF, quote: "hospitality" },
						{ ref: COMPANY_REF, quote: "Cafe Aurora" },
					],
				},
			]),
			section("financial_summary", "Financial summary", [
				{
					text: "Annual revenue is USD 1,200,000.00 for the stated period.",
					citations: [{ ref: REVENUE_REF, quote: "120000000" }],
				},
			]),
			section("strengths", "Strengths", [
				{
					text: "A positive assessment factor is noted for the case.",
					citations: [{ ref: FACTOR_REF, quote: FACTOR_CONTENT }],
				},
			]),
			section("risks", "Risks", [
				{
					text: "A policy section is cited for this case.",
					citations: [{ ref: POLICY_REF, quote: POLICY_QUOTE }],
				},
			]),
			section("policy_compliance", "Policy compliance", [
				{
					text: "The cited policy section is recorded for officer awareness.",
					citations: [{ ref: POLICY_REF, quote: POLICY_QUOTE }],
				},
			]),
		],
		openItems: [
			{
				text: "A document source is unavailable; follow-up is needed to complete the record.",
				code: "missing_document",
				sourceRef: MISSING_DOC_REF,
			},
		],
		officerQuestions: [
			"What is the current status of the requested documents?",
			"Are the latest financial statements available for review?",
		],
	};
}

function invalidMemo(): Record<string, unknown> {
	const memo = validMemo();
	const strengths = (memo["sections"] as Array<Record<string, unknown>>)[3];
	strengths["claims"] = [{ text: "An uncited observation about the case.", citations: [] }];
	return memo;
}

interface ScriptedRun {
	rawOutput?: string;
	tools?: Array<{ name: string; resultCount: number; sourceTypes: string[] }>;
	sourceRefs?: string[];
	steps?: number;
	usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
	error?: Error;
}

type RunnerInput = Parameters<MemoAgentRunner["run"]>[0];

/** Scripted runner: each `run` call consumes the next scripted result and
 * records its input (so tests can assert on the repair payload). */
function scriptedRunner(script: ScriptedRun[]): {
	runner: MemoAgentRunner;
	inputs: RunnerInput[];
	runCount: () => number;
} {
	const inputs: RunnerInput[] = [];
	let index = 0;
	return {
		inputs,
		runCount: () => inputs.length,
		runner: {
			async run(runInput: RunnerInput): Promise<MemoAgentRunResult> {
				inputs.push(runInput);
				const step = script[Math.min(index, script.length - 1)];
				index += 1;
				if (!step) throw new MemoAgentError("MODEL_ERROR");
				if (step.error) throw step.error;
				const tools = step.tools ?? [];
				return {
					rawOutput: step.rawOutput ?? "",
					toolCalls: tools.map((call, callIndex) => ({
						step: callIndex + 1,
						name: call.name,
						resultCount: call.resultCount,
						sourceTypes: call.sourceTypes,
					})),
					sourceRefs: step.sourceRefs ?? [],
					steps: step.steps ?? tools.length + 1,
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

function listAll(resultCount = 13): NonNullable<ScriptedRun["tools"]> {
	return [{ name: "list_evidence", resultCount, sourceTypes: ALL_TYPES }];
}

describe("runMemoAgent", () => {
	it("completes the happy path with tool calls and a metadata-only trace", async () => {
		const evidence = bundle();
		const { runner, inputs } = scriptedRunner([
			{
				rawOutput: JSON.stringify(validMemo()),
				tools: listAll(),
				sourceRefs: ALL_CITED_REFS,
				steps: 2,
				usage: { inputTokens: 60, outputTokens: 80 },
			},
		]);
		const { content, trace } = await runMemoAgent({
			application: smeApp(),
			evidence,
			runner,
			config: agentConfig(),
		});

		expect(validateGeneratedText({ artifactType: "credit_memo", content, evidence }).ok).toBe(true);
		expect(content.sections.map((s) => s.key)).toEqual([
			"request",
			"entity",
			"financial_summary",
			"strengths",
			"risks",
			"policy_compliance",
		]);
		expect(inputs).toHaveLength(1);
		expect(inputs[0]?.repair).toBeUndefined();
		expect(trace.writer).toBe("agent");
		expect(trace.agentVersion).toBe("memo-agent-v1");
		expect(trace.model).toBe("test-model");
		expect(trace.promptVersion).toBe("memo-agent-v1");
		expect(trace.evidenceHash).toBe(evidenceHash(evidence));
		expect(trace.evidenceHash).toBe(
			evidenceHash({ ...evidence, assembledAt: "2026-07-01T00:00:00.000Z" }),
		);
		expect(trace.steps).toBe(2);
		expect(trace.toolCalls).toHaveLength(1);
		expect(trace.toolCalls[0]).toMatchObject({ step: 1, name: "list_evidence" });
		expect(trace.toolCalls[0]?.resultCount).toBeGreaterThan(0);
		expect(trace.sourceRefs).toContain(AMOUNT_REF);
		expect(trace.sourceRefs).toContain(POLICY_REF);
		expect(trace.repairAttempted).toBe(false);
		expect(trace.repairSucceeded).toBeNull();
		expect(trace.fallbackReason).toBeNull();
		expect(trace.inputTokens).toBe(60);
		expect(trace.outputTokens).toBe(80);
		expect(trace.latencyMs).toBeGreaterThanOrEqual(0);
		expect(JSON.stringify(trace)).not.toContain(POLICY_QUOTE);
	});

	it("repairs once when the first draft uses no tools", async () => {
		const evidence = bundle();
		const { runner, inputs } = scriptedRunner([
			{ rawOutput: JSON.stringify(validMemo()), steps: 1 },
			{
				rawOutput: JSON.stringify(validMemo()),
				tools: listAll(),
				sourceRefs: ALL_CITED_REFS,
				steps: 2,
			},
		]);
		const { trace } = await runMemoAgent({
			application: smeApp(),
			evidence,
			runner,
			config: agentConfig(),
		});
		expect(inputs).toHaveLength(2);
		expect(inputs[1]?.repair).toMatchObject({
			previousOutput: JSON.stringify(validMemo()),
			issues: [{ code: "NO_TOOL_USE", path: "_" }],
			requireTools: true,
		});
		expect(trace.steps).toBe(3);
		expect(trace.toolCalls).toHaveLength(1);
		expect(trace.toolCalls[0]).toMatchObject({ name: "list_evidence" });
		expect(trace.toolCalls[0]?.resultCount).toBeGreaterThan(0);
		expect(trace.repairAttempted).toBe(true);
		expect(trace.repairSucceeded).toBe(true);
	});

	it("fails with NO_TOOL_USE when the repair still uses no tools", async () => {
		const { runner, inputs } = scriptedRunner([
			{ rawOutput: JSON.stringify(validMemo()), steps: 1 },
		]);
		const error = await runMemoAgent({
			application: smeApp(),
			evidence: bundle(),
			runner,
			config: agentConfig(),
		}).catch((err: unknown) => err);
		expect(error).toBeInstanceOf(MemoAgentError);
		expect((error as MemoAgentError).code).toBe("NO_TOOL_USE");
		expect(inputs).toHaveLength(2);
		expect(inputs[1]?.repair?.requireTools).toBe(true);
	});

	it("repairs once on validation failure with codes/paths only", async () => {
		const evidence = bundle();
		const { runner, inputs } = scriptedRunner([
			{
				rawOutput: JSON.stringify(invalidMemo()),
				tools: listAll(),
				sourceRefs: ALL_CITED_REFS,
				steps: 2,
			},
			{ rawOutput: JSON.stringify(validMemo()), steps: 1 },
		]);
		const { trace } = await runMemoAgent({
			application: smeApp(),
			evidence,
			runner,
			config: agentConfig(),
		});
		expect(trace.repairAttempted).toBe(true);
		expect(trace.repairSucceeded).toBe(true);
		const repair = inputs[1]?.repair;
		expect(repair?.previousOutput).toBe(JSON.stringify(invalidMemo()));
		expect(repair?.requireTools).toBe(false);
		expect(repair?.issues).toContainEqual(
			expect.objectContaining({ code: "UNSUPPORTED_CLAIM", path: "sections.3.claims.0" }),
		);
		expect(JSON.stringify(repair?.issues)).not.toContain(POLICY_QUOTE);
	});

	it("fails with INVALID_OUTPUT when the repair is still invalid", async () => {
		const { runner } = scriptedRunner([
			{
				rawOutput: JSON.stringify(invalidMemo()),
				tools: listAll(),
				sourceRefs: ALL_CITED_REFS,
				steps: 2,
			},
			{ rawOutput: "not json at all", steps: 1 },
		]);
		const error = await runMemoAgent({
			application: smeApp(),
			evidence: bundle(),
			runner,
			config: agentConfig(),
		}).catch((err: unknown) => err);
		expect(error).toBeInstanceOf(MemoAgentError);
		expect((error as MemoAgentError).code).toBe("INVALID_OUTPUT");
		expect((error as MemoAgentError).issues.length).toBeGreaterThan(0);
		expect(JSON.stringify((error as MemoAgentError).issues)).not.toContain(POLICY_QUOTE);
	});

	it("fails with STEP_LIMIT when the run exceeds the step budget", async () => {
		const { runner, runCount } = scriptedRunner([
			{
				rawOutput: JSON.stringify(validMemo()),
				tools: listAll(),
				sourceRefs: ALL_CITED_REFS,
				steps: 5,
			},
		]);
		const error = await runMemoAgent({
			application: smeApp(),
			evidence: bundle(),
			runner,
			config: agentConfig({ maxSteps: 2 }),
		}).catch((err: unknown) => err);
		expect(error).toBeInstanceOf(MemoAgentError);
		expect((error as MemoAgentError).code).toBe("STEP_LIMIT");
		expect(runCount()).toBe(1);
	});

	it("fails with TOOL_CALL_LIMIT when the run exceeds the tool budget", async () => {
		const { runner } = scriptedRunner([
			{
				rawOutput: JSON.stringify(validMemo()),
				tools: [
					{ name: "list_evidence", resultCount: 13, sourceTypes: ALL_TYPES },
					{ name: "search_evidence", resultCount: 2, sourceTypes: ["case_fact"] },
					{ name: "get_evidence", resultCount: 1, sourceTypes: ["case_fact"] },
				],
				sourceRefs: ALL_CITED_REFS,
				steps: 4,
			},
		]);
		const error = await runMemoAgent({
			application: smeApp(),
			evidence: bundle(),
			runner,
			config: agentConfig({ maxToolCalls: 2 }),
		}).catch((err: unknown) => err);
		expect(error).toBeInstanceOf(MemoAgentError);
		expect((error as MemoAgentError).code).toBe("TOOL_CALL_LIMIT");
	});

	it("fails with TIMEOUT when the wall-clock budget is spent", async () => {
		const { runner, runCount } = scriptedRunner([
			{
				rawOutput: JSON.stringify(validMemo()),
				tools: listAll(),
				sourceRefs: ALL_CITED_REFS,
			},
		]);
		const error = await runMemoAgent({
			application: smeApp(),
			evidence: bundle(),
			runner,
			config: agentConfig({ timeoutMs: 0 }),
		}).catch((err: unknown) => err);
		expect(error).toBeInstanceOf(MemoAgentError);
		expect((error as MemoAgentError).code).toBe("TIMEOUT");
		expect(runCount()).toBe(0);
	});

	it("fails with BUDGET_EXCEEDED when accumulated cost passes the cap", async () => {
		const { runner } = scriptedRunner([
			{
				rawOutput: JSON.stringify(validMemo()),
				tools: listAll(),
				sourceRefs: ALL_CITED_REFS,
				usage: { inputTokens: 100, outputTokens: 100, costUsd: 1 },
			},
		]);
		const error = await runMemoAgent({
			application: smeApp(),
			evidence: bundle(),
			runner,
			config: agentConfig({ maxCostUsd: 0.25 }),
		}).catch((err: unknown) => err);
		expect(error).toBeInstanceOf(MemoAgentError);
		expect((error as MemoAgentError).code).toBe("BUDGET_EXCEEDED");
	});

	it("propagates runner MemoAgentErrors and maps unknown throws to MODEL_ERROR", async () => {
		for (const [thrown, code] of [
			[new MemoAgentError("TIMEOUT"), "TIMEOUT"],
			[new MemoAgentError("MODEL_ERROR"), "MODEL_ERROR"],
			[new MemoAgentError("STEP_LIMIT"), "STEP_LIMIT"],
			[new Error("socket hang up"), "MODEL_ERROR"],
		] as const) {
			const { runner } = scriptedRunner([{ error: thrown }]);
			const error = await runMemoAgent({
				application: smeApp(),
				evidence: bundle(),
				runner,
				config: agentConfig(),
			}).catch((err: unknown) => err);
			expect((error as MemoAgentError).code, thrown.message).toBe(code);
		}
	});

	it("aborts with TIMEOUT when the signal is already aborted", async () => {
		const { runner, runCount } = scriptedRunner([
			{
				rawOutput: JSON.stringify(validMemo()),
				tools: listAll(),
				sourceRefs: ALL_CITED_REFS,
			},
		]);
		const controller = new AbortController();
		controller.abort();
		const error = await runMemoAgent({
			application: smeApp(),
			evidence: bundle(),
			runner,
			config: agentConfig(),
			signal: controller.signal,
		}).catch((err: unknown) => err);
		expect((error as MemoAgentError).code).toBe("TIMEOUT");
		expect(runCount()).toBe(0);
	});

	it("exposes exactly the four allowlisted tools", () => {
		expect([...MEMO_TOOL_NAMES]).toEqual([
			"list_evidence",
			"search_evidence",
			"get_evidence",
			"list_unavailable",
		]);
	});

	// Tool-grounded citations + category coverage. The tiny bundle is
	// case_fact-only so coverage passes unless the test adds a second type.
	function tinyBundle(): EvidenceBundle {
		return {
			applicationId: APP_ID,
			asOf: "2026-06-30T00:00:00.000Z",
			assembledAt: "2026-06-30T01:00:00.000Z",
			items: [
				fact("amountCents", "6000000"),
				fact("termMonths", "60"),
				fact("product", "sme_term_loan"),
			],
			unavailable: [],
		};
	}

	function tinyMemo(cites: Array<{ ref: string; quote: string }>): Record<string, unknown> {
		const claims = cites.map((citation) => ({
			// No decision language, PII, or proxy terms: the quoted value is
			// the only case-specific token.
			text: `The recorded value ${citation.quote} is noted for the file.`,
			citations: [citation],
		}));
		const keys = [
			"request",
			"entity",
			"financial_summary",
			"strengths",
			"risks",
			"policy_compliance",
		];
		return {
			title: "Credit memorandum draft",
			sections: keys.map((key, index) =>
				index === 0
					? { key, title: "Request", claims, notAvailable: false }
					: { key, title: key, claims: [], notAvailable: true },
			),
			openItems: [],
			officerQuestions: ["What is the current status of the record?"],
		};
	}

	it("rejects citations never returned by tools, then accepts after repair", async () => {
		const evidence = tinyBundle();
		const draft = tinyMemo([
			{ ref: AMOUNT_REF, quote: "6000000" },
			{ ref: TERM_REF, quote: "60" },
		]);
		const { runner, inputs } = scriptedRunner([
			{
				rawOutput: JSON.stringify(draft),
				tools: [{ name: "get_evidence", resultCount: 1, sourceTypes: ["case_fact"] }],
				sourceRefs: [AMOUNT_REF],
				steps: 2,
			},
			{
				rawOutput: JSON.stringify(draft),
				tools: [{ name: "get_evidence", resultCount: 1, sourceTypes: ["case_fact"] }],
				sourceRefs: [TERM_REF],
				steps: 2,
			},
		]);
		const { content, trace } = await runMemoAgent({
			application: smeApp(),
			evidence,
			runner,
			config: agentConfig(),
		});
		expect(validateGeneratedText({ artifactType: "credit_memo", content, evidence }).ok).toBe(true);
		expect(trace.repairAttempted).toBe(true);
		expect(trace.repairSucceeded).toBe(true);
		expect(inputs[1]?.repair?.requireTools).toBe(true);
		expect(inputs[1]?.repair?.issues).toContainEqual(
			expect.objectContaining({ code: "CITATION_NOT_FROM_TOOL" }),
		);
	});

	it("fails INVALID_OUTPUT when the repaired draft still cites unfetched refs", async () => {
		const evidence = tinyBundle();
		const draft = tinyMemo([
			{ ref: AMOUNT_REF, quote: "6000000" },
			{ ref: TERM_REF, quote: "60" },
		]);
		const { runner } = scriptedRunner([
			{
				rawOutput: JSON.stringify(draft),
				tools: [{ name: "get_evidence", resultCount: 1, sourceTypes: ["case_fact"] }],
				sourceRefs: [AMOUNT_REF],
				steps: 2,
			},
			{ rawOutput: JSON.stringify(draft), steps: 1 },
		]);
		const error = await runMemoAgent({
			application: smeApp(),
			evidence,
			runner,
			config: agentConfig(),
		}).catch((err: unknown) => err);
		expect(error).toBeInstanceOf(MemoAgentError);
		expect((error as MemoAgentError).code).toBe("INVALID_OUTPUT");
		expect((error as MemoAgentError).issues).toContainEqual(
			expect.objectContaining({ code: "CITATION_NOT_FROM_TOOL" }),
		);
	});

	it("rejects drafts missing an evidence category, then accepts after repair", async () => {
		const base = tinyBundle();
		const evidence: EvidenceBundle = {
			...base,
			items: [...base.items, item(POLICY_REF, "policy_section", "policy", POLICY_QUOTE, {})],
		};
		const draft = tinyMemo([{ ref: AMOUNT_REF, quote: "6000000" }]);
		const { runner, inputs } = scriptedRunner([
			{
				rawOutput: JSON.stringify(draft),
				tools: [{ name: "get_evidence", resultCount: 1, sourceTypes: ["case_fact"] }],
				sourceRefs: [AMOUNT_REF],
				steps: 2,
			},
			{
				rawOutput: JSON.stringify(draft),
				tools: [
					{ name: "list_evidence", resultCount: 4, sourceTypes: ["case_fact", "policy_section"] },
				],
				sourceRefs: [AMOUNT_REF, POLICY_REF],
				steps: 2,
			},
		]);
		const { content, trace } = await runMemoAgent({
			application: smeApp(),
			evidence,
			runner,
			config: agentConfig(),
		});
		expect(validateGeneratedText({ artifactType: "credit_memo", content, evidence }).ok).toBe(true);
		expect(trace.repairAttempted).toBe(true);
		expect(trace.repairSucceeded).toBe(true);
		const repair = inputs[1]?.repair;
		expect(repair?.requireTools).toBe(true);
		expect(repair?.issues).toContainEqual(
			expect.objectContaining({ code: "EVIDENCE_COVERAGE", path: "evidence.policy_section" }),
		);
	});
});
