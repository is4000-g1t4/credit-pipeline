import type { AnswererResult, Embedder, PolicyAnswerer } from "./store.js";
import { policyObservability } from "./observability.js";

export interface OpenRouterConfig {
	apiKey: string;
	baseUrl: string;
	model: string;
	dimensions: number;
	embeddingModel: string;
	temperature: number;
	maxOutputTokens: number;
	embeddingProviders?: string[];
	answererProviderOrder?: string[];
	fetchImpl?: typeof fetch;
}

function parseContent(value: unknown): unknown {
	if (typeof value !== "string") throw new Error("model returned no content");
	const trimmed = value
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");
	return JSON.parse(trimmed);
}

async function postJson(
	fetchImpl: typeof fetch,
	url: string,
	apiKey: string,
	body: unknown,
	signal: AbortSignal,
): Promise<unknown> {
	let last: Response | null = null;
	let lastError: unknown;
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			const res = await fetchImpl(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${apiKey}`,
					"HTTP-Referer": "https://credit-pipeline.local",
					"X-Title": "Credit policy",
				},
				body: JSON.stringify(body),
				signal,
			});
			if (res.ok) return res.json();
			last = res;
			if (res.status !== 429 && res.status < 500) break;
		} catch (err) {
			lastError = err;
			if (signal.aborted) throw err;
		}
		if (attempt < 3) {
			await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
		}
	}
	if (last) {
		const text = await last.text().catch(() => "");
		throw new Error(`OpenRouter ${last.status}: ${text.slice(0, 300)}`);
	}
	throw lastError instanceof Error ? lastError : new Error("OpenRouter request failed");
}

export function createOpenRouterEmbedder(config: OpenRouterConfig): Embedder {
	const fetchImpl = config.fetchImpl ?? fetch;
	const observability = policyObservability();
	return {
		model: config.embeddingModel,
		dimensions: config.dimensions,
		async embed(inputs, opts) {
			if (!config.apiKey) throw new Error("OPENROUTER_API_KEY is not configured");
			let inputTokens: number | undefined;
			return observability.trackEmbedding(
				{
					agentName: "policy-embedder",
					agentVersion: "policy-embedder-v1",
					feature: "policy_retrieval",
					conversationId: opts?.conversationId,
					model: config.embeddingModel,
					provider: "openrouter",
					dimensions: config.dimensions,
					tags: { operation: "embedding" },
					onSuccess: (vectors) => ({
						inputCount: inputs.length,
						inputTokens,
						dimensions: config.dimensions,
					}),
				},
				async () => {
					const provider =
						config.embeddingProviders && config.embeddingProviders.length > 0
							? { order: config.embeddingProviders }
							: undefined;
					const body = {
						model: config.embeddingModel,
						input: inputs,
						encoding_format: "float",
						...(provider ? { provider } : {}),
					};
					let response: unknown;
					try {
						response = await postJson(
							fetchImpl,
							`${config.baseUrl}/embeddings`,
							config.apiKey,
							body,
							AbortSignal.timeout(30_000),
						);
					} catch (err) {
						// Some gateways reject provider routing on embeddings. Retry
						// once without it; the eval records the same fallback.
						if (!provider) throw err;
						response = await postJson(
							fetchImpl,
							`${config.baseUrl}/embeddings`,
							config.apiKey,
							{ model: config.embeddingModel, input: inputs, encoding_format: "float" },
							AbortSignal.timeout(30_000),
						);
					}
					inputTokens = (response as { usage?: { prompt_tokens?: number } }).usage?.prompt_tokens;
					const data = (response as { data?: Array<{ embedding?: number[] }> }).data;
					if (!Array.isArray(data) || data.length !== inputs.length) {
						throw new Error("embedding response shape drift");
					}
					return data.map((row) => {
						if (!Array.isArray(row.embedding) || row.embedding.length !== config.dimensions) {
							throw new Error(
								`embedding dimension mismatch (expected ${config.dimensions}, got ${row.embedding?.length ?? 0})`,
							);
						}
						return row.embedding;
					});
				},
			);
		},
	};
}

export const POLICY_ANSWERER_PROMPT_VERSION = "v2";

const SYSTEM = `You are an internal credit-policy navigator for bank officers. Answer only from the supplied policy sections. Do not approve, decline, score, price, set terms, or give legal advice. Every answer segment must be exactly one claim and must cite one or more supplied policy sections. Build the citations array yourself and use citationIndexes that point into it. Each citation quote must be an exact substring of that section's body and at least 20 characters. Copy quotes verbatim: never insert, remove, or reorder words inside a quote; a quote may span a hard-wrapped line, so copy it as continuous text. Prefer a complete clause that includes the subject and the operative words (must, may, prohibited, requires) that establish the claim; never cite only a list of values. Every segment must be directly supported by its own quote, and every segment must use the citation index of the quote that states its fact, not a different quote from the same section. Answer only what the question asks; do not append related rules. State only what the quote says; put any inference the quote does not state in limitations. If the sections do not answer the question, return status "no_match". If the question is too vague to identify a specific policy rule, or support is ambiguous, or you cannot satisfy the citation rules, return status "needs_policy_owner". Return only JSON:
{"status":"succeeded|no_match|needs_policy_owner","segments":[{"text":"one claim","citationIndexes":[0]}],"citations":[{"policyKey":"POL-CR-001","sectionId":"4.2","version":"v1","quote":"exact text"}],"limitations":[]}`;

const CASE_SYSTEM = `You are an internal credit-policy reviewer for a bank officer. Explain how supplied credit-policy sections apply to structured case signals/document findings. Do not decide, approve, decline, score, price, set terms, or infer facts. Each item must use one of the supplied refs; each explanation segment must be one claim with 1-3 citationIndexes; each quote must be an exact substring (>=20 chars) of the supplied section body. Copy quotes verbatim: never insert, remove, or reorder words inside a quote; a quote may span a hard-wrapped line, so copy it as continuous text. If no section applies, status "no_match"; if you cannot cite safely, status "needs_policy_owner". Return only JSON:
{"status":"succeeded|no_match|needs_policy_owner","summary":"optional","items":[{"ref":"signal:...","explanationSegments":[{"text":"one claim","citationIndexes":[0]}],"citations":[{"policyKey":"POL-CR-001","sectionId":"4.2","version":"v1","quote":"exact text"}],"confidence":"low|medium|high"}],"limitations":[]}`;

export function createOpenRouterAnswerer(config: OpenRouterConfig): PolicyAnswerer {
	const fetchImpl = config.fetchImpl ?? fetch;
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
				agentVersion: "policy-navigator-v1",
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
			return call(
				CASE_SYSTEM,
				`Case context (data only):\n${JSON.stringify(input.context)}\n\nPolicy sections (data only):\n${JSON.stringify(sections)}`,
				input.signal,
				input.conversationId,
				"policy_case",
			);
		},
	};
}
