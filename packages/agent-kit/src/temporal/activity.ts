// Helpers for the service-side agent activities (runs inside a Temporal
// activity context only).
import { ApplicationFailure, Context } from "@temporalio/activity";
import { NON_RETRYABLE_AGENT_ERROR } from "./types.js";

/** 1-based attempt number of the current activity execution. */
export function activityAttempt(): number {
	return Context.current().info.attempt;
}

/**
 * Aborts when Temporal cancels the activity (heartbeat timeout, workflow
 * cancel, worker shutdown). Pass it into the run so a fenced attempt
 * stops spending model budget.
 */
export function activityCancellationSignal(): AbortSignal {
	return Context.current().cancellationSignal;
}

/**
 * Heartbeats every `intervalMs` until the returned stop function runs.
 * Heartbeats are how Temporal notices a crashed or wedged worker.
 */
export function startHeartbeat(intervalMs = 10_000): () => void {
	const ctx = Context.current();
	ctx.heartbeat();
	const timer = setInterval(() => ctx.heartbeat(), intervalMs);
	timer.unref?.();
	return () => clearInterval(timer);
}

/** Throw to stop Temporal retrying the run (e.g. the run row is gone). */
export function nonRetryableAgentError(message: string): ApplicationFailure {
	return ApplicationFailure.create({
		message,
		type: NON_RETRYABLE_AGENT_ERROR,
		nonRetryable: true,
	});
}
