// OpenAI Agents SDK runner for the integrity analysis/triage loop.
//
// Mirrors the memo-writer runner: one raw draft per `run`, allowlisted
// tools only, temperature 0, no SDK tracing, and typed errors. The
// orchestrator owns validation, repair, and the persisted trace. Advisory
// only: no output reaches a score, decision, term, or booking.

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
import { buildInitialPrompt, buildRepairPrompt, buildSystemPrompt } from "./prompts.js";
import {
	INTEGRITY_TOOL_NAMES,
	integrityToolConfig,
	makeToolCall,
	runIntegrityTool,
} from "./tools/index.js";
import {
	IntegrityAgentError,
	type IntegrityAgentRunner,
	type IntegrityAgentRunResult,
	type IntegrityToolCall,
} from "../../integrity/types.js";

export const definition = defineAgent({
	name: "integrity",
	owner: "applications",
	description:
		"Extracts document facts and cross-document candidate contradictions, and drafts the advisory brief for flagged cases. Deterministic validators confirm every quote and consistency; nothing here decides or scores.",
	model: { env: "DOCUMENT_INTEGRITY_MODEL", default: "openai/gpt-6.1-sol" },
	// Brief runs additionally need DOCUMENT_INTEGRITY_TRIAGE_ENABLED
	// (triage prompt version DOCUMENT_INTEGRITY_TRIAGE_PROMPT_VERSION, default integrity-triage-v1).
	flags: [
		"DOCUMENT_INTEGRITY_ENABLED",
		"DOCUMENT_INTEGRITY_AGENT_ENABLED",
		"DOCUMENT_INTEGRITY_TRIAGE_ENABLED",
	],
	versions: { prompt: "integrity-analysis-v1", agent: "integrity-agent-v1" },
	tools: INTEGRITY_TOOL_NAMES,
	execution: "temporal",
});

const AGENT_NAME = "document-integrity-agent";

export interface AgentsIntegrityRunnerOptions {
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

export function createAgentsIntegrityRunner(
	opts: AgentsIntegrityRunnerOptions,
): IntegrityAgentRunner {
	return {
		async run(input): Promise<IntegrityAgentRunResult> {
			if (!opts.apiKey) throw new IntegrityAgentError("AGENT_UNAVAILABLE");
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
			const toolCalls: IntegrityToolCall[] = [];
			const seenRefs = new Set<string>();
			const budget = createToolBudget(opts.maxToolCalls, "integrity");
			const generateBrief = input.generateBrief === true;
			const toolMode = generateBrief ? "triage" : "analysis";
			const invoke = async (name: string, args: unknown): Promise<string> => {
				budget.consume();
				const outcome = await observability.trackToolExecution(
					{
						agentName: AGENT_NAME,
						agentVersion: opts.agentVersion ?? "integrity-agent-v1",
						feature: "document_integrity",
						conversationId,
						toolName: name,
						model: opts.model,
					},
					async () => runIntegrityTool(name, args, input.source, toolMode),
				);
				toolCalls.push(makeToolCall(toolCalls.length + 1, name, outcome));
				for (const ref of outcome.refs) seenRefs.add(ref);
				return JSON.stringify(outcome.payload);
			};

			const tools = INTEGRITY_TOOL_NAMES.filter((name) => {
				if (!generateBrief) {
					return (
						name !== "get_duplicate_context" &&
						name !== "list_customer_evidence" &&
						name !== "get_customer_page"
					);
				}
				return true;
			}).map((name) => {
				const config = integrityToolConfig(name);
				return tool({
					name,
					description: config.description,
					parameters: config.parameters as never,
					execute: async (args: unknown) => invoke(name, args),
				});
			});

			const agent = new Agent({
				// Model + eval: docs/eval/applications/INTEGRITY-MODELS-RESULTS.md.
				name: AGENT_NAME,
				instructions: buildSystemPrompt(generateBrief),
				model,
				tools,
				modelSettings: { temperature: 0, maxTokens: opts.maxOutputTokens },
			});

			const prompt = input.repair
				? buildRepairPrompt(input.repair.previousOutput, input.repair.issues)
				: buildInitialPrompt(input.source, generateBrief);
			const signal = withDeadline(input.signal, opts.timeoutMs);
			const runner = new Runner();
			try {
				const result = await observability.trackGeneration(
					{
						agentName: AGENT_NAME,
						agentVersion: opts.agentVersion ?? "integrity-agent-v1",
						feature: "document_integrity",
						conversationId,
						model: opts.model,
						provider: "openrouter",
						tags: { operation: "agent" },
						metadata: { generateBrief, promptVersion: opts.promptVersion },
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
				if (budget.exceeded) throw new IntegrityAgentError("TOOL_CALL_LIMIT");
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
				if (budget.exceeded) throw new IntegrityAgentError("TOOL_CALL_LIMIT");
				if (err instanceof IntegrityAgentError) throw err;
				if (err instanceof MaxTurnsExceededError) throw new IntegrityAgentError("STEP_LIMIT");
				if (signal.aborted || input.signal?.aborted) throw new IntegrityAgentError("TIMEOUT");
				if (err instanceof APIConnectionTimeoutError) throw new IntegrityAgentError("TIMEOUT");
				throw new IntegrityAgentError("MODEL_ERROR");
			}
		},
	};
}
