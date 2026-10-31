// Agentic credit-memo SDK runner: `@openai/agents` (`Agent` +
// `OpenAIChatCompletionsModel` + `Runner` + `tool`) over the pure evidence
// tools. The orchestrator (`orchestrator.ts`) owns bounds, grounding,
// repair policy, and the trace; this module produces one raw draft per
// `run`. Advisory only: no output reaches a score, decision, term, or booking.
import { randomUUID } from "node:crypto";
import {
	Agent,
	MaxTurnsExceededError,
	OpenAIChatCompletionsModel,
	Runner,
	tool,
} from "@openai/agents";
import { APIConnectionTimeoutError } from "openai";
import { defineAgent } from "@credit/agent-kit";
import { readRunUsage, type AgentsOpenAIClient } from "@credit/agent-observability/openai-agents";
import type { Logger } from "@credit/service-kit";
import { applicationObservability } from "../../observability.js";
import {
	createAgentClient,
	createToolBudget,
	readCostUsd,
	withDeadline,
} from "../shared/runtime.js";
import { MemoAgentError, type MemoAgentRunner, type MemoAgentRunResult } from "./orchestrator.js";
import { buildInitialPrompt, buildRepairPrompt, SYSTEM_PROMPT } from "./prompts.js";
import {
	MEMO_TOOL_NAMES,
	getEvidenceDescription,
	getEvidenceParams,
	listEvidenceDescription,
	listEvidenceJsonParams,
	listUnavailableDescription,
	listUnavailableParams,
	runMemoEvidenceTool,
	searchEvidenceDescription,
	searchEvidenceJsonParams,
} from "./tools/index.js";

export const definition = defineAgent({
	name: "memo-writer",
	owner: "applications",
	description:
		"Drafts the internal credit memorandum prose from tool-fetched evidence only. Advisory; deterministic validators ground every claim.",
	model: { env: "ASSIST_MEMO_MODEL", default: "openai/gpt-6.1-sol" },
	// ASSIST_MEMO_WRITER must be "agent" (default "deterministic").
	flags: ["ASSIST_ENABLED", "ASSIST_MEMO_WRITER"],
	versions: { prompt: "memo-agent-v1", agent: "memo-agent-v1" },
	tools: MEMO_TOOL_NAMES,
	execution: "request",
});

const AGENT_NAME = "credit-memo-writer";

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
	logger?: Pick<Logger, "warn">;
}

// Model + scripted eval (not model-compared):
// docs/eval/applications/MEMO-AGENT-RESULTS.md.
export function createAgentsMemoRunner(opts: AgentsMemoRunnerOptions): MemoAgentRunner {
	return {
		async run(input): Promise<MemoAgentRunResult> {
			if (!opts.apiKey) throw new MemoAgentError("MODEL_ERROR");
			const observability = applicationObservability();
			const conversationId = input.conversationId ?? randomUUID();
			const openai = createAgentClient({
				apiKey: opts.apiKey,
				baseUrl: opts.baseUrl,
				timeoutMs: opts.timeoutMs,
				agent: definition.name,
				...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
				...(opts.logger ? { logger: opts.logger } : {}),
			});
			const model = new OpenAIChatCompletionsModel(
				openai as unknown as AgentsOpenAIClient,
				opts.model,
			);

			const toolCalls: MemoAgentRunResult["toolCalls"] = [];
			const seenRefs = new Set<string>();
			const budget = createToolBudget(opts.maxToolCalls, "memo");
			const invoke = async (name: string, args: unknown): Promise<string> => {
				budget.consume();
				const outcome = await observability.trackToolExecution(
					{
						agentName: AGENT_NAME,
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
				name: AGENT_NAME,
				instructions: SYSTEM_PROMPT,
				model,
				tools: [
					tool({
						name: "list_evidence",
						description: listEvidenceDescription,
						parameters: listEvidenceJsonParams,
						strict: false,
						execute: async (args) => invoke("list_evidence", args),
					}),
					tool({
						name: "search_evidence",
						description: searchEvidenceDescription,
						parameters: searchEvidenceJsonParams,
						strict: false,
						execute: async (args) => invoke("search_evidence", args),
					}),
					tool({
						name: "get_evidence",
						description: getEvidenceDescription,
						parameters: getEvidenceParams,
						execute: async (args) => invoke("get_evidence", args),
					}),
					tool({
						name: "list_unavailable",
						description: listUnavailableDescription,
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
			const signal = withDeadline(input.signal, opts.timeoutMs);
			const runner = new Runner();
			try {
				// ponytail: maxTurns covers one tool round per call plus the
				// final draft; exact step accounting lives in the orchestrator.
				const result = await observability.trackGeneration(
					{
						agentName: AGENT_NAME,
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
