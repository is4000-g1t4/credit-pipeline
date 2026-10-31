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
