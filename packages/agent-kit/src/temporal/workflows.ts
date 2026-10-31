// Generic durable agent run. Replaces the hand-rolled fire-and-forget +
// queued-run recovery + reaper loops: Temporal owns dispatch, crash
// retries (fenced by token rotation in the activity), and the terminal
// "mark failed" step. Workflow sandbox: only @temporalio/workflow imports.
//
// Attempts are driven by this loop (each activity call has
// maximumAttempts: 1) so the policy can tell failure kinds apart:
//   - lost heartbeat / crash / retryable throw -> retry with backoff
//   - START_TO_CLOSE timeout (a hung run that used its whole budget),
//     non-retryable ApplicationFailure, cancellation -> stop, clean up
// The attempt number travels in the input so activities can fence and
// know when they are on the last attempt.
import {
	ActivityFailure,
	ApplicationFailure,
	CancellationScope,
	TimeoutFailure,
	isCancellation,
	proxyActivities,
	sleep,
} from "@temporalio/workflow";
import {
	NON_RETRYABLE_AGENT_ERROR,
	type AgentRunActivities,
	type AgentRunFailure,
	type AgentRunInput,
} from "./types.js";

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 60_000;
const BACKOFF_INITIAL_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;

export async function agentRunWorkflow(input: AgentRunInput): Promise<void> {
	const maxAttempts = Math.max(1, input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
	const { executeAgentRun } = proxyActivities<AgentRunActivities>({
		startToCloseTimeout: input.timeoutMs,
		heartbeatTimeout: input.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
		retry: { maximumAttempts: 1 },
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

	for (let attempt = 1; ; attempt++) {
		try {
			await executeAgentRun({ ...input, attempt, maxAttempts });
			return;
		} catch (err) {
			if (attempt < maxAttempts && isRetryableAttemptFailure(err)) {
				await sleep(Math.min(BACKOFF_MAX_MS, BACKOFF_INITIAL_MS * 2 ** (attempt - 1)));
				continue;
			}
			const failure = describeFailure(err);
			// Cleanup must run even when the workflow itself is being cancelled.
			await CancellationScope.nonCancellable(() =>
				failAgentRun({ ...input, attempt, maxAttempts }, failure),
			);
			if (isCancellation(err)) throw err;
			throw ApplicationFailure.nonRetryable(
				`agent run ${input.kind} failed: ${failure.code}`,
				"AgentRunFailed",
			);
		}
	}
}

/**
 * Whether another attempt is worth running. A START_TO_CLOSE timeout means
 * the attempt consumed its full wall-clock budget (hung model call, DB
 * stall): re-running would re-spend the whole budget for the same outcome,
 * so it is terminal, matching the old reaper's "timed out" semantics.
 */
export function isRetryableAttemptFailure(err: unknown): boolean {
	if (isCancellation(err)) return false;
	const cause = err instanceof ActivityFailure ? err.cause : err;
	if (cause instanceof TimeoutFailure) return cause.timeoutType !== "START_TO_CLOSE";
	if (cause instanceof ApplicationFailure) {
		return !cause.nonRetryable && cause.type !== NON_RETRYABLE_AGENT_ERROR;
	}
	return true;
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
