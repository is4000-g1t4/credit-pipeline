// Agentic memo eval (scripted mechanics, no network, no live model).
// Archetype: bounded tool-loop harness. Cases drive the production
// `runMemoAgent` with a scripted fake MemoAgentRunner (executing the real
// evidence tools) and grade the production `validateGeneratedText` outcome
// (accept vs typed agent error), plus tool/source coverage, gap retrieval,
// repair, citation, and safety stats.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
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
	type MemoAgentErrorCode,
	type MemoAgentRunResult,
	type MemoAgentRunner,
} from "../src/assist/memo-agent.js";
import { runMemoEvidenceTool } from "../src/assist/memo-tools.js";
import type { MemoAgentTrace } from "../src/assist/memo-trace.js";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

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
		sourceType,
		label,
		content,
		ref,
		access: { retentionUntil: null, legalHold: false },
		metadata,
	};
}

const application = {
	id: APP_ID,
	reference: "APP-2026-0001",
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
	submittedAt: new Date("2026-06-30T00:00:00.000Z"),
	createdAt: new Date("2026-06-30T00:00:00.000Z"),
} as unknown as typeof applications.$inferSelect;

const bundle: EvidenceBundle = {
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
		item(`external_evidence:${EXTERNAL_ID}`, "external_evidence", "report", "Bureau on file.", {}),
		item(POLICY_REF, "policy_section", "policy", POLICY_QUOTE, {}),
	],
	unavailable: [{ ref: MISSING_DOC_REF, sourceType: "document", code: "missing" }],
};

function section(
	key: string,
	title: string,
	claims: Array<{ text: string; citations: Array<{ ref: string; quote: string }> }>,
) {
	return claims.length > 0
		? { key, title, claims, notAvailable: false }
		: { key, title, claims: [], notAvailable: true };
}

/** Neutral prose mirroring the deterministic builder (passes EN-03 scans). */
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

function mutateMemo(mutator: (memo: Record<string, unknown>) => void): Record<string, unknown> {
	const memo = structuredClone(validMemo());
	mutator(memo);
	return memo;
}

const unsupportedMemo = (): Record<string, unknown> =>
	mutateMemo((memo) => {
		const strengths = (memo["sections"] as Array<Record<string, unknown>>)[3];
		strengths["claims"] = [{ text: "An uncited observation about the case.", citations: [] }];
	});

const mismatchMemo = (): Record<string, unknown> =>
	mutateMemo((memo) => {
		const request = (memo["sections"] as Array<Record<string, unknown>>)[0];
		const claim = (request["claims"] as Array<Record<string, unknown>>)[0];
		claim["citations"] = [{ ref: AMOUNT_REF, quote: "6000001" }];
	});

const decisionMemo = (): Record<string, unknown> =>
	mutateMemo((memo) => {
		const request = (memo["sections"] as Array<Record<string, unknown>>)[0];
		const claim = (request["claims"] as Array<Record<string, unknown>>)[0];
		claim["text"] = "The application is approved for USD 60,000.00.";
	});

interface ScriptedRun {
	tools?: Array<{ name: string; args?: unknown }>;
	draft?: string;
	error?: Error;
}

/** Scripted runner: tools execute the production `runMemoEvidenceTool`
 * against the fixed bundle, so coverage stays faithful without a model. */
function scriptedRunner(runs: ScriptedRun[]): {
	runner: MemoAgentRunner;
	drafts: string[];
} {
	const drafts: string[] = [];
	let index = 0;
	return {
		drafts,
		runner: {
			async run(input): Promise<MemoAgentRunResult> {
				const run = runs[Math.min(index, runs.length - 1)];
				index += 1;
				if (!run) throw new MemoAgentError("MODEL_ERROR");
				if (run.error) throw run.error;
				const toolCalls: MemoAgentTrace["toolCalls"] = [];
				const refs = new Set<string>();
				for (const call of run.tools ?? []) {
					const outcome = runMemoEvidenceTool(call.name, call.args ?? {}, input.evidence);
					toolCalls.push({
						step: toolCalls.length + 1,
						name: call.name.slice(0, 80),
						resultCount: outcome.resultCount,
						sourceTypes: outcome.sourceTypes,
					});
					for (const ref of outcome.refs) refs.add(ref);
				}
				const rawOutput = run.draft ?? "";
				drafts.push(rawOutput);
				return {
					rawOutput,
					toolCalls,
					sourceRefs: [...refs].sort(),
					steps: toolCalls.length + 1,
					usage: { inputTokens: 10, outputTokens: 20, costUsd: 0 },
				};
			},
		},
	};
}

function agentConfig(over: Partial<MemoAgentConfig> = {}): MemoAgentConfig {
	return {
		model: "eval-model",
		promptVersion: "memo-agent-v1",
		agentVersion: "memo-agent-v1",
		maxSteps: 8,
		maxToolCalls: 12,
		timeoutMs: 45_000,
		maxCostUsd: 0.25,
		...over,
	};
}

interface AgentEvalCase {
	id: string;
	runs: ScriptedRun[];
	config?: Partial<MemoAgentConfig>;
	expected: "accept" | MemoAgentErrorCode;
	tags: string[];
}

function cases(): AgentEvalCase[] {
	const valid = JSON.stringify(validMemo());
	const list = { name: "list_evidence" };
	return [
		{
			id: "happy-tool-use",
			runs: [{ tools: [list], draft: valid }],
			expected: "accept",
			tags: ["happy"],
		},
		{
			// First listing surfaces a gap; the model retrieves before drafting.
			id: "gap-second-retrieval",
			runs: [
				{
					tools: [
						list,
						{ name: "search_evidence", args: { query: "revenue" } },
						{ name: "get_evidence", args: { ref: REVENUE_REF } },
					],
					draft: valid,
				},
			],
			expected: "accept",
			tags: ["happy", "gap-retrieval"],
		},
		{
			id: "repair-then-valid",
			runs: [{ tools: [list], draft: JSON.stringify(unsupportedMemo()) }, { draft: valid }],
			expected: "accept",
			tags: ["repair"],
		},
		{
			id: "no-tool-failure",
			runs: [{ draft: valid }, { draft: valid }],
			expected: "NO_TOOL_USE",
			tags: ["failure"],
		},
		{
			id: "invalid-after-repair",
			runs: [
				{ tools: [list], draft: JSON.stringify(unsupportedMemo()) },
				{ draft: "not json at all" },
			],
			expected: "INVALID_OUTPUT",
			tags: ["failure"],
		},
		{
			id: "bound-exceeded",
			runs: [
				{
					tools: [
						list,
						{ name: "search_evidence", args: { query: "revenue" } },
						{ name: "get_evidence", args: { ref: AMOUNT_REF } },
					],
					draft: valid,
				},
			],
			config: { maxToolCalls: 2 },
			expected: "TOOL_CALL_LIMIT",
			tags: ["failure", "bound"],
		},
		{
			// Exact-quote mismatch persists through the single repair attempt.
			id: "citation-mismatch",
			runs: [
				{ tools: [list], draft: JSON.stringify(mismatchMemo()) },
				{ draft: JSON.stringify(mismatchMemo()) },
			],
			expected: "INVALID_OUTPUT",
			tags: ["failure", "citation"],
		},
		{
			// Decision language in the first draft is repaired, never persisted.
			// The repair turn also grounds the draft: it retrieves the cited
			// refs and every evidence category before rewriting.
			id: "decision-language-repair",
			runs: [
				{
					tools: [{ name: "get_evidence", args: { ref: AMOUNT_REF } }],
					draft: JSON.stringify(decisionMemo()),
				},
				{ tools: [list], draft: valid },
			],
			expected: "accept",
			tags: ["repair", "safety"],
		},
	];
}

interface CaseResult {
	id: string;
	expected: string;
	observed: string;
	pass: boolean;
	tags: string[];
	steps: number | null;
	toolCalls: number | null;
	sourceTypes: string[];
	repairAttempted: boolean | null;
}

interface TrialOutcome {
	results: CaseResult[];
	toolUseRate: number;
	sourceTypeCoverage: number;
	gapRetrievals: number;
	repairRate: number;
	citationCoverage: number;
	unsupportedClaims: number;
	safetyPass: number;
}

async function runOnce(evalCases: AgentEvalCase[]): Promise<TrialOutcome> {
	const results: CaseResult[] = [];
	const bundleTypes = new Set(bundle.items.map((item) => item.sourceType));
	const seenTypes = new Set<string>();
	let gapRetrievals = 0;
	let unsupportedClaims = 0;
	let accepted = 0;
	let acceptedWithTools = 0;
	let acceptedRepaired = 0;
	let cited = 0;
	let total = 0;
	let unsafe = 0;
	let unsafeClosed = 0;

	for (const testCase of evalCases) {
		const { runner, drafts } = scriptedRunner(testCase.runs);
		let observed = "threw";
		let steps: number | null = null;
		let toolCalls: number | null = null;
		let sourceTypes: string[] = [];
		let repairAttempted: boolean | null = null;
		try {
			const { content, trace } = await runMemoAgent({
				application,
				evidence: bundle,
				runner,
				config: agentConfig(testCase.config),
			});
			const validation = validateGeneratedText({
				artifactType: "credit_memo",
				content,
				evidence: bundle,
			});
			observed = validation.ok ? "accept" : "VALIDATION_FAILED";
			steps = trace.steps;
			toolCalls = trace.toolCalls.length;
			sourceTypes = [...new Set(trace.toolCalls.flatMap((call) => call.sourceTypes))].sort();
			for (const type of sourceTypes) seenTypes.add(type);
			repairAttempted = trace.repairAttempted;
			if (new Set(trace.toolCalls.map((call) => call.step)).size >= 2) {
				gapRetrievals += 1;
			}
			if (validation.ok) {
				accepted += 1;
				if ((trace.toolCalls.length ?? 0) > 0) acceptedWithTools += 1;
				if (trace.repairAttempted) acceptedRepaired += 1;
				for (const section of content.sections) {
					for (const claim of section.claims) {
						total += 1;
						if (claim.citations.length > 0) cited += 1;
					}
				}
			}
		} catch (err) {
			observed = err && typeof err === "object" && "code" in err ? String(err.code) : "threw";
		}
		if (testCase.tags.includes("failure")) {
			unsafe += 1;
			if (observed === testCase.expected) unsafeClosed += 1;
		}
		if (testCase.id === "decision-language-repair") {
			// Unsafe first draft repaired to a valid memo; the loop never
			// persists, so nothing unsafe reaches an artifact.
			unsafe += 1;
			if (observed === "accept") unsafeClosed += 1;
		}
		// First-draft hygiene: count unsupported-claim drafts the loop caught.
		const firstDraft = drafts.find((draft) => typeof draft === "string" && draft.length > 0);
		if (typeof firstDraft === "string") {
			try {
				const parsed = JSON.parse(firstDraft) as unknown;
				const check = validateGeneratedText({
					artifactType: "credit_memo",
					content: parsed,
					evidence: bundle,
				});
				if (!check.ok) {
					unsupportedClaims += check.issues.filter(
						(issue) => issue.code === "UNSUPPORTED_CLAIM",
					).length;
				}
			} catch {
				// Non-JSON first drafts count as invalid, not unsupported.
			}
		}
		results.push({
			id: testCase.id,
			expected: testCase.expected,
			observed,
			pass: observed === testCase.expected,
			tags: testCase.tags,
			steps,
			toolCalls,
			sourceTypes,
			repairAttempted,
		});
	}

	return {
		results,
		toolUseRate: accepted === 0 ? 0 : acceptedWithTools / accepted,
		sourceTypeCoverage: bundleTypes.size === 0 ? 1 : seenTypes.size / bundleTypes.size,
		gapRetrievals,
		repairRate: accepted === 0 ? 0 : acceptedRepaired / accepted,
		citationCoverage: total === 0 ? 1 : cited / total,
		unsupportedClaims,
		safetyPass: unsafe === 0 ? 1 : unsafeClosed / unsafe,
	};
}

const evalCases = cases();
const trials = [await runOnce(evalCases), await runOnce(evalCases), await runOnce(evalCases)];
const first = trials[0].results;
const passAt1 = first.filter((r) => r.pass).length / first.length;
const passAt3 =
	first.filter((_, index) => trials.every((trial) => trial.results[index]?.pass)).length /
	first.length;
const mean = (pick: (trial: TrialOutcome) => number): number =>
	trials.reduce((sum, trial) => sum + pick(trial), 0) / trials.length;

const summary = {
	feature: "agentic credit memo",
	archetype: "bounded tool loop over the evidence bundle (scripted runner)",
	model: "scripted-fake",
	costUsd: 0,
	n: first.length,
	trials: 3,
	passAt1,
	passAt3,
	accepted: first.filter((r) => r.observed === "accept").length,
	toolUseRate: mean((trial) => trial.toolUseRate),
	sourceTypeCoverage: mean((trial) => trial.sourceTypeCoverage),
	gapRetrievals: trials[0].gapRetrievals,
	repairRate: mean((trial) => trial.repairRate),
	citationCoverage: mean((trial) => trial.citationCoverage),
	unsupportedClaims: trials[0].unsupportedClaims,
	safetyPass: mean((trial) => trial.safetyPass),
	failures: first.filter((r) => !r.pass),
};

const outDir = fileURLToPath(new URL("./results/", import.meta.url));
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
writeFileSync(
	`${outDir}memo-agent-${stamp}.json`,
	`${JSON.stringify({ summary, cases: first }, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));
if (passAt1 < 1) process.exitCode = 1;

if (process.argv.includes("--live")) {
	const { createAgentsMemoRunner } = await import("../src/assist/memo-agent-sdk.js");
	const { applicationObservability } = await import("../src/observability.js");
	const apiKey = process.env.OPENROUTER_API_KEY ?? "";
	if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for --live");
	const model = process.env.ASSIST_MEMO_MODEL ?? "deepseek/deepseek-v4.1-flash-1017";
	const promptVersion = process.env.ASSIST_MEMO_PROMPT_VERSION ?? "memo-agent-v1";
	const agentVersion = process.env.ASSIST_MEMO_AGENT_VERSION ?? "memo-agent-v1";
	const runner = createAgentsMemoRunner({
		apiKey,
		baseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
		model,
		agentVersion,
		promptVersion,
		maxToolCalls: 32,
		maxOutputTokens: 4000,
		timeoutMs: 90_000,
	});
	const live = await runMemoAgent({
		application,
		evidence: bundle,
		runner,
		runId: `memo-eval:live:${Date.now()}`,
		config: {
			model,
			promptVersion,
			agentVersion,
			maxSteps: 40,
			maxToolCalls: 32,
			timeoutMs: 90_000,
			maxCostUsd: 0.25,
		},
	});
	const validation = validateGeneratedText({
		artifactType: "credit_memo",
		content: live.content,
		evidence: bundle,
	});
	console.log(
		JSON.stringify(
			{
				live: true,
				model,
				steps: live.trace.steps,
				toolCalls: live.trace.toolCalls.map((call) => call.name),
				usage: { inputTokens: live.trace.inputTokens, outputTokens: live.trace.outputTokens },
				validationOk: validation.ok,
				issues: validation.ok ? [] : validation.issues,
			},
			null,
			2,
		),
	);
	await applicationObservability().shutdown();
	if (!validation.ok) process.exitCode = 1;
}
