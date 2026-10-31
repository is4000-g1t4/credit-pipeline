// Shared contract between the generic agent-run workflow and each owning
// service's activities. Workflow-safe: no runtime imports.

/** Per-service task queues. Each service runs its own agent worker process. */
export const AGENT_TASK_QUEUES = Object.freeze({
	research: "research-agents",
	applications: "applications-agents",
});

export const AGENT_RUN_WORKFLOW = "agentRunWorkflow";

/** Error type an activity throws to stop Temporal retrying the run. */
export const NON_RETRYABLE_AGENT_ERROR = "NonRetryableAgentError";

/** agentRunWorkflow's retry schedule; sweeps derive their horizons from it. */
export const AGENT_RUN_RETRY = Object.freeze({
	maxAttempts: 3,
	backoffInitialMs: 2_000,
	backoffMaxMs: 30_000,
});

/** Backoff slept after failed attempt `attempt` (1-based). */
export function agentRunBackoffMs(attempt: number): number {
	return Math.min(
		AGENT_RUN_RETRY.backoffMaxMs,
		AGENT_RUN_RETRY.backoffInitialMs * 2 ** (attempt - 1),
	);
}

/**
 * Longest a live workflow can keep a run active: every attempt's full
 * start-to-close lease plus the backoff between attempts. Sweeps add their
 * own grace on top and never fail a row inside this window.
 */
export function agentRunHorizonMs(
	attemptLeaseMs: number,
	maxAttempts: number = AGENT_RUN_RETRY.maxAttempts,
): number {
	const attempts = Math.max(1, maxAttempts);
	let backoff = 0;
	for (let a = 1; a < attempts; a++) backoff += agentRunBackoffMs(a);
	return attemptLeaseMs * attempts + backoff;
}

export interface AgentRunInput {
	/** Dispatch key the service's activity switches on, e.g. "research.run". */
	kind: string;
	runId: string;
	/** Claim token the run row was created with (attempt 1 claims with it). */
	token: string;
	/** Start-to-close budget for one attempt, in ms (the run's own timeout). */
	timeoutMs: number;
	/** Whole-run attempts on crash / heartbeat loss. Default 3. */
	maxAttempts?: number;
	/**
	 * 1-based attempt, set by the workflow on every activity call (callers
	 * never set it). Activities read it via `runAttempt(input)`.
	 */
	attempt?: number;
	/** Heartbeat timeout in ms. Default 60s; activities heartbeat every 10s. */
	heartbeatTimeoutMs?: number;
	/** Small kind-specific scalars (ids, flags). Never PII, prompts, or documents. */
	payload?: Record<string, string | number | boolean | null>;
}

export interface AgentRunFailure {
	code: "timeout" | "error" | "cancelled";
	/** Short, non-sensitive description (error class / timeout type). */
	message: string;
}

/** Every service's agent worker registers exactly these two activities. */
export interface AgentRunActivities {
	/**
	 * Runs the agent. Business failures (validation, model unavailable after
	 * call-level retries, budget) are finalized on the run row and the
	 * activity returns normally; only crashes / lost heartbeats / unexpected
	 * throws reach Temporal's retry. Attempt > 1 must fence the previous
	 * attempt (rotate the run token) before doing any work.
	 */
	executeAgentRun(input: AgentRunInput): Promise<void>;
	/**
	 * Terminal cleanup after every attempt failed or the workflow was
	 * cancelled: marks a still-active run failed. Must be idempotent and
	 * must not touch a run that already reached a terminal state.
	 */
	failAgentRun(input: AgentRunInput, failure: AgentRunFailure): Promise<void>;
}
