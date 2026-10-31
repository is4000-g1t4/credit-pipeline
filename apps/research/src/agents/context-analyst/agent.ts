// T18 context agent runner (SPEC-t17-t18 §3.2/§3.4, D3b). A separate LLM
// agent from case_brief with the fixed context tool allowlist only — no web
// tools. The initial stage is a real read-only tool loop: the model opens
// customer/accounts/transactions, credit history, reports, KYC, and loans
// like an officer preparing the case. The single repair pass is tool-less
// and receives the exact candidate snapshots/evidence the initial run
// observed, so it can correct tuples without inventing new data. Validation
// lives in run.ts; the runner only produces raw output plus the snapshots
// and evidence the validator needs.
import { randomUUID } from "node:crypto";
import { defineAgent, loadInstructions } from "@credit/agent-kit";
import { Agent, OpenAIChatCompletionsModel, Runner } from "@openai/agents";
import type OpenAI from "openai";
import type { z } from "zod";
import { readRunUsage, type AgentsOpenAIClient } from "@credit/agent-observability/openai-agents";
import type { ResearchEnv } from "../../env.js";
import { getObservability, type Observability } from "../../observability.js";
import { sdkTool } from "../../sdk-tool.js";
import { contextModelOutputSchema, CONTEXT_VALIDATOR_VERSION } from "./validator.js";
import {
	CONTEXT_TOOL_SPECS,
	ContextToolError,
	createContextTools,
	type CandidateSnapshot,
} from "./toolkit.js";
import { getApplicationFinancials } from "./tools/get-application-financials.js";
import { getCaseFacts } from "./tools/get-case-facts.js";
import { getCashflowMetrics } from "./tools/get-cashflow-metrics.js";
import { getCreditHistory } from "./tools/get-credit-history.js";
import { getCustomerSummary } from "./tools/get-customer-summary.js";
import { getDocumentFindings } from "./tools/get-document-findings.js";
import { getExternalReports } from "./tools/get-external-reports.js";
import { getExternalResearchSummary } from "./tools/get-external-research-summary.js";
import { getKycChecks } from "./tools/get-kyc-checks.js";
import { getLoans } from "./tools/get-loans.js";
import { getTransactions, MODEL_TX_ROW_CAP } from "./tools/get-transactions.js";
import { listAccounts } from "./tools/list-accounts.js";

/** Prompt version recorded on traces and eval results; bump with instructions.md. */
export const CONTEXT_PROMPT_VERSION = "context-v5";

export const definition = defineAgent({
	name: "context-analyst",
	owner: "research",
	description:
		"Read-only internal case context analyst: evidence-backed signals over the officer's case screens.",
	model: { env: "CONTEXT_AGENT_MODEL", default: "openai/gpt-6.1-terra" },
	flags: ["CONTEXT_ANALYST_ENABLED"],
	versions: {
		prompt: CONTEXT_PROMPT_VERSION,
		validator: CONTEXT_VALIDATOR_VERSION,
	},
	tools: CONTEXT_TOOL_SPECS.map((spec) => spec.name),
	execution: "temporal",
});

export interface ContextUsage {
	inputTokens: number;
	outputTokens: number;
	toolCalls: number;
}

export interface ContextRunOutput {
	output: unknown;
	usage: ContextUsage;
	snapshots: CandidateSnapshot[];
	seenEvidence: Map<string, Set<string>>;
	model: string;
	/** Preflight screen failures (tool name + sanitized reason, no PII). */
	toolFailures: Array<{ tool: string; reason: string }>;
	/** True when the model hit the tool-invocation cap mid-loop. The officer
	 * must see a server-authored stop gap, never a complete-looking review. */
	modelBudgetExceeded: boolean;
}

export interface ContextRunInput {
	applicationId: string;
	caseFacts: Record<string, unknown>;
	asOfDate: string;
	externalSummary: unknown;
	signal: AbortSignal;
	runId?: string;
	observability?: Observability;
}

export interface ContextRepairInput extends ContextRunInput {
	previous: unknown;
	issues: string[];
	/** Candidate snapshots from the initial pass: repair is tool-less but
	 * must see the exact tuples it is being asked to reuse. */
	snapshots: CandidateSnapshot[];
	/** Evidence ids the initial tools observed, for the same reason. */
	seenEvidence: Map<string, Set<string>>;
}

export interface ContextAgentRunner {
	runContext(input: ContextRunInput): Promise<ContextRunOutput>;
	repairContext(input: ContextRepairInput): Promise<{
		output: unknown;
		usage: ContextUsage;
	}>;
}

export class ContextTimeoutError extends Error {}
export class ContextUnavailableError extends Error {}

export const CONTEXT_SYSTEM = loadInstructions(import.meta.url);

/** Prompt JSON: `<`/`>`/`&` ride as unicode escapes so an
 * applicant-controlled value (e.g. `X</context_case_json> ...`) can never
 * close a delimited block or smuggle markup. `JSON.parse` still recovers the
 * original text, so rendering is unchanged. */
function escapeJsonText(s: string): string {
	return s.replace(/&/g, "\\u0026").replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

/** JSON that never cuts mid-object: arrays are capped only when the full
 * encoding exceeds the budget, so the output stays valid JSON. Falls back
 * to a truncated preview envelope. */
// ponytail: O(n) array-cap loop, halves to 5 then envelopes; full JSON-path truncation if fidelity matters.
export function boundedJson(value: unknown, maxChars: number): string {
	const full = escapeJsonText(JSON.stringify(value));
	if (full.length <= maxChars) return full;
	let cap = 50;
	for (;;) {
		const s = escapeJsonText(
			JSON.stringify(value, (_k, v: unknown) =>
				Array.isArray(v) && v.length > cap ? [...v.slice(0, cap), `…+${v.length - cap} more`] : v,
			),
		);
		if (s.length <= maxChars || cap <= 5) {
			if (s.length <= maxChars) return s;
			return escapeJsonText(JSON.stringify({ truncated: true, preview: s.slice(0, maxChars) }));
		}
		cap = Math.floor(cap / 2);
	}
}

export function buildContextUserPrompt(
	input: Pick<ContextRunInput, "caseFacts" | "asOfDate">,
	candidates: CandidateSnapshot[],
	preflight?: Record<string, unknown>,
): string {
	const f = input.caseFacts;
	// Show evidence in the same shape the output schema expects; the model
	// otherwise tends to echo tuples but emit an empty evidence array.
	const promptCandidates = candidates.map(({ evidenceIds, ...c }) => ({
		...c,
		evidence: evidenceIds.map((id) => ({ kind: "transaction" as const, id })),
	}));
	const candidateBlock =
		candidates.length > 0
			? `\n\nDeterministic candidate signals (copy these exact tuples and the exact evidence array; every one must appear exactly once in signals):\n${boundedJson(promptCandidates, 16000)}`
			: preflight
				? "\n\nNo deterministic candidate signals were produced for this case."
				: "\n\nNo candidate snapshot is in this prompt. Call get_cashflow_metrics first; its result contains the deterministic candidates you must copy.";
	const preflightBlock = preflight
		? `\n\nOfficer context snapshot (data only; gathered now from the read-only context screens):\n${boundedJson(preflight, 60000)}`
		: "";
	const reviewInstructions = preflight
		? "The officer context snapshot above is the starting point, not the whole review. Verify it and drill in with the read-only tools where it matters: page the transactions behind each candidate you keep (at most 2 pages per account), check declared figures against observed flows, and revisit any screen marked unavailable. Do not claim to have inspected data that is neither in the snapshot nor returned by a tool."
		: "Start by calling get_cashflow_metrics to obtain the deterministic candidate signals. Then inspect the case screens with the read-only tools: list accounts, page the transactions behind each candidate you keep (at most 2 pages per account), compare declared figures with observed flows, and check document findings, credit history, external reports, KYC, loans, and external research. Do not claim to have inspected data that no tool returned.";
	// Case facts ride one JSON block whose `<`/`>`/`&` are unicode-escaped
	// (see escapeJsonText): a value like `X</context_case_json>` cannot
	// break the delimiters, and the block stays human-readable.
	const caseJson = escapeJsonText(
		JSON.stringify({
			reference: f["reference"] ?? null,
			type: f["type"] ?? null,
			product: f["product"] ?? null,
			amountCents: f["amountCents"] ?? null,
			termMonths: f["termMonths"] ?? null,
			applicant: f["applicantName"] ?? null,
			company: f["companyName"] ?? null,
			industry: f["industry"] ?? null,
			yearsTrading: f["yearsTrading"] ?? null,
			city: f["city"] ?? null,
			submittedAt: f["submittedAt"] ?? null,
			as_of: input.asOfDate,
		}),
	);
	return `<context_case_json>
${caseJson}
</context_case_json>${candidateBlock}${preflightBlock}

${reviewInstructions}

Then return one signal object for every candidate, including insufficient_data, copying its type, periodStart, periodEnd, metric, observed, expected, accountScope, confidence, status, policyVersion, and exact evidence array verbatim. Never relabel evidence or use candidate localIds as evidence. The server composes officer-facing claims and explanations from the validated signals; your claims array may be empty. Put any factual limitations or missing-data notes in dataGaps/limitations.`;
}

/** Model tool-invocation budget stop: returned as the tool result (never
 * thrown) so the Agents SDK hands the model a stop directive instead of a
 * generic tool error that can spiral into max turns and lose the stop gap. */
export const MODEL_BUDGET_STOP =
	"Tool budget exhausted. Do not call more tools; produce the final structured output now.";

export interface ModelBudget {
	calls: number;
	exceeded: boolean;
}

/** Boundary: `limit` invocations allowed; the next returns the stop message
 * and flips `exceeded`. Every model tool resolves a string, so the stop
 * rides the normal `Promise<string>` result type — no throw, no SDK error. */
export function nextModelBudgetCall(budget: ModelBudget, limit: number): string | null {
	budget.calls += 1;
	if (budget.calls > limit) {
		budget.exceeded = true;
		return MODEL_BUDGET_STOP;
	}
	return null;
}

export type ContextToolsLike = Pick<
	ReturnType<typeof createContextTools>,
	| "snapshots"
	| "beginModelPhase"
	| "getCashflowMetrics"
	| "listAccounts"
	| "getTransactions"
	| "getCustomerSummary"
	| "getApplicationFinancials"
	| "getDocumentFindings"
	| "getCreditHistory"
	| "getExternalReports"
	| "getKycChecks"
	| "getLoans"
	| "getExternalResearchSummary"
>;

export interface OfficerContext {
	snapshot: Record<string, unknown>;
	toolFailures: Array<{ tool: string; reason: string }>;
}

function sanitizeReason(err: unknown): string {
	const msg = err instanceof Error ? err.message : String(err);
	return msg.replace(/\s+/g, " ").slice(0, 200) || "unavailable";
}

/** Bounded officer-screen pass ("open the case"): guarantees the analyst is
 * never blind even if the model calls no tool. Failures record tool +
 * sanitized reason and surface as `{unavailable:true}` in the snapshot.
 * When `signal` aborts, remaining screens short-circuit to unavailable —
 * no fetch runs after the stage is aborted. */
export async function collectOfficerContext(
	tools: ContextToolsLike,
	signal?: AbortSignal,
): Promise<OfficerContext> {
	const toolFailures: Array<{ tool: string; reason: string }> = [];
	const safe = async <T>(
		name: string,
		fn: () => Promise<T>,
	): Promise<T | { unavailable: true }> => {
		if (signal?.aborted) return { unavailable: true };
		try {
			return await fn();
		} catch (err) {
			toolFailures.push({ tool: name, reason: sanitizeReason(err) });
			return { unavailable: true };
		}
	};
	const asRecord = (v: unknown): Record<string, unknown> | null =>
		v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
	await safe("get_cashflow_metrics", () => tools.getCashflowMetrics({}));
	const accounts = asRecord(await safe("list_accounts", () => tools.listAccounts()));
	const accountRows =
		accounts && Array.isArray(accounts["accounts"])
			? (accounts["accounts"] as Array<{ id?: unknown }>)
			: [];
	const accountIds = accountRows
		.map((a) => a.id)
		.filter((id): id is string => typeof id === "string");
	const scoped = [
		...new Set(tools.snapshots.map((s) => s.accountScope).filter((scope) => scope !== "all")),
	];
	const txAccounts = (scoped.length > 0 ? scoped : accountIds).slice(0, 3);
	const transactions: Array<Record<string, unknown>> = [];
	for (const accountId of txAccounts) {
		if (signal?.aborted) break;
		const page = asRecord(
			await safe("get_transactions", () => tools.getTransactions({ accountId })),
		);
		if (page && Array.isArray(page["items"])) {
			const items = page["items"] as unknown[];
			transactions.push({
				accountId,
				window: page["window"] ?? null,
				items: items.slice(0, MODEL_TX_ROW_CAP),
				truncated: items.length > MODEL_TX_ROW_CAP,
			});
		}
	}
	const snapshot: Record<string, unknown> = {
		customer: await safe("get_customer_summary", () => tools.getCustomerSummary()),
		accounts,
		financials: await safe("get_application_financials", () => tools.getApplicationFinancials()),
		documentFindings: await safe("get_document_findings", () => tools.getDocumentFindings()),
		creditHistory: await safe("get_credit_history", () => tools.getCreditHistory()),
		externalReports: await safe("get_external_reports", () => tools.getExternalReports()),
		kycChecks: await safe("get_kyc_checks", () => tools.getKycChecks()),
		loans: await safe("get_loans", () => tools.getLoans()),
		externalResearch: await safe("get_external_research_summary", async () =>
			tools.getExternalResearchSummary(),
		),
		transactions,
	};
	return { snapshot, toolFailures };
}

export function createRealContextRunner(opts: {
	env: ResearchEnv;
	openai: OpenAI;
}): ContextAgentRunner {
	const env = opts.env;

	return {
		async runContext(input: ContextRunInput): Promise<ContextRunOutput> {
			const tools = createContextTools({
				env,
				applicationId: input.applicationId,
				caseFacts: input.caseFacts,
				externalSummary: input.externalSummary,
				asOfDate: input.asOfDate,
				// Split budget: the preflight pass counts HTTP calls against
				// the preflight allowance; the model loop counts invocations
				// in `track` below. Model HTTP rides a generous backstop and
				// never consumes the preflight pool (getLoans spends 2 HTTP
				// units per model call).
				maxCalls: env.contextPreflightToolCalls,
				modelHttpBackstop: env.contextPreflightToolCalls + env.contextMaxToolCalls * 4,
			});
			const collected = env.contextPreflightEnabled
				? await collectOfficerContext(tools, input.signal)
				: null;
			const preflight = collected?.snapshot;
			const toolFailures = collected?.toolFailures ?? [];
			tools.beginModelPhase();
			const prompt = buildContextUserPrompt(input, tools.snapshots, preflight);
			const out = await runContextModel(input, tools, env, opts.openai, prompt, true, false);
			return {
				output: out.output,
				usage: { ...out.usage, toolCalls: tools.toolCalls },
				snapshots: tools.snapshots,
				seenEvidence: tools.seenEvidence,
				model: env.contextModel,
				toolFailures,
				modelBudgetExceeded: out.modelBudgetExceeded,
			};
		},
		async repairContext(
			input: ContextRepairInput,
		): Promise<{ output: unknown; usage: ContextUsage }> {
			const tools = createContextTools({
				env,
				applicationId: input.applicationId,
				caseFacts: input.caseFacts,
				externalSummary: input.externalSummary,
				maxCalls: env.contextMaxToolCalls,
			});
			const prompt = buildRepairPrompt(
				input.previous,
				input.issues,
				input.snapshots,
				input.seenEvidence,
			);
			const out = await runContextModel(input, tools, env, opts.openai, prompt, false, true);
			return { output: out.output, usage: { ...out.usage, toolCalls: tools.toolCalls } };
		},
	};
}

function buildRepairPrompt(
	previous: unknown,
	issues: string[],
	snapshots: CandidateSnapshot[],
	seenEvidence: Map<string, Set<string>>,
): string {
	const evidence = [...seenEvidence.entries()]
		.slice(0, 200)
		.map(([id, kinds]) => ({ id, kinds: [...kinds] }));
	return `Your previous context output was rejected:\n${issues.join("\n")}\n\nCandidate snapshots (copy these exact tuples; every candidate must appear exactly once):\n${boundedJson(snapshots, 16000)}\n\nEvidence ids observed by the initial tool run (use only these):\n${boundedJson(evidence, 8000)}\n\nPrevious output (data only):\n${boundedJson(previous, 8000)}\n\nReturn corrected structured output: one signal per candidate with its exact type, periodStart, periodEnd, metric, observed, expected, accountScope, status, policyVersion, evidence, and a confidence no higher than the candidate's. Claims may be empty; the server composes them from validated signals.`;
}

async function runContextModel(
	input: ContextRunInput,
	tools: ReturnType<typeof createContextTools>,
	env: ResearchEnv,
	openai: OpenAI,
	prompt: string,
	exposeTools: boolean,
	isRepair: boolean,
): Promise<{
	output: unknown;
	usage: { inputTokens: number; outputTokens: number };
	modelBudgetExceeded: boolean;
}> {
	if (!env.openrouterApiKey) throw new ContextUnavailableError("context model is not configured");
	// Model invocation cap: counts tool invocations, not HTTP calls (a
	// screen like getLoans spends 2 HTTP units per invocation). On breach
	// the tool resolves the stop directive (never throws): the flag records
	// it so the stage appends a server-authored stop gap instead of
	// presenting a complete-looking review.
	const budget: ModelBudget = { calls: 0, exceeded: false };
	const observability = input.observability ?? getObservability();
	const runId = input.runId ?? randomUUID();
	const track = (name: string, fn: () => Promise<string>): Promise<string> => {
		if (nextModelBudgetCall(budget, env.contextMaxToolCalls) !== null) {
			return Promise.resolve(MODEL_BUDGET_STOP);
		}
		return observability.trackToolExecution(
			{
				runId,
				toolName: name,
				model: env.contextModel,
				agentName: "context-analyst",
				agentVersion: CONTEXT_PROMPT_VERSION,
			},
			fn,
		);
	};
	const json = (v: unknown): string => JSON.stringify(v);
	// One SDK tool per spec in ./tools: every call is budget-capped, tracked
	// (metadata only), and resolves the JSON the model reads.
	const ctxTool = <S extends z.ZodObject>(spec: {
		name: string;
		description: string;
		parameters: S;
		run(ctx: typeof tools.ctx, args: z.infer<S>): unknown;
		view?(result: unknown): unknown;
	}) =>
		sdkTool({
			name: spec.name,
			description: spec.description,
			parameters: spec.parameters,
			execute: async (args) =>
				track(spec.name, async () => {
					const result = await spec.run(tools.ctx, args);
					return json(spec.view ? spec.view(result) : result);
				}),
		});
	const list = [
		ctxTool(getCaseFacts),
		ctxTool(getCustomerSummary),
		ctxTool(listAccounts),
		ctxTool(getTransactions),
		ctxTool(getCashflowMetrics),
		ctxTool(getApplicationFinancials),
		ctxTool(getDocumentFindings),
		ctxTool(getCreditHistory),
		ctxTool(getExternalReports),
		ctxTool(getKycChecks),
		ctxTool(getLoans),
		ctxTool(getExternalResearchSummary),
	];
	const agent = new Agent({
		// Model + eval: docs/eval/research/CONTEXT-MODELS-RESULTS.md.
		name: "context-analyst",
		instructions: CONTEXT_SYSTEM,
		model: new OpenAIChatCompletionsModel(
			openai as unknown as AgentsOpenAIClient,
			env.contextModel,
		),
		// The initial stage is a real read-only tool loop. Repair is
		// deliberately tool-less: it may only reuse the exact snapshots and
		// evidence the initial run observed (injected into its prompt).
		tools: exposeTools ? list : [],
		outputType: contextModelOutputSchema,
		modelSettings: {
			temperature: env.contextTemperature,
			maxTokens: env.contextMaxOutputTokens,
			...(exposeTools ? {} : { toolChoice: "none" }),
		},
	});
	const runner = new Runner();
	try {
		const result = await observability.trackModelCall(
			{
				runId,
				model: env.contextModel,
				operation: "generateText",
				agentName: "context-analyst",
				agentVersion: CONTEXT_PROMPT_VERSION,
			},
			() =>
				runner.run(agent, prompt, {
					maxTurns: isRepair ? 4 : env.contextMaxTurns,
					signal: input.signal,
				}),
		);
		if (result.finalOutput === null || result.finalOutput === undefined) {
			throw new Error("context model returned no structured output");
		}
		return {
			output: result.finalOutput,
			usage: readRunUsage(result),
			modelBudgetExceeded: budget.exceeded,
		};
	} catch (err) {
		if (err instanceof ContextToolError || err instanceof ContextUnavailableError) throw err;
		if (input.signal.aborted) throw new ContextTimeoutError("context stage timed out");
		throw new ContextUnavailableError(
			err instanceof Error ? err.message : "context model call failed",
		);
	}
}

/** Deterministic test double: scripted raw outputs + snapshots, no network. */
export function stubContextRunner(scenario: {
	outputs: unknown[];
	snapshots?: CandidateSnapshot[];
	seenEvidence?: Map<string, Set<string>>;
	usage?: Partial<ContextUsage>;
	throw?: Error;
	repairThrow?: Error;
	toolFailures?: Array<{ tool: string; reason: string }>;
	modelBudgetExceeded?: boolean;
}): ContextAgentRunner & { calls: number; repairCalls: number } {
	let calls = 0;
	let repairCalls = 0;
	let cursor = 0;
	const next = (): unknown => {
		const out = scenario.outputs[Math.min(cursor, scenario.outputs.length - 1)];
		cursor += 1;
		return out;
	};
	return {
		get calls() {
			return calls;
		},
		get repairCalls() {
			return repairCalls;
		},
		async runContext() {
			calls += 1;
			if (scenario.throw) throw scenario.throw;
			return {
				output: next(),
				usage: { inputTokens: 50, outputTokens: 50, toolCalls: 3, ...scenario.usage },
				snapshots: (scenario.snapshots ?? []).map((s) => ({ ...s })),
				seenEvidence: new Map(scenario.seenEvidence ?? []),
				model: "test-context-model",
				toolFailures: scenario.toolFailures ?? [],
				modelBudgetExceeded: scenario.modelBudgetExceeded ?? false,
			};
		},
		async repairContext() {
			repairCalls += 1;
			if (scenario.repairThrow) throw scenario.repairThrow;
			const usage = { inputTokens: 50, outputTokens: 50, toolCalls: 0 };
			return { output: next(), usage };
		},
	};
}
