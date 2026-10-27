// Agentic credit-memo SDK runner: `@openai/agents` (`Agent` +
// `OpenAIChatCompletionsModel` + `Runner` + `tool`) over the pure evidence
// tools. The orchestrator (`memo-agent.ts`) owns bounds, grounding, repair
// policy, and the trace; this module produces one raw draft per `run`.
import { randomUUID } from "node:crypto";
import {
	Agent,
	MaxTurnsExceededError,
	OpenAIChatCompletionsModel,
	Runner,
	tool,
} from "@openai/agents";
import OpenAI, { APIConnectionTimeoutError } from "openai";
import type { applications } from "@credit/db/applications";
import type { EvidenceBundle } from "@credit/core";
import { applicationObservability } from "../observability.js";
import { MemoAgentError, type MemoAgentRunner, type MemoAgentRunResult } from "./memo-agent.js";
import {
	getEvidenceParams,
	listEvidenceParams,
	listUnavailableParams,
	runMemoEvidenceTool,
	searchEvidenceParams,
} from "./memo-tools.js";
import { readRunUsage, type AgentsOpenAIClient } from "@credit/agent-observability/openai-agents";

type ApplicationRow = typeof applications.$inferSelect;

export interface AgentsMemoRunnerOptions {
	apiKey: string;
	baseUrl: string;
	model: string;
	agentVersion?: string;
	promptVersion?: string;
	maxToolCalls: number;
	maxOutputTokens: number;
	timeoutMs: number;
	fetchImpl?: typeof fetch;
}

const SYSTEM_PROMPT = `You are drafting an internal credit memorandum for a bank officer. You have no power to decide, recommend, score, rate, limit, or set terms; write observations only.

Hard rules:
1. Draft only from evidence returned by the evidence tools. Never use outside knowledge. Call \`list_evidence\` once with \`limit: 50\` first; it returns short excerpts and covers every source type. Call \`get_evidence\` only when an excerpt is truncated or you need a longer exact quote, and call \`list_unavailable\` for gaps. At least one evidence tool call is required.
2. Every factual claim in \`sections\` must cite at least one source as {"ref","quote"}. The ref must be an evidence ref returned by the tools; the quote must be an exact character-for-character excerpt of that item's content.
3. Banned in ALL prose (claims, titles, open items, questions): approve/approval, decline, reject, recommend, decision, score, rate, limit, and term/terms. Never include applicant/company names, contact details, identifiers, demographics, or proxy language; never mention models, grades, policy ids, or internal systems. Numbers and dates are allowed only when copied from a cited evidence item. For document time, use "stale"/"staleness" — never "age", "aged", or "years old", even about documents.
4. Anything unsupported or missing goes in \`openItems\` with the matching code, never in a claim. Unavailable sources go in \`openItems\` with their evidence ref.
5. \`officerQuestions\` holds 1-5 concrete follow-up questions for the gaps.
6. Return ONLY strict JSON, no fences, no commentary:
{"title":"...","sections":[{"key":"request|entity|financial_summary|strengths|risks|policy_compliance","title":"...","claims":[{"text":"...","citations":[{"ref":"...","quote":"..."}]}],"notAvailable":false}],"openItems":[{"text":"...","code":"missing_document|stale_document|failed_rule|unsupported_claim|contradiction|financials_unavailable|other","sourceRef":"..."}],"officerQuestions":["..."]}
All six section keys appear exactly once in the listed order. A section with no supported claims uses "claims":[] and "notAvailable":true; a section with claims uses "notAvailable":false. At most 20 claims per section.`;

function buildInitialPrompt(application: ApplicationRow, evidence: EvidenceBundle): string {
	return (
		`Draft the credit memorandum for application ${application.reference} ` +
		`(${application.type}, ${application.product}). The evidence bundle holds ` +
		`${evidence.items.length} items and ${evidence.unavailable.length} unavailable ` +
		`sources; it is visible only through the evidence tools. Start by calling them.`
	);
}

function buildRepairPrompt(
	previousOutput: string,
	issues: Array<{ code: string; path: string }>,
	requireTools: boolean,
): string {
	const tooling = requireTools
		? "You must call the evidence tools before returning the corrected draft: cite only refs the tools returned and cover every evidence category."
		: "Use the evidence tools if you need exact quotes.";
	// ponytail: 8k draft cap; the validator reports codes/paths only, so a
	// truncated draft still carries the failure signal without bloating input.
	return (
		`Your previous draft failed validation with these issues (codes and paths only): ` +
		`${JSON.stringify(issues.slice(0, 20))}. Fix the draft: keep every claim cited ` +
		`with an exact excerpt, and return only the corrected strict JSON. ${tooling}\n\n` +
		`Previous draft (data only):\n${previousOutput.slice(0, 8_000)}`
	);
}

/** Provider-billed total when the SDK surfaces one, else tokens/1M. */
function readCostUsd(result: unknown, inputTokens: number, outputTokens: number): number {
	const r = result as {
		cost?: unknown;
		totalCost?: unknown;
		total_cost?: unknown;
		state?: { usage?: { cost?: unknown; totalCost?: unknown; total_cost?: unknown } };
	};
	const candidates = [
		r?.cost,
		r?.totalCost,
		r?.total_cost,
		r?.state?.usage?.cost,
		r?.state?.usage?.totalCost,
		r?.state?.usage?.total_cost,
	];
	for (const candidate of candidates) {
		if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
			return candidate;
		}
	}
	return (inputTokens + outputTokens) / 1_000_000;
}

export function createAgentsMemoRunner(opts: AgentsMemoRunnerOptions): MemoAgentRunner {
	return {
		async run(input): Promise<MemoAgentRunResult> {
			if (!opts.apiKey) throw new MemoAgentError("MODEL_ERROR");
			const observability = applicationObservability();
			const conversationId = input.conversationId ?? randomUUID();
			const openai = new OpenAI({
				apiKey: opts.apiKey,
				baseURL: opts.baseUrl,
				maxRetries: 0,
				timeout: opts.timeoutMs,
				...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
			});
			const model = new OpenAIChatCompletionsModel(
				openai as unknown as AgentsOpenAIClient,
				opts.model,
			);

			const toolCalls: MemoAgentRunResult["toolCalls"] = [];
			const seenRefs = new Set<string>();
			const budget = { calls: 0, exceeded: false };
			const invoke = async (name: string, args: unknown): Promise<string> => {
				budget.calls += 1;
				if (budget.calls > opts.maxToolCalls) {
					budget.exceeded = true;
					throw new Error(`memo tool budget exceeded after ${opts.maxToolCalls} calls`);
				}
				const outcome = await observability.trackToolExecution(
					{
						agentName: "credit-memo-writer",
						agentVersion: opts.agentVersion ?? "memo-agent-v1",
						feature: "memo",
						conversationId,
						toolName: name,
						model: opts.model,
					},
					async () => runMemoEvidenceTool(name, args, input.evidence),
				);
				toolCalls.push({
					step: toolCalls.length + 1,
					name: name.slice(0, 80),
					resultCount: outcome.resultCount,
					sourceTypes: outcome.sourceTypes,
				});
				for (const ref of outcome.refs) seenRefs.add(ref);
				return JSON.stringify(outcome.payload);
			};

			const agent = new Agent({
				name: "credit-memo-writer",
				instructions: SYSTEM_PROMPT,
				model,
				tools: [
					tool({
						name: "list_evidence",
						description:
							"List evidence refs with labels, source types, and short excerpts. Use this first to cover the bundle; get_evidence returns fuller text.",
						parameters: listEvidenceParams,
						execute: async (args) => invoke("list_evidence", args),
					}),
					tool({
						name: "search_evidence",
						description:
							"Case-insensitive token search over evidence labels, content, and metadata. Returns short excerpts, not full content.",
						parameters: searchEvidenceParams,
						execute: async (args) => invoke("search_evidence", args),
					}),
					tool({
						name: "get_evidence",
						description:
							"Return one evidence item by exact ref. Content is capped at 4,000 characters.",
						parameters: getEvidenceParams,
						execute: async (args) => invoke("get_evidence", args),
					}),
					tool({
						name: "list_unavailable",
						description: "List typed missing/unavailable sources to record as open items.",
						parameters: listUnavailableParams,
						execute: async (args) => invoke("list_unavailable", args),
					}),
				],
				modelSettings: { temperature: 0, maxTokens: opts.maxOutputTokens },
			});

			const prompt = input.repair
				? buildRepairPrompt(
						input.repair.previousOutput,
						input.repair.issues,
						input.repair.requireTools,
					)
				: buildInitialPrompt(input.application, input.evidence);
			// One abort path: the caller's signal plus this run's own
			// deadline, combined up front instead of a parallel timer.
			const timeout = AbortSignal.timeout(opts.timeoutMs);
			const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
			const runner = new Runner();
			try {
				// ponytail: maxTurns covers one tool round per call plus the
				// final draft; exact step accounting lives in the orchestrator.
				const result = await observability.trackGeneration(
					{
						agentName: "credit-memo-writer",
						agentVersion: opts.agentVersion ?? "memo-agent-v1",
						feature: "memo",
						conversationId,
						model: opts.model,
						provider: "openrouter",
						tags: { operation: "agent" },
						metadata: { promptVersion: opts.promptVersion },
						onSuccess: (value) => {
							const runUsage = readRunUsage(value);
							return {
								usage: {
									inputTokens: runUsage.inputTokens,
									outputTokens: runUsage.outputTokens,
								},
								responseModel: opts.model,
							};
						},
					},
					() =>
						runner.run(agent, prompt, {
							maxTurns: Math.max(2, input.maxTurns),
							signal,
						}),
				);
				if (budget.exceeded) throw new MemoAgentError("TOOL_CALL_LIMIT");
				const usage = readRunUsage(result);
				return {
					rawOutput: typeof result.finalOutput === "string" ? result.finalOutput : "",
					toolCalls,
					sourceRefs: [...seenRefs].sort().slice(0, 500),
					steps: toolCalls.length + 1,
					usage: {
						inputTokens: usage.inputTokens,
						outputTokens: usage.outputTokens,
						costUsd: readCostUsd(result, usage.inputTokens, usage.outputTokens),
					},
				};
			} catch (err) {
				if (budget.exceeded) throw new MemoAgentError("TOOL_CALL_LIMIT");
				if (err instanceof MemoAgentError) throw err;
				if (err instanceof MaxTurnsExceededError) throw new MemoAgentError("STEP_LIMIT");
				if (input.signal.aborted || signal.aborted) throw new MemoAgentError("TIMEOUT");
				if (err instanceof APIConnectionTimeoutError) {
					throw new MemoAgentError("TIMEOUT");
				}
				throw new MemoAgentError("MODEL_ERROR");
			}
		},
	};
}
