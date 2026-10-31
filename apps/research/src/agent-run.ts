// Research half of the durable-run contract (agent-kit `AgentRunActivities`).
// Pure DB/domain logic, no Temporal imports: the activity wrapper
// (agent-activities.ts) and the in-process test starter both call these.
import type { AgentRunFailure, AgentRunInput } from "@credit/agent-kit/temporal/types";
import type { Db } from "@credit/db/research";
import { executeContextRetry, type ContextExecDeps } from "./context-stage.js";
import type { ResearchEnv } from "./env.js";
import {
	failActiveRun,
	failRunningContextStage,
	rotateContextStageForRetry,
	rotateRunForRetry,
	runLeaseMs,
	type RunErrorCode,
} from "./lifecycle.js";
import { executeRun, type ExecDeps } from "./run.js";

/** Dispatch keys carried in `AgentRunInput.kind`. */
export const RESEARCH_RUN_KIND = "research.run";
export const RESEARCH_CONTEXT_RETRY_KIND = "research.context-retry";

/** Per-attempt start-to-close budget for a research run workflow. */
export function researchRunTimeoutMs(env: ResearchEnv): number {
	return runLeaseMs(env);
}

/** Per-attempt budget for a context-retry workflow (stage deadline + grace). */
export function contextRetryTimeoutMs(env: ResearchEnv): number {
	return env.contextTimeoutMs + 30_000;
}

/** Narrow starter surface routes/auto-trigger need (real or fake). */
export interface RunStarter {
	start(input: AgentRunInput): Promise<unknown>;
}

/**
 * Start the workflow AFTER the row's transaction committed. A Temporal
 * outage never changes the caller's response: the row stays queued and the
 * agent-worker sweep starts it. Logs metadata only.
 */
export async function startAfterCommit(
	starter: RunStarter | undefined,
	logger: { error(obj: object, msg: string): void },
	input: AgentRunInput,
): Promise<void> {
	if (!starter) return;
	try {
		await starter.start(input);
	} catch (err) {
		logger.error(
			{
				kind: input.kind,
				runId: input.runId,
				err: err instanceof Error ? err.name : "unknown",
			},
			"agent run start failed; the sweep will retry",
		);
	}
}

/**
 * One activity attempt. Attempt 1 claims with the input token exactly as
 * before; attempt > 1 fences first (token rotation) and does nothing when
 * the run/stage is already terminal. Business failures are finalized by
 * executeRun and return normally (no Temporal retry, no re-spend).
 */
export async function runAgentAttempt(
	deps: ExecDeps & ContextExecDeps,
	input: AgentRunInput,
	attempt: number,
): Promise<void> {
	if (input.kind === RESEARCH_RUN_KIND) {
		let token = input.token;
		if (attempt > 1) {
			const rotated = await rotateRunForRetry(deps.db, deps.env, input.runId);
			if (!rotated) return;
			token = rotated;
		}
		await executeRun(deps, input.runId, token);
		return;
	}
	if (input.kind === RESEARCH_CONTEXT_RETRY_KIND) {
		let stageToken = input.token;
		if (attempt > 1) {
			const rotated = await rotateContextStageForRetry(deps.db, input.runId);
			if (!rotated) return;
			stageToken = rotated;
		}
		await executeContextRetry(deps, input.runId, stageToken);
		return;
	}
	throw new Error(`unknown research agent kind: ${input.kind}`);
}

/** Terminal cleanup after every attempt failed or the workflow was cancelled. */
export async function failResearchRun(
	db: Db,
	input: AgentRunInput,
	failure: AgentRunFailure,
): Promise<void> {
	const timedOut = failure.code === "timeout";
	if (input.kind === RESEARCH_RUN_KIND) {
		const code: RunErrorCode = timedOut ? "timeout" : "internal_error";
		await failActiveRun(db, input.runId, {
			code,
			message: timedOut ? "research run timed out" : "research run failed",
		});
		return;
	}
	if (input.kind === RESEARCH_CONTEXT_RETRY_KIND) {
		await failRunningContextStage(db, input.runId, timedOut ? "timeout" : "internal_error");
		return;
	}
	throw new Error(`unknown research agent kind: ${input.kind}`);
}
