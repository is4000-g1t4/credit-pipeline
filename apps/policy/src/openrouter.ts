import type { AnswererResult, Embedder, PolicyAnswerer } from "./store.js";

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
	for (let attempt = 0; attempt < 2; attempt++) {
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
		await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
	}
	const text = last ? await last.text().catch(() => "") : "";
	throw new Error(`OpenRouter ${last?.status ?? "error"}: ${text.slice(0, 300)}`);
}

export function createOpenRouterEmbedder(config: OpenRouterConfig): Embedder {
	const fetchImpl = config.fetchImpl ?? fetch;
	return {
		model: config.embeddingModel,
		dimensions: config.dimensions,
		async embed(inputs) {
			if (!config.apiKey) throw new Error("OPENROUTER_API_KEY is not configured");
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
	};
}

const SYSTEM = `You are an internal credit-policy navigator for bank officers. Answer only from the supplied policy sections. Do not approve, decline, score, price, set terms, or give legal advice. Every answer segment must be exactly one claim and must cite one or more supplied policy sections using citationIndexes into the supplied citation array. Each citation quote must be an exact substring of that section's body, at least 20 characters. If the sections do not answer the question, return status "no_match". If support is ambiguous or you cannot satisfy the citation rules, return status "needs_policy_owner". Return only JSON:
{"status":"succeeded|no_match|needs_policy_owner","segments":[{"text":"one claim","citationIndexes":[0]}],"citations":[{"policyKey":"POL-CR-001","sectionId":"4.2","version":"v1","quote":"exact text"}],"limitations":[]}`;

const CASE_SYSTEM = `You are an internal credit-policy reviewer for a bank officer. Explain how supplied credit-policy sections apply to structured case signals/document findings. Do not decide, approve, decline, score, price, set terms, or infer facts. Each item must use one of the supplied refs; each explanation segment must be one claim with 1-3 citationIndexes; each quote must be an exact substring (>=20 chars) of the supplied section body. If no section applies, status "no_match"; if you cannot cite safely, status "needs_policy_owner". Return only JSON:
{"status":"succeeded|no_match|needs_policy_owner","summary":"optional","items":[{"ref":"signal:...","explanationSegments":[{"text":"one claim","citationIndexes":[0]}],"citations":[{"policyKey":"POL-CR-001","sectionId":"4.2","version":"v1","quote":"exact text"}],"confidence":"low|medium|high"}],"limitations":[]}`;

export function createOpenRouterAnswerer(config: OpenRouterConfig): PolicyAnswerer {
	const fetchImpl = config.fetchImpl ?? fetch;
	const provider =
		config.answererProviderOrder && config.answererProviderOrder.length > 0
			? { order: config.answererProviderOrder }
			: undefined;
	const call = async (
		system: string,
		user: string,
		signal: AbortSignal,
	): Promise<AnswererResult> => {
		if (!config.apiKey) throw new Error("OPENROUTER_API_KEY is not configured");
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
			choices?: Array<{ message?: { content?: unknown } }>;
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
			);
		},
	};
}
