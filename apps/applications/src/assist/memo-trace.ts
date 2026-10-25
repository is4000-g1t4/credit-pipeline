// Agentic credit-memo trace (SPEC agentic-memo, wave A). Structured metadata
// only: tool names, source refs, counts, usage, latency. Never prompts,
// chain-of-thought, memo text, or raw evidence text.
import { hashCanonical, type EvidenceBundle } from "@credit/core";
import { z } from "zod";

export const memoAgentTraceSchema = z.object({
	writer: z.enum(["deterministic", "agent"]),
	agentVersion: z.string().min(1).max(80),
	model: z.string().min(1).max(200),
	promptVersion: z.string().min(1).max(80),
	evidenceHash: z.string().min(1).max(128),
	steps: z.number().int().min(0),
	toolCalls: z
		.array(
			z.object({
				step: z.number().int().min(0),
				name: z.string().min(1).max(80),
				resultCount: z.number().int().min(0),
				sourceTypes: z.array(z.string().min(1).max(80)),
			}),
		)
		.max(100),
	sourceRefs: z.array(z.string().min(1).max(500)).max(500),
	repairAttempted: z.boolean(),
	repairSucceeded: z.boolean().nullable(),
	fallbackReason: z.string().max(500).nullable(),
	inputTokens: z.number().int().min(0),
	outputTokens: z.number().int().min(0),
	latencyMs: z.number().int().min(0),
});

export type MemoAgentTrace = z.infer<typeof memoAgentTraceSchema>;

/** Stable idempotency key for an evidence bundle. Volatile assembly metadata
 * (`assembledAt`) is excluded so identical evidence replays to the same hash. */
export function evidenceHash(evidence: EvidenceBundle): string {
	return hashCanonical({
		applicationId: evidence.applicationId,
		asOf: evidence.asOf,
		items: evidence.items,
		unavailable: evidence.unavailable,
	});
}
