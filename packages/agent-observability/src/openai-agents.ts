// Shared OpenAI Agents SDK surface: one client cast, one usage reader, one
// tracing switch. The Agents SDK's CJS typings load openai's `client.d.ts`
// while ESM importers load `client.d.mts`: same runtime API, distinct
// `#private` identities. The SDK duck-types the client (no instanceof on
// this path), so one boundary cast is safe.
import { OpenAIChatCompletionsModel, setTracingDisabled } from "@openai/agents";

setTracingDisabled(true);

export type AgentsOpenAIClient = ConstructorParameters<typeof OpenAIChatCompletionsModel>[0];

export function readRunUsage(result: unknown): { inputTokens: number; outputTokens: number } {
	const r = result as {
		state?: { usage?: { inputTokens?: number; outputTokens?: number } };
		usage?: { inputTokens?: number; outputTokens?: number };
	};
	const usage = r?.state?.usage ?? r?.usage;
	return {
		inputTokens: usage?.inputTokens ?? 0,
		outputTokens: usage?.outputTokens ?? 0,
	};
}
