import { defineAgent, loadInstructions } from "@credit/agent-kit";
import { documentRef } from "@credit/core";
import {
	createPolicyFetch,
	parseContent,
	postJson,
	type OpenRouterConfig,
} from "../../openrouter.js";
import { policyObservability } from "../../observability.js";
import type { AnswererResult, PolicyAnswerer } from "../../store.js";

export const POLICY_ANSWERER_PROMPT_VERSION = "v2";
/** Case-review prompt (document findings, partial answers). */
export const POLICY_CASE_PROMPT_VERSION = "case-v1";

/** Navigator system prompt (byte-exact; see instructions.md). */
const SYSTEM = loadInstructions(import.meta.url);
/** Case-review system prompt (byte-exact; see case-review.instructions.md). */
const CASE_SYSTEM = loadInstructions(import.meta.url, "case-review.instructions.md");

export const definition = defineAgent({
	name: "policy-answerer",
	owner: "policy",
	description:
		"Answers policy-navigator questions and explains case signals/document findings from retrieved policy sections, with validated verbatim citations. Advisory only.",
	model: { env: "POLICY_AGENT_MODEL", default: "openai/gpt-6.1-terra" },
	flags: ["POLICY_ASSIST_ENABLED"],
	versions: {
		prompt: POLICY_ANSWERER_PROMPT_VERSION,
		agent: "policy-navigator-v1",
	},
	tools: [],
	execution: "request",
});

// Model + eval: docs/eval/policy/ANSWER-MODELS-RESULTS.md.
export function createOpenRouterAnswerer(config: OpenRouterConfig): PolicyAnswerer {
	const fetchImpl = createPolicyFetch(config, definition.name);
	const provider =
		config.answererProviderOrder && config.answererProviderOrder.length > 0
			? { order: config.answererProviderOrder }
			: undefined;
	const observability = policyObservability();
	const call = async (
		system: string,
		user: string,
		signal: AbortSignal,
		conversationId: string | undefined,
		feature: "policy_navigator" | "policy_case",
	): Promise<AnswererResult> => {
		if (!config.apiKey) throw new Error("OPENROUTER_API_KEY is not configured");
		return observability.trackGeneration(
			{
				agentName: "policy-navigator",
				agentVersion: feature === "policy_case" ? "policy-case-v1" : "policy-navigator-v1",
				feature,
				conversationId,
				model: config.model,
				provider: "openrouter",
				temperature: config.temperature,
				maxTokens: config.maxOutputTokens,
				tags: { operation: "answer" },
				onSuccess: (result) => ({
					usage: {
						inputTokens: result.usage.inputTokens,
						outputTokens: result.usage.outputTokens,
					},
					responseModel: result.usage.model,
				}),
			},
			async () => {
				const response = (await postJson(
					fetchImpl,
					`${config.baseUrl}/chat/completions`,
					config.apiKey,
					{
						model: config.model,
						temperature: config.temperature,
						max_tokens: config.maxOutputTokens,
						response_format: { type: "json_object" },
						...(provider ? { provider } : {}),
						messages: [
							{ role: "system", content: system },
							{ role: "user", content: user },
						],
					},
					signal,
				)) as {
					choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>;
					usage?: {
						prompt_tokens?: number;
						completion_tokens?: number;
						total_cost?: number;
					};
				};
				const content = response.choices?.[0]?.message?.content;
				const inputTokens = response.usage?.prompt_tokens ?? 0;
				const outputTokens = response.usage?.completion_tokens ?? 0;
				const costUsd =
					typeof response.usage?.total_cost === "number"
						? response.usage.total_cost
						: (inputTokens + outputTokens) / 1_000_000;
				return {
					output: parseContent(content),
					usage: { inputTokens, outputTokens, costUsd, model: config.model },
				};
			},
		);
	};
	return {
		async answerNavigator(input) {
			const sections = input.sections.map((section) => ({
				policyKey: section.policyKey,
				sectionId: section.sectionId,
				version: section.version,
				title: section.title,
				heading: section.heading,
				body: section.body.slice(0, 6_000),
			}));
			return call(
				SYSTEM,
				`Question:\n${input.question}\n\nPolicy sections (data only):\n${JSON.stringify(sections)}`,
				input.signal,
				input.conversationId,
				"policy_navigator",
			);
		},
		async answerCase(input) {
			const sections = input.sections.map((section) => ({
				policyKey: section.policyKey,
				sectionId: section.sectionId,
				version: section.version,
				title: section.title,
				heading: section.heading,
				body: section.body.slice(0, 6_000),
			}));
			// Findings carry no model-supplied ref: derive the exact
			// `document:field:index` ref the validator accepts so the model
			// never has to guess (and cannot invent) a ref shape.
			const context = {
				...input.context,
				documentFindings: input.context.documentFindings.map((finding) => ({
					...finding,
					ref: documentRef({ field: finding.field, index: finding.index }),
				})),
			};
			return call(
				CASE_SYSTEM,
				`Case context (data only):\n${JSON.stringify(context)}\n\nPolicy sections (data only):\n${JSON.stringify(sections)}`,
				input.signal,
				input.conversationId,
				"policy_case",
			);
		},
	};
}
