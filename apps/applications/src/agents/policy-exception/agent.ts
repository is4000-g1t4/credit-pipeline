// E3 policy-exception model runner.
//
// The provider used by this demo does not reliably honor tool calls, so the
// orchestrator (`orchestrator.ts`) prefetches the allowlisted rule/policy
// tools and this module asks the model for one grounded draft over that
// data. The orchestrator owns bounds, grounding, the one repair, and the
// trace; this module only performs one chat completion. Advisory only: no
// output reaches a score, decision, term, or booking.
import { randomUUID } from "node:crypto";
import { APIConnectionTimeoutError } from "openai";
import { defineAgent } from "@credit/agent-kit";
import type { Logger } from "@credit/service-kit";
import { applicationObservability } from "../../observability.js";
import { createAgentClient, withDeadline } from "../shared/runtime.js";
import { PolicyExceptionAgentError } from "./orchestrator.js";
import { buildInitialPrompt, buildRepairPrompt, MEMO_MODE, SYSTEM_PROMPT } from "./prompts.js";
import type {
	PolicyClient,
	PolicyExceptionAgentRunner,
	PolicyExceptionAgentRunResult,
} from "./types.js";

export const definition = defineAgent({
	name: "policy-exception",
	owner: "applications",
	description:
		"Single-shot drafter: one completion over prefetched rule facts and policy sections (explain, follow-up, memo). No model-callable tools; the deterministic prefetch tools run in code. Advisory; validators ground every citation.",
	model: { env: "POLICY_EXCEPTION_MODEL", default: "openai/gpt-6.1-terra" },
	flags: ["ASSIST_POLICY_EXCEPTION_ENABLED"],
	versions: {
		prompt: "policy-exception-v1",
		agent: "policy-exception-agent-v1",
		validator: "policy-exception-validator-v1",
	},
	tools: [],
	execution: "request",
});

export interface PolicyExceptionSdkOptions {
	apiKey: string;
	baseUrl: string;
	model: string;
	agentName?: string;
	feature?: string;
	artifactType?: string;
	agentVersion?: string;
	promptVersion?: string;
	validatorVersion?: string;
	maxToolCalls: number;
	maxOutputTokens: number;
	timeoutMs: number;
	policyClient: PolicyClient;
	actorId: string;
	actorRole: string;
	fetchImpl?: typeof fetch;
	logger?: Pick<Logger, "warn">;
}

interface CompletionResult {
	choices?: Array<{
		message?: { content?: string | null };
		finish_reason?: string;
	}>;
	usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

// Model + eval: docs/eval/applications/POLICY-EXCEPTION-MODELS-RESULTS.md.
export function createAgentsPolicyExceptionRunner(
	opts: PolicyExceptionSdkOptions,
): PolicyExceptionAgentRunner {
	const agentName = opts.agentName ?? "policy-exception-navigator";
	const feature = opts.feature ?? "policy_exception";
	return {
		async run(input): Promise<PolicyExceptionAgentRunResult> {
			if (!opts.apiKey) throw new PolicyExceptionAgentError("MODEL_ERROR");
			const observability = applicationObservability();
			const conversationId = input.conversationId ?? randomUUID();
			const openai = createAgentClient({
				apiKey: opts.apiKey,
				baseUrl: opts.baseUrl,
				timeoutMs: opts.timeoutMs,
				agent: agentName,
				...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
				...(opts.logger ? { logger: opts.logger } : {}),
			});
			const prompt = input.repair
				? buildRepairPrompt(
						input.repair.previousOutput,
						input.repair.issues,
						input.repair.requireTools,
					)
				: buildInitialPrompt(
						input.mode,
						input.context,
						input.question,
						input.evidence,
						input.catalog,
					);
			const runSignal = withDeadline(input.signal, opts.timeoutMs);
			try {
				const result = await observability.trackGeneration(
					{
						agentName,
						agentVersion: opts.agentVersion ?? "policy-exception-agent-v1",
						feature,
						conversationId,
						model: opts.model,
						provider: "openrouter",
						tags: {
							operation: "agent",
							...(opts.artifactType ? { artifactType: opts.artifactType } : {}),
						},
						metadata: {
							promptVersion: opts.promptVersion,
							validatorVersion: opts.validatorVersion,
						},
						onSuccess: (value: unknown) => {
							const usage = (value as CompletionResult).usage;
							return {
								usage: {
									inputTokens: usage?.prompt_tokens ?? 0,
									outputTokens: usage?.completion_tokens ?? 0,
								},
								responseModel: opts.model,
							};
						},
					},
					() =>
						(
							openai.chat.completions.create as unknown as (
								body: unknown,
								options?: unknown,
							) => Promise<unknown>
						)(
							{
								model: opts.model,
								temperature: 0,
								max_tokens: opts.maxOutputTokens,
								response_format: { type: "json_object" },
								messages: [
									{
										role: "system",
										content: input.mode === "memo" ? `${SYSTEM_PROMPT}${MEMO_MODE}` : SYSTEM_PROMPT,
									},
									{ role: "user", content: prompt },
								],
							},
							{ signal: runSignal },
						),
				);
				const completion = result as CompletionResult;
				const rawOutput = completion.choices?.[0]?.message?.content ?? "";
				const inputTokens = completion.usage?.prompt_tokens ?? 0;
				const outputTokens = completion.usage?.completion_tokens ?? 0;
				const costUsd =
					typeof completion.usage?.cost === "number"
						? completion.usage.cost
						: (inputTokens + outputTokens) / 1_000_000;
				return {
					rawOutput,
					toolCalls: [],
					sourceRefs: [],
					policySections: [],
					steps: 1,
					usage: { inputTokens, outputTokens, costUsd },
				};
			} catch (err) {
				if (input.signal?.aborted || runSignal.aborted) {
					throw new PolicyExceptionAgentError("TIMEOUT");
				}
				if (err instanceof APIConnectionTimeoutError) {
					throw new PolicyExceptionAgentError("TIMEOUT");
				}
				throw new PolicyExceptionAgentError("MODEL_ERROR");
			}
		},
	};
}
