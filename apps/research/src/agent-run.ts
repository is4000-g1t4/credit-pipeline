// Research half of the durable-run contract (agent-kit `AgentRunActivities`).
// Pure DB/domain logic, no Temporal imports: the activity wrapper
// (agent-activities.ts) and the in-process test starter both call these.
import type { AgentRunFailure, AgentRunInput } from "@credit/agent-kit/temporal/types";
import type { Db } from "@credit/db/research";
import { executeContextRetry, type ContextExecDeps } from "./context-stage.js";
import type { ResearchEnv } from "./env.js";
import {
	contextRetryLeaseMs,
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
	return contextRetryLeaseMs(env);
}

/** Narrow starter surface routes/auto-trigger need (real or fake). */
export interface RunStarter {
	/** `started: false` when the workflow already existed (idempotent re-start). */
	start(input: AgentRunInput): Promise<{ started: boolean }>;
}

/** Upper bound on a workflow start (lazy connect + start RPC) in a caller's path. */
export const START_TIMEOUT_MS = 2_000;

export class StartTimeoutError extends Error {
	override readonly name = "StartTimeoutError";
	constructor(timeoutMs: number) {
		super(`agent run start exceeded ${timeoutMs}ms`);
	}
}

/**
 * `starter.start` bounded by a deadline: a hung Temporal connect/start
 * rejects with StartTimeoutError instead of stalling the caller. The start
 * itself is not cancelled; it is idempotent (workflow id = kind:runId:token),
 * so a late success and a later sweep start are the same workflow.
 */
export async function startWithDeadline(
	starter: RunStarter,
	input: AgentRunInput,
	timeoutMs: number = START_TIMEOUT_MS,
): Promise<{ started: boolean }> {
	type Outcome = { ok: true; value: { started: boolean } } | { ok: false; err: unknown };
	// Never rejects: a start that fails after the deadline already lost the
	// race and must not surface as an unhandled rejection.
	const pending = (async (): Promise<Outcome> => {
		try {
			return { ok: true, value: await starter.start(input) };
		} catch (err) {
			return { ok: false, err };
		}
	})();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<Outcome>((resolve) => {
		timer = setTimeout(
			() => resolve({ ok: false, err: new StartTimeoutError(timeoutMs) }),
			timeoutMs,
		);
		timer.unref?.();
	});
	try {
		const outcome = await Promise.race([pending, deadline]);
		if (!outcome.ok) throw outcome.err;
		return outcome.value;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Start the workflow AFTER the row's transaction committed, bounded by
 * START_TIMEOUT_MS. A Temporal outage or a hung start never changes (or
 * stalls) the caller's response: the row stays queued and the agent-worker
 * sweep starts it. Logs metadata only.
 */
export async function startAfterCommit(
	starter: RunStarter | undefined,
	logger: { error(obj: object, msg: string): void },
	input: AgentRunInput,
	timeoutMs: number = START_TIMEOUT_MS,
): Promise<void> {
	if (!starter) return;
	try {
		await startWithDeadline(starter, input, timeoutMs);
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
