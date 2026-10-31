// Temporal activities for the research agent worker (Node only). Thin
// wrappers over agent-run.ts: heartbeat for the whole run, thread activity
// cancellation into the run's deadline, dispatch on `input.kind`.
import {
	activityAttempt,
	activityCancellationSignal,
	startHeartbeat,
} from "@credit/agent-kit/temporal/activity";
import type {
	AgentRunActivities,
	AgentRunFailure,
	AgentRunInput,
} from "@credit/agent-kit/temporal/types";
import { failResearchRun, runAgentAttempt } from "./agent-run.js";
import type { ContextExecDeps } from "./context-stage.js";
import type { ExecDeps } from "./run.js";

export interface ResearchActivityOptions {
	/** Temporal heartbeat cadence; the workflow's heartbeat timeout is 60s. */
	heartbeatIntervalMs?: number;
	/**
	 * Test seam: runs with the attempt number known, before the run
	 * executes. A throw here is an unexpected crash, so Temporal retries.
	 */
	beforeRun?: (ctx: { attempt: number; input: AgentRunInput }) => Promise<void> | void;
}

export function createResearchActivities(
	deps: ExecDeps & ContextExecDeps,
	opts: ResearchActivityOptions = {},
): AgentRunActivities {
	return {
		async executeAgentRun(input: AgentRunInput): Promise<void> {
			const attempt = activityAttempt();
			// DB heartbeats (executeRun / stage timers) keep running too: the
			// UI/status reads them. Temporal's heartbeat is what detects a
			// dead worker.
			const stop = startHeartbeat(opts.heartbeatIntervalMs ?? 10_000);
			try {
				await opts.beforeRun?.({ attempt, input });
				await runAgentAttempt(
					{ ...deps, cancelSignal: activityCancellationSignal() },
					input,
					attempt,
				);
			} finally {
				stop();
			}
		},
		async failAgentRun(input: AgentRunInput, failure: AgentRunFailure): Promise<void> {
			await failResearchRun(deps.db, input, failure);
		},
	};
}
