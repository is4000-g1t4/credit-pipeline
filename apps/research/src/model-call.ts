// Shared direct OpenAI JSON call wrapper for the judge/repair factories.
// Builds `chat.completions.create` with the run deadline signal, tracks the
// call as its own metadata-only generation when a run id is present, parses
// the JSON body, and returns `{ parsed, usage }`. Zod shapes and error
// classes stay with each caller.
import type OpenAI from "openai";
import type { ModelOperation, Observability } from "./observability.js";

export interface ModelCallUsage {
	inputTokens: number;
	outputTokens: number;
}

export async function callJsonModel(opts: {
	openai: OpenAI;
	model: string;
	messages: Array<{ role: string; content: string }>;
	maxTokens: number;
	operation: ModelOperation;
	signal?: AbortSignal;
	runId?: string;
	observability?: Observability;
	/** Thrown when the reply body is not JSON; keeps each caller's error class. */
	invalidJson: () => Error;
}): Promise<{ parsed: unknown; usage: ModelCallUsage }> {
	// Direct OpenAI call (bypasses the Runner hooks). Untracked without a
	// run id; budget accounting stays with the existing callers.
	const call = () =>
		opts.openai.chat.completions.create(
			{
				model: opts.model,
				temperature: 0,
				max_tokens: opts.maxTokens,
				response_format: { type: "json_object" },
				messages: opts.messages as never,
			},
			// Request options (deadline), never model input.
			{ signal: opts.signal },
		);
	const res =
		opts.runId && opts.observability
			? await opts.observability.trackModelCall(
					{ runId: opts.runId, model: opts.model, operation: opts.operation },
					call,
				)
			: await call();
	const text = res.choices[0]?.message?.content ?? "";
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw opts.invalidJson();
	}
	return {
		parsed,
		usage: {
			inputTokens: res.usage?.prompt_tokens ?? 0,
			outputTokens: res.usage?.completion_tokens ?? 0,
		},
	};
}
