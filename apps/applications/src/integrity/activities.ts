// Temporal activities for kind "integrity.run" (Node agent worker only: this
// module imports the worker-side activity helpers). Business failures are
// finalized on the run row and the activity returns normally; only crashes,
// lost heartbeats and unexpected throws reach Temporal's retry.
import {
	activityAttempt,
	activityCancellationSignal,
	nonRetryableAgentError,
	startHeartbeat,
} from "@credit/agent-kit/temporal/activity";
import type {
	AgentRunActivities,
	AgentRunFailure,
	AgentRunInput,
} from "@credit/agent-kit/temporal/types";
import {
	claimIntegrityRunById,
	executeIntegrityRun,
	failIntegrityRun,
	INTEGRITY_RUN_KIND,
	type ClaimedRow,
	type IntegrityRunDeps,
} from "./runs.js";

export interface IntegrityActivityHooks {
	/** Test seam: runs after a successful claim, before the run executes. */
	afterClaim?: (claimed: ClaimedRow, attempt: number) => void | Promise<void>;
}

function assertKind(input: AgentRunInput): void {
	if (input.kind !== INTEGRITY_RUN_KIND) {
		throw nonRetryableAgentError(`unsupported agent run kind: ${input.kind}`);
	}
}

/** Error codes reuse the vocabulary the integrity panel already renders. */
export function failureErrorCode(failure: AgentRunFailure): string {
	return failure.code === "error" ? "INTERNAL_ERROR" : "LEASE_EXPIRED";
}

export function createIntegrityActivities(
	deps: IntegrityRunDeps,
	hooks: IntegrityActivityHooks = {},
): AgentRunActivities {
	return {
		async executeAgentRun(input) {
			assertKind(input);
			const attempt = activityAttempt();
			const stopHeartbeat = startHeartbeat();
			try {
				const claim = await claimIntegrityRunById(deps, input.runId, attempt);
				if (claim.kind === "missing") throw nonRetryableAgentError("integrity run row is missing");
				if (claim.kind !== "claimed") return;
				await hooks.afterClaim?.(claim.row, attempt);
				await executeIntegrityRun(deps, claim.row, { signal: activityCancellationSignal() });
			} finally {
				stopHeartbeat();
			}
		},
		async failAgentRun(input, failure) {
			assertKind(input);
			await failIntegrityRun(deps, input.runId, failureErrorCode(failure), failure.message);
		},
	};
}
