// Agentic credit-memo model adapter (SPEC agentic-memo, wave B). Plain
// OpenRouter chat completions over `fetch`; no new SDK dependency.
export type MemoModelMessageRole = "system" | "user" | "assistant" | "tool";

export interface MemoToolCall {
	id: string;
	name: string;
	arguments: unknown;
}

export interface MemoModelMessage {
	role: MemoModelMessageRole;
	content: string | null;
	/** Assistant messages that invoke tools. */
	toolCalls?: MemoToolCall[];
	/** Tool messages: the invoked call id. */
	toolCallId?: string;
	/** Tool messages: the invoked tool name. */
	name?: string;
}

export interface MemoToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface MemoModelUsage {
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
}

export interface MemoModelResult {
	content: string | null;
	toolCalls: MemoToolCall[];
	usage: MemoModelUsage;
}

export interface MemoModel {
	complete(input: {
		messages: MemoModelMessage[];
		tools: MemoToolDefinition[];
		signal: AbortSignal;
	}): Promise<MemoModelResult>;
}

export type MemoModelErrorCode = "UNAVAILABLE" | "INVALID_RESPONSE" | "TIMEOUT";

/** Transport/shape failure. Messages are static: never include prompts,
 * response bodies, or status text (bundles may carry applicant data). */
export class MemoModelError extends Error {
	readonly code: MemoModelErrorCode;
	constructor(code: MemoModelErrorCode) {
		super(
			code === "TIMEOUT"
				? "memo model request timed out"
				: code === "INVALID_RESPONSE"
					? "memo model response was invalid"
					: "memo model request failed",
		);
		this.name = "MemoModelError";
		this.code = code;
	}
}

export interface OpenRouterMemoModelOptions {
	apiKey: string;
	baseUrl: string;
	model: string;
	maxOutputTokens?: number;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 4_000;
const DEFAULT_TIMEOUT_MS = 30_000;

function toNonNegativeInt(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function parseToolArguments(raw: unknown): unknown {
	if (typeof raw !== "string") return raw ?? {};
	if (raw.trim().length === 0) return {};
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		// Unparseable arguments stay raw; the agent reports them as a tool
		// error to the model instead of failing the run.
		return raw;
	}
}

function toApiMessages(messages: MemoModelMessage[]): unknown[] {
	return messages.map((message) => {
		if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
			return {
				role: "assistant",
				content: message.content,
				tool_calls: message.toolCalls.map((call) => ({
					id: call.id,
					type: "function",
					function: {
						name: call.name,
						arguments:
							typeof call.arguments === "string"
								? call.arguments
								: JSON.stringify(call.arguments ?? {}),
					},
				})),
			};
		}
		if (message.role === "tool") {
			return {
				role: "tool",
				tool_call_id: message.toolCallId ?? "",
				content: message.content ?? "",
			};
		}
		return { role: message.role, content: message.content };
	});
}

export function createOpenRouterMemoModel(options: OpenRouterMemoModelOptions): MemoModel {
	const fetchImpl = options.fetchImpl ?? fetch;
	const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;

	return {
		async complete(input): Promise<MemoModelResult> {
			if (!options.apiKey) throw new MemoModelError("UNAVAILABLE");
			const timeout = AbortSignal.timeout(timeoutMs);
			const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
			let res: Response;
			try {
				res = await fetchImpl(url, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${options.apiKey}`,
						"HTTP-Referer": "https://credit-pipeline.local",
						"X-Title": "Credit memo writer",
					},
					body: JSON.stringify({
						model: options.model,
						temperature: 0,
						max_tokens: maxOutputTokens,
						tool_choice: "auto",
						tools: input.tools.map((tool) => ({
							type: "function",
							function: {
								name: tool.name,
								description: tool.description,
								parameters: tool.parameters,
							},
						})),
						messages: toApiMessages(input.messages),
					}),
					signal,
				});
			} catch {
				throw new MemoModelError(signal.aborted ? "TIMEOUT" : "UNAVAILABLE");
			}
			if (!res.ok) throw new MemoModelError("UNAVAILABLE");
			let body: unknown;
			try {
				body = (await res.json()) as unknown;
			} catch {
				throw new MemoModelError("INVALID_RESPONSE");
			}
			const message = (body as { choices?: Array<{ message?: unknown }> }).choices?.[0]?.message as
				| {
						content?: unknown;
						tool_calls?: Array<{
							id?: unknown;
							function?: { name?: unknown; arguments?: unknown };
						}>;
				  }
				| undefined;
			if (!message || typeof message !== "object") throw new MemoModelError("INVALID_RESPONSE");
			const content =
				message.content === null || message.content === undefined
					? null
					: typeof message.content === "string"
						? message.content
						: (() => {
								throw new MemoModelError("INVALID_RESPONSE");
							})();
			const rawCalls = message.tool_calls ?? [];
			if (!Array.isArray(rawCalls)) throw new MemoModelError("INVALID_RESPONSE");
			const toolCalls: MemoToolCall[] = rawCalls.map((call) => {
				if (typeof call?.id !== "string" || typeof call?.function?.name !== "string") {
					throw new MemoModelError("INVALID_RESPONSE");
				}
				return {
					id: call.id,
					name: call.function.name,
					arguments: parseToolArguments(call.function.arguments),
				};
			});
			const usage = (body as { usage?: Record<string, unknown> }).usage ?? {};
			const inputTokens = toNonNegativeInt(usage["prompt_tokens"]);
			const outputTokens = toNonNegativeInt(usage["completion_tokens"]);
			const costUsd =
				typeof usage["total_cost"] === "number" && Number.isFinite(usage["total_cost"])
					? usage["total_cost"]
					: (inputTokens + outputTokens) / 1_000_000;
			return { content, toolCalls, usage: { inputTokens, outputTokens, costUsd } };
		},
	};
}
