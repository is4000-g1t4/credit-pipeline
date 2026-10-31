// Runner boilerplate shared by the applications agents (memo-writer,
// integrity, policy-exception). Only logic that is provably identical in
// every copy lives here; per-agent differences (typed error classes, what
// happens when the tool budget is exhausted) stay in each agent.
import { createOpenRouterClient } from "@credit/agent-kit";
import { createLogger, type Logger } from "@credit/service-kit";
import type OpenAI from "openai";

/** Provider-billed total when the SDK surfaces one, else tokens/1M. */
export function readCostUsd(result: unknown, inputTokens: number, outputTokens: number): number {
	const r = result as {
		cost?: unknown;
		totalCost?: unknown;
		total_cost?: unknown;
		state?: { usage?: { cost?: unknown; totalCost?: unknown; total_cost?: unknown } };
	};
	const candidates = [
		r?.cost,
		r?.totalCost,
		r?.total_cost,
		r?.state?.usage?.cost,
		r?.state?.usage?.totalCost,
		r?.state?.usage?.total_cost,
	];
	for (const candidate of candidates) {
		if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
			return candidate;
		}
	}
	return (inputTokens + outputTokens) / 1_000_000;
}

/**
 * One abort path: the caller's signal plus this run's own deadline,
 * combined up front instead of a parallel timer.
 */
export function withDeadline(caller: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return caller ? AbortSignal.any([caller, timeout]) : timeout;
}

export interface ToolBudget {
	readonly calls: number;
	readonly exceeded: boolean;
	/** Count one tool call; throws a plain Error once `max` is exceeded. */
	consume(): void;
}

/**
 * Per-run tool-call budget. The thrown plain Error reaches the model as a
 * tool failure; the runner then maps `exceeded` to its own typed error
 * (MemoAgentError / IntegrityAgentError), which stays agent-specific.
 */
export function createToolBudget(max: number, label: string): ToolBudget {
	const state = { calls: 0, exceeded: false };
	return {
		get calls() {
			return state.calls;
		},
		get exceeded() {
			return state.exceeded;
		},
		consume(): void {
			state.calls += 1;
			if (state.calls > max) {
				state.exceeded = true;
				throw new Error(`${label} tool budget exceeded after ${max} calls`);
			}
		},
	};
}

export interface AgentClientOptions {
	apiKey: string;
	baseUrl: string;
	timeoutMs: number;
	fetchImpl?: typeof fetch;
	/** Agent name recorded on retry warnings. */
	agent: string;
	logger?: Pick<Logger, "warn">;
}

let defaultLogger: Pick<Logger, "warn"> | undefined;

/**
 * OpenRouter client with the shared retry policy. `fetchImpl` stays the
 * test seam (retries wrap it); the SDK timeout bounds every retry, and a
 * caller abort stops retrying. Retry warnings carry metadata only.
 */
export function createAgentClient(opts: AgentClientOptions): OpenAI {
	const logger = opts.logger ?? (defaultLogger ??= createLogger("applications"));
	return createOpenRouterClient({
		apiKey: opts.apiKey,
		baseURL: opts.baseUrl,
		timeoutMs: opts.timeoutMs,
		...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
		retry: {
			onRetry: (event) => {
				logger.warn(
					{
						agent: opts.agent,
						attempt: event.attempt,
						reason: event.reason,
						status: event.status,
						delayMs: event.delayMs,
					},
					"model call retry",
				);
			},
		},
	});
}
