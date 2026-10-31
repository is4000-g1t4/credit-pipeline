import { createRetryingFetch, type RetryEvent, type RetryOptions } from "@credit/agent-kit";
import type { Embedder } from "./store.js";
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
	/** Metadata-only retry warnings (agent, attempt, reason, status, delayMs). */
	logger?: { warn(obj: Record<string, unknown>, msg: string): void };
	/** Retry tuning/test seams; defaults to the shared DEFAULT_RETRY_POLICY. */
	retry?: RetryOptions;
}

export interface OpenRouterEnv {
	openrouterApiKey: string;
	openrouterBaseUrl: string;
	agentModel: string;
	embeddingDimensions: number;
	embeddingModel: string;
	agentTemperature: number;
	agentMaxOutputTokens: number;
	embeddingProviders: string;
	answererProviderOrder: string;
}

/** Single construction site for the OpenRouter client config (server/seed/reindex). */
export function openRouterConfigFromEnv(env: OpenRouterEnv): OpenRouterConfig {
	return {
		apiKey: env.openrouterApiKey,
		baseUrl: env.openrouterBaseUrl,
		model: env.agentModel,
		dimensions: env.embeddingDimensions,
		embeddingModel: env.embeddingModel,
		temperature: env.agentTemperature,
		maxOutputTokens: env.agentMaxOutputTokens,
		embeddingProviders: env.embeddingProviders ? env.embeddingProviders.split(",") : [],
		answererProviderOrder: env.answererProviderOrder ? env.answererProviderOrder.split(",") : [],
	};
}

export function parseContent(value: unknown): unknown {
	if (typeof value !== "string") throw new Error("model returned no content");
	const trimmed = value
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");
	return JSON.parse(trimmed);
}

/**
 * Retrying fetch for every policy OpenRouter call (chat completions and
 * embeddings). Wraps the injectable `fetchImpl`; retry policy is the shared
 * agent-kit DEFAULT_RETRY_POLICY. `onRetry` logs metadata only.
 */
export function createPolicyFetch(config: OpenRouterConfig, agent: string): typeof fetch {
	return createRetryingFetch(
		{
			...config.retry,
			onRetry: (event: RetryEvent) => {
				config.logger?.warn(
					{
						agent,
						attempt: event.attempt,
						reason: event.reason,
						status: event.status,
						delayMs: event.delayMs,
					},
					"openrouter call retrying",
				);
				config.retry?.onRetry?.(event);
			},
		},
		config.fetchImpl ?? fetch,
	);
}

export async function postJson(
	fetchImpl: typeof fetch,
	url: string,
	apiKey: string,
	body: unknown,
	signal: AbortSignal,
): Promise<unknown> {
	let res: Response;
	try {
		res = await fetchImpl(url, {
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
	} catch (err) {
		throw err instanceof Error ? err : new Error("OpenRouter request failed");
	}
	if (res.ok) return res.json();
	const text = await res.text().catch(() => "");
	throw new OpenRouterHttpError(res.status, `OpenRouter ${res.status}: ${text.slice(0, 300)}`);
}

/** Non-2xx from OpenRouter after retries; `status` drives caller fallbacks. */
export class OpenRouterHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "OpenRouterHttpError";
	}
}

/** A gateway refusing the `provider` routing params: a non-retryable 400/422. */
function isProviderRoutingRejected(err: unknown): boolean {
	return err instanceof OpenRouterHttpError && (err.status === 400 || err.status === 422);
}

export function createOpenRouterEmbedder(config: OpenRouterConfig): Embedder {
	const fetchImpl = createPolicyFetch(config, "policy-embedder");
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
						// Some gateways reject provider routing on embeddings (400/422).
						// Retry once without it; the eval records the same fallback.
						// Persistent 5xx, 401, timeouts etc. are not routing problems.
						if (!provider || !isProviderRoutingRejected(err)) throw err;
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
