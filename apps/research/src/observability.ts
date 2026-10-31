// Thin convergence wrapper over the shared @credit/agent-observability
// pipeline (metadata-only, best-effort). Research keeps its local call
// surface — trackModelCall/trackToolExecution/hooksFor — so no call-site
// churn: every direct model call maps onto shared trackGeneration with a
// metadata-only onSuccess usage mapper. Never logs prompts/PII.
import {
	getObservability as getSharedObservability,
	resetObservability as resetSharedObservability,
} from "@credit/agent-observability";
import type { Runner } from "@openai/agents";
import { AGENT_VERSION } from "./agents/case-brief/prompt.js";

export interface RunHooks {
	detach: () => void;
}

/** Direct-model-call operations tracked as generations under the run conversation. */
export type ModelOperation = "agent" | "generateText" | "language_repair" | "support_judge";

export interface ModelCallOpts {
	/** Run id doubles as the Grafana conversation id (not PII). */
	runId: string;
	/** Exact model name (e.g. deepseek/deepseek-v3.2-exp). */
	model: string;
	operation: ModelOperation;
	agentName?: string;
	agentVersion?: string;
}

export interface Observability {
	readonly status: "ok" | "degraded";
	hooksFor(
		runner: Runner,
		opts: { runId: string; asOf: string; promptVersion: string; model: string },
	): RunHooks;
	/**
	 * One metadata-only generation under the run conversation for a direct
	 * model call (repair/judge) that bypasses the Runner hooks. Always
	 * executes `fn` (even degraded); observability faults never fail the run.
	 * Usage is reported, never prompts, outputs, names, or tool args — budget
	 * accounting stays with the existing callers, so this never double-counts.
	 */
	trackModelCall<T>(opts: ModelCallOpts, fn: () => Promise<T>): Promise<T>;
	/**
	 * One metadata-only tool execution under the run conversation. The Runner
	 * hooks do not surface tool spans for this agent's tool calls, so the
	 * tools are wrapped directly. Records tool name, timing, and errors only:
	 * never arguments or results. Always executes `fn`, never fails the run.
	 */
	trackToolExecution<T>(
		opts: {
			runId: string;
			toolName: string;
			model?: string;
			agentName?: string;
			agentVersion?: string;
		},
		fn: () => Promise<T>,
	): Promise<T>;
	/** Flush/shutdown for short-lived eval processes. */
	shutdown?(): Promise<void>;
}

/**
 * Stateless wrapper: the shared singleton owns the once-per-process
 * pipeline; this only maps the research-local surface onto it. Status is
 * read live so degradation is never stale.
 */
export function getObservability(): Observability {
	return {
		get status(): "ok" | "degraded" {
			return getSharedObservability("credit-research").status;
		},
		hooksFor: (runner, opts) =>
			getSharedObservability("credit-research").hooksFor(runner, {
				agentName: "case-brief",
				agentVersion: AGENT_VERSION,
				conversationId: opts.runId,
				feature: "case_brief",
				model: opts.model,
				promptVersion: opts.promptVersion,
				asOf: opts.asOf,
			}),
		trackModelCall: (opts, fn) => {
			const startedAt = Date.now();
			return getSharedObservability("credit-research").trackGeneration(
				{
					agentName: opts.agentName ?? "case-brief",
					agentVersion: opts.agentVersion ?? AGENT_VERSION,
					conversationId: opts.runId,
					feature: "case_brief",
					operation: opts.operation,
					model: opts.model,
					provider: "openrouter",
					temperature: 0,
					tags: { operation: opts.operation },
					metadata: { operation: opts.operation, model: opts.model },
					onSuccess: (result: unknown) => {
						const usage = readCallUsage(result);
						return {
							usage,
							metadata: {
								operation: opts.operation,
								model: opts.model,
								inputTokens: usage?.inputTokens ?? 0,
								outputTokens: usage?.outputTokens ?? 0,
								durationMs: Date.now() - startedAt,
							},
						};
					},
				},
				fn,
			);
		},
		trackToolExecution: (opts, fn) =>
			getSharedObservability("credit-research").trackToolExecution(
				{
					agentName: opts.agentName ?? "case-brief",
					agentVersion: opts.agentVersion ?? AGENT_VERSION,
					conversationId: opts.runId,
					feature: "case_brief",
					toolName: opts.toolName,
					model: opts.model,
					provider: "openrouter",
				},
				fn,
			),
		shutdown: () => getSharedObservability("credit-research").shutdown(),
	};
}

/** Duck-typed usage: OpenAI `prompt_tokens/completion_tokens` first, then
 * the internal `inputTokens/outputTokens` carried by test doubles. */
function readCallUsage(result: unknown): { inputTokens: number; outputTokens: number } | undefined {
	if (typeof result !== "object" || result === null) return undefined;
	const r = result as {
		state?: { usage?: unknown };
		usage?: unknown;
	};
	const usage = r.state?.usage ?? r.usage;
	if (typeof usage !== "object" || usage === null) return undefined;
	const u = usage as {
		prompt_tokens?: unknown;
		completion_tokens?: unknown;
		inputTokens?: unknown;
		outputTokens?: unknown;
	};
	const input = typeof u.prompt_tokens === "number" ? u.prompt_tokens : u.inputTokens;
	const output = typeof u.completion_tokens === "number" ? u.completion_tokens : u.outputTokens;
	if (typeof input !== "number" && typeof output !== "number") return undefined;
	return {
		inputTokens: typeof input === "number" ? input : 0,
		outputTokens: typeof output === "number" ? output : 0,
	};
}

/** Test seam: reset the shared per-process cache between cases. */
export function resetObservability(): void {
	resetSharedObservability();
}
