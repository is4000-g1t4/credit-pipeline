// runMemoAgent unit tests: no DB, no network. A scripted fake MemoModel
// drives the loop; evidence fixtures are built from EvidenceItem directly.
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
	MEMO_AGENT_TOOLS,
	MemoAgentError,
	runMemoAgent,
	type MemoAgentConfig,
} from "../../src/assist/memo-agent.js";
import {
	MemoModelError,
	type MemoModel,
	type MemoModelMessage,
	type MemoToolDefinition,
} from "../../src/assist/memo-model.js";
import { evidenceHash } from "../../src/assist/memo-trace.js";

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

interface ScriptedStep {
	content?: string | null;
	toolCalls?: Array<{ name: string; arguments?: unknown; id?: string }>;
	usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
	error?: MemoModelError | Error;
}

function scriptedModel(steps: ScriptedStep[]): {
	model: MemoModel;
	calls: Array<{ messages: MemoModelMessage[]; tools: MemoToolDefinition[] }>;
} {
	const calls: Array<{ messages: MemoModelMessage[]; tools: MemoToolDefinition[] }> = [];
	let index = 0;
	return {
		calls,
		model: {
			async complete(input) {
				calls.push({ messages: input.messages, tools: input.tools });
				const step = steps[Math.min(index, steps.length - 1)];
				index += 1;
				if (step.error) throw step.error;
				return {
					content: step.content ?? null,
					toolCalls: (step.toolCalls ?? []).map((call, callIndex) => ({
						id: call.id ?? `call_${index}_${callIndex}`,
						name: call.name,
						arguments: call.arguments ?? {},
					})),
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

function lastUserMessage(calls: Array<{ messages: MemoModelMessage[] }>): string {
	const messages = calls[calls.length - 1]?.messages ?? [];
	const user = [...messages].reverse().find((message) => message.role === "user");
	return typeof user?.content === "string" ? user.content : "";
}

describe("runMemoAgent", () => {
	it("completes the happy path with tool calls and a metadata-only trace", async () => {
		const evidence = bundle();
		const { model, calls } = scriptedModel([
			{
				toolCalls: [{ name: "list_evidence", arguments: {} }],
				usage: { inputTokens: 30, outputTokens: 10 },
			},
			{ content: JSON.stringify(validMemo()), usage: { inputTokens: 30, outputTokens: 70 } },
		]);
		const { content, trace } = await runMemoAgent({
			application: smeApp(),
			evidence,
			model,
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
		expect(calls).toHaveLength(2);
		expect(calls[0]?.tools.map((tool) => tool.name)).toEqual([
			"list_evidence",
			"search_evidence",
			"get_evidence",
			"list_unavailable",
		]);
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
		const { model, calls } = scriptedModel([
			{ content: JSON.stringify(validMemo()) },
			{ toolCalls: [{ name: "list_evidence", arguments: {} }] },
			{ content: JSON.stringify(validMemo()) },
		]);
		const { trace } = await runMemoAgent({
			application: smeApp(),
			evidence,
			model,
			config: agentConfig(),
		});
		expect(trace.steps).toBe(3);
		expect(trace.toolCalls).toHaveLength(1);
		expect(trace.toolCalls[0]).toMatchObject({ name: "list_evidence" });
		expect(trace.toolCalls[0]?.resultCount).toBeGreaterThan(0);
		expect(trace.repairAttempted).toBe(true);
		expect(trace.repairSucceeded).toBe(true);
		expect(lastUserMessage(calls)).toContain("without calling any evidence tool");
	});

	it("fails with NO_TOOL_USE when the repair still uses no tools", async () => {
		const { model } = scriptedModel([{ content: JSON.stringify(validMemo()) }]);
		const error = await runMemoAgent({
			application: smeApp(),
			evidence: bundle(),
			model,
			config: agentConfig(),
		}).catch((err: unknown) => err);
		expect(error).toBeInstanceOf(MemoAgentError);
		expect((error as MemoAgentError).code).toBe("NO_TOOL_USE");
	});

	it("repairs once on validation failure with codes/paths only", async () => {
		const evidence = bundle();
		const { model, calls } = scriptedModel([
			{ toolCalls: [{ name: "list_evidence", arguments: {} }] },
			{ content: JSON.stringify(invalidMemo()) },
			{ content: JSON.stringify(validMemo()) },
		]);
		const { trace } = await runMemoAgent({
			application: smeApp(),
			evidence,
			model,
			config: agentConfig(),
		});
		expect(trace.repairAttempted).toBe(true);
		expect(trace.repairSucceeded).toBe(true);
		const repair = lastUserMessage(calls);
		expect(repair).toContain("UNSUPPORTED_CLAIM");
		expect(repair).toContain("sections.3.claims.0");
		expect(repair).not.toContain(POLICY_QUOTE);
	});

	it("fails with INVALID_OUTPUT when the repair is still invalid", async () => {
		const { model } = scriptedModel([
			{ toolCalls: [{ name: "list_evidence", arguments: {} }] },
			{ content: JSON.stringify(invalidMemo()) },
			{ content: "not json at all" },
		]);
		const error = await runMemoAgent({
			application: smeApp(),
			evidence: bundle(),
			model,
			config: agentConfig(),
		}).catch((err: unknown) => err);
		expect(error).toBeInstanceOf(MemoAgentError);
		expect((error as MemoAgentError).code).toBe("INVALID_OUTPUT");
		expect((error as MemoAgentError).issues.length).toBeGreaterThan(0);
		expect(JSON.stringify((error as MemoAgentError).issues)).not.toContain(POLICY_QUOTE);
	});

	it("fails with STEP_LIMIT when the model never answers", async () => {
		const { model, calls } = scriptedModel([
			{ toolCalls: [{ name: "list_evidence", arguments: {} }] },
		]);
		const error = await runMemoAgent({
			application: smeApp(),
			evidence: bundle(),
			model,
			config: agentConfig({ maxSteps: 2 }),
		}).catch((err: unknown) => err);
		expect(error).toBeInstanceOf(MemoAgentError);
		expect((error as MemoAgentError).code).toBe("STEP_LIMIT");
		expect(calls).toHaveLength(2);
	});

	it("fails with TOOL_CALL_LIMIT when a batch exceeds the budget", async () => {
		const { model } = scriptedModel([
			{
				toolCalls: [
					{ name: "list_evidence", arguments: {} },
					{ name: "search_evidence", arguments: { query: "revenue" } },
					{ name: "get_evidence", arguments: { ref: AMOUNT_REF } },
				],
			},
		]);
		const error = await runMemoAgent({
			application: smeApp(),
			evidence: bundle(),
			model,
			config: agentConfig({ maxToolCalls: 2 }),
		}).catch((err: unknown) => err);
		expect(error).toBeInstanceOf(MemoAgentError);
		expect((error as MemoAgentError).code).toBe("TOOL_CALL_LIMIT");
	});

	it("fails with TIMEOUT when the wall-clock budget is spent", async () => {
		const { model, calls } = scriptedModel([
			{ toolCalls: [{ name: "list_evidence", arguments: {} }] },
		]);
		const error = await runMemoAgent({
			application: smeApp(),
			evidence: bundle(),
			model,
			config: agentConfig({ timeoutMs: 0 }),
		}).catch((err: unknown) => err);
		expect(error).toBeInstanceOf(MemoAgentError);
		expect((error as MemoAgentError).code).toBe("TIMEOUT");
		expect(calls).toHaveLength(0);
	});

	it("fails with BUDGET_EXCEEDED when accumulated cost passes the cap", async () => {
		const { model } = scriptedModel([
			{
				toolCalls: [{ name: "list_evidence", arguments: {} }],
				usage: { inputTokens: 100, outputTokens: 100, costUsd: 1 },
			},
		]);
		const error = await runMemoAgent({
			application: smeApp(),
			evidence: bundle(),
			model,
			config: agentConfig({ maxCostUsd: 0.25 }),
		}).catch((err: unknown) => err);
		expect(error).toBeInstanceOf(MemoAgentError);
		expect((error as MemoAgentError).code).toBe("BUDGET_EXCEEDED");
	});

	it("handles unknown tools and bad args as tool errors and continues", async () => {
		const evidence = bundle();
		const { model, calls } = scriptedModel([
			{
				toolCalls: [
					{ name: "mystery_tool", arguments: {} },
					{ name: "get_evidence", arguments: { nope: 1 } },
					{ name: "search_evidence", arguments: { query: "revenue" } },
					{ name: "list_evidence", arguments: {} },
				],
			},
			{ content: JSON.stringify(validMemo()) },
		]);
		const { trace } = await runMemoAgent({
			application: smeApp(),
			evidence,
			model,
			config: agentConfig(),
		});
		expect(trace.toolCalls).toHaveLength(4);
		expect(trace.toolCalls[0]).toMatchObject({
			name: "mystery_tool",
			resultCount: 0,
			sourceTypes: [],
		});
		expect(trace.toolCalls[1]).toMatchObject({
			name: "get_evidence",
			resultCount: 0,
			sourceTypes: [],
		});
		expect(trace.toolCalls[2]?.resultCount).toBeGreaterThan(0);
		const toolMessages = (calls[1]?.messages ?? []).filter((message) => message.role === "tool");
		expect(toolMessages).toHaveLength(4);
		for (const message of toolMessages.slice(0, 2)) {
			expect(String(message.content)).toContain("error");
		}
	});

	it("maps model transport errors to typed agent errors", async () => {
		for (const [modelError, code] of [
			[new MemoModelError("UNAVAILABLE"), "MODEL_ERROR"],
			[new MemoModelError("INVALID_RESPONSE"), "MODEL_ERROR"],
			[new MemoModelError("TIMEOUT"), "TIMEOUT"],
		] as const) {
			const { model } = scriptedModel([{ error: modelError }]);
			const error = await runMemoAgent({
				application: smeApp(),
				evidence: bundle(),
				model,
				config: agentConfig(),
			}).catch((err: unknown) => err);
			expect((error as MemoAgentError).code).toBe(code);
		}
	});

	it("exposes exactly the four allowlisted tools", () => {
		expect(MEMO_AGENT_TOOLS.map((tool) => tool.name)).toEqual([
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
		const { model, calls } = scriptedModel([
			{ toolCalls: [{ name: "get_evidence", arguments: { ref: AMOUNT_REF } }] },
			{ content: JSON.stringify(draft) },
			{ toolCalls: [{ name: "get_evidence", arguments: { ref: TERM_REF } }] },
			{ content: JSON.stringify(draft) },
		]);
		const { content, trace } = await runMemoAgent({
			application: smeApp(),
			evidence,
			model,
			config: agentConfig(),
		});
		expect(validateGeneratedText({ artifactType: "credit_memo", content, evidence }).ok).toBe(true);
		expect(trace.repairAttempted).toBe(true);
		expect(trace.repairSucceeded).toBe(true);
		expect(lastUserMessage(calls)).toContain("CITATION_NOT_FROM_TOOL");
	});

	it("fails INVALID_OUTPUT when the repaired draft still cites unfetched refs", async () => {
		const evidence = tinyBundle();
		const draft = tinyMemo([
			{ ref: AMOUNT_REF, quote: "6000000" },
			{ ref: TERM_REF, quote: "60" },
		]);
		const { model } = scriptedModel([
			{ toolCalls: [{ name: "get_evidence", arguments: { ref: AMOUNT_REF } }] },
			{ content: JSON.stringify(draft) },
			{ content: JSON.stringify(draft) },
		]);
		const error = await runMemoAgent({
			application: smeApp(),
			evidence,
			model,
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
		const { model, calls } = scriptedModel([
			{ toolCalls: [{ name: "get_evidence", arguments: { ref: AMOUNT_REF } }] },
			{ content: JSON.stringify(draft) },
			{ toolCalls: [{ name: "list_evidence", arguments: {} }] },
			{ content: JSON.stringify(draft) },
		]);
		const { content, trace } = await runMemoAgent({
			application: smeApp(),
			evidence,
			model,
			config: agentConfig(),
		});
		expect(validateGeneratedText({ artifactType: "credit_memo", content, evidence }).ok).toBe(true);
		expect(trace.repairAttempted).toBe(true);
		expect(trace.repairSucceeded).toBe(true);
		const repair = lastUserMessage(calls);
		expect(repair).toContain("EVIDENCE_COVERAGE");
		expect(repair).toContain("policy_section");
	});
});
