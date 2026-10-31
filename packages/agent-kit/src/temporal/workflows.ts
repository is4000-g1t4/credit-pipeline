// Generic durable agent run. Replaces the hand-rolled fire-and-forget +
// queued-run recovery + reaper loops: Temporal owns dispatch, crash
// retries (fenced by token rotation in the activity), and the terminal
// "mark failed" step. Workflow sandbox: only @temporalio/workflow imports.
import {
	ActivityFailure,
	ApplicationFailure,
	CancellationScope,
	TimeoutFailure,
	isCancellation,
	proxyActivities,
} from "@temporalio/workflow";
import {
	NON_RETRYABLE_AGENT_ERROR,
	type AgentRunActivities,
	type AgentRunFailure,
	type AgentRunInput,
} from "./types.js";

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 60_000;

export async function agentRunWorkflow(input: AgentRunInput): Promise<void> {
	const { executeAgentRun } = proxyActivities<AgentRunActivities>({
		startToCloseTimeout: input.timeoutMs,
		heartbeatTimeout: input.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
		retry: {
			maximumAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
			initialInterval: "2 seconds",
			backoffCoefficient: 2,
			maximumInterval: "30 seconds",
			nonRetryableErrorTypes: [NON_RETRYABLE_AGENT_ERROR],
		},
	});
	const { failAgentRun } = proxyActivities<AgentRunActivities>({
		startToCloseTimeout: "30 seconds",
		retry: {
			maximumAttempts: 10,
			initialInterval: "1 second",
			backoffCoefficient: 2,
			maximumInterval: "30 seconds",
		},
	});

	try {
		await executeAgentRun(input);
	} catch (err) {
		const failure = describeFailure(err);
		// Cleanup must run even when the workflow itself is being cancelled.
		await CancellationScope.nonCancellable(() => failAgentRun(input, failure));
		if (isCancellation(err)) throw err;
		throw ApplicationFailure.nonRetryable(
			`agent run ${input.kind} failed: ${failure.code}`,
			"AgentRunFailed",
		);
	}
}

export function describeFailure(err: unknown): AgentRunFailure {
	if (isCancellation(err)) return { code: "cancelled", message: "agent run cancelled" };
	const cause = err instanceof ActivityFailure ? err.cause : err;
	if (cause instanceof TimeoutFailure) {
		return { code: "timeout", message: `activity timeout: ${String(cause.timeoutType)}` };
	}
	if (cause instanceof ApplicationFailure) {
		return { code: "error", message: cause.type ?? "ApplicationFailure" };
	}
	return { code: "error", message: cause instanceof Error ? cause.name : "unknown" };
}
