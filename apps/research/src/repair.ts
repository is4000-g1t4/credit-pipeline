// Bounded language-repair pass (§6.4): the same approved model,
// temperature 0, strict structured output, one call max, on the run's
// deadline signal. Rewrites ONLY `summary`, `findings[].whyItMatters`
// (and `claim` only when it holds decision language) to remove
// recommendations/decisions/grades/scores/rates/limits/terms and implicit
// verdicts. It never adds facts, evidence, findings, or citations: the
// merge below preserves everything else by construction, and callers
// re-verify structure plus forbidden terms before judging.
import type OpenAI from "openai";
import { z } from "zod";
import { callJsonModel } from "./model-call.js";
import type { Observability } from "./observability.js";
import { modelBriefSchema, type ModelBrief } from "./validator.js";

export interface RepairUsage {
	inputTokens: number;
	outputTokens: number;
}

export interface LanguageRepairResult {
	brief: ModelBrief;
	usage?: RepairUsage;
}

export type LanguageRepair = (
	brief: ModelBrief,
	opts?: { signal?: AbortSignal; runId?: string },
) => Promise<LanguageRepairResult>;

/** The model reply parsed but violated repair invariants (not transport). */
export class RepairRejectedError extends Error {}

// Minimal shape: only the fields the model may rewrite. Counts and
// evidence/citations stay server-side, so the reply cannot add them.
const repairSchema = z
	.object({
		summary: z.string().min(1).max(2000),
		findings: z
			.array(
				z
					.object({
						claim: z.string().min(1).max(2000),
						whyItMatters: z.string().min(1).max(1000),
					})
					.strict(),
			)
			.max(20),
	})
	.strict();

const REPAIR_SYSTEM = `You clean decision language from a bank research brief. Rewrite ONLY the summary, each finding's whyItMatters, and a finding's claim only if that claim contains decision language. Remove recommendations, decisions, approvals, declines, grades, scores, rates, limits, terms, and implicit verdicts such as "not bankable" or "high risk". Never use the words recommend, decision, approve, decline, grade, score, rate, limit, or term (this includes "loan terms" or "term loan" — say "the financing request" instead). Do not add facts, evidence, findings, or citations. Keep each claim's meaning and return exactly as many findings as given. Reply with JSON only: {summary, findings: [{claim, whyItMatters}]}`;

function repairUserContent(brief: ModelBrief): string {
	const findings = brief.findings
		.map((f, i) => `${i + 1}. claim: ${f.claim}\n   whyItMatters: ${f.whyItMatters}`)
		.join("\n");
	return `SUMMARY: ${brief.summary}\nFINDINGS (${brief.findings.length}):\n${findings}`;
}

export function createLlmLanguageRepair(
	openai: OpenAI,
	model: string,
	deps?: { observability?: Observability },
): LanguageRepair {
	return async (brief, opts) => {
		// Direct OpenAI call (bypasses the Runner hooks): tracked as its own
		// metadata-only generation under the run conversation (§7). Untracked
		// without a run id; budget accounting below is unchanged.
		const { parsed, usage } = await callJsonModel({
			openai,
			model,
			messages: [
				{ role: "system", content: REPAIR_SYSTEM },
				{ role: "user", content: repairUserContent(brief) },
			],
			maxTokens: 4000,
			operation: "language_repair",
			signal: opts?.signal,
			runId: opts?.runId,
			observability: deps?.observability,
			invalidJson: () => new RepairRejectedError("language repair returned invalid JSON"),
		});
		const repaired = repairSchema.safeParse(parsed);
		if (!repaired.success)
			throw new RepairRejectedError("language repair failed schema validation");
		// The reply must cover every finding exactly once: no drops, no adds.
		if (repaired.data.findings.length !== brief.findings.length) {
			throw new RepairRejectedError("language repair changed the finding count");
		}
		const full = modelBriefSchema.safeParse({
			...brief,
			summary: repaired.data.summary,
			findings: brief.findings.map((f, i) => ({
				...f,
				claim: repaired.data.findings[i].claim,
				whyItMatters: repaired.data.findings[i].whyItMatters,
			})),
		});
		if (!full.success) throw new RepairRejectedError("language repair failed schema validation");
		return {
			brief: full.data,
			usage,
		};
	};
}

/** Deterministic test double: identity by default, with call counting. */
export function stubLanguageRepair(
	scenario: {
		repair?: (brief: ModelBrief) => unknown;
		throw?: Error;
	} = {},
): LanguageRepair & { calls: number } {
	let calls = 0;
	const fn = (async (brief: ModelBrief) => {
		calls += 1;
		if (scenario.throw) throw scenario.throw;
		return { brief: (scenario.repair ? scenario.repair(brief) : brief) as ModelBrief };
	}) as LanguageRepair & { calls: number };
	Object.defineProperty(fn, "calls", { get: () => calls });
	return fn;
}
