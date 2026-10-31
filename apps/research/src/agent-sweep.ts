// Agent-worker sweep (replaces recoverQueuedRuns / the reapers). Closes the
// gap between "API committed the row" and "Temporal accepted the start":
// re-issues idempotent starts for rows nobody picked up, and fails rows
// that stayed unstartable long past their lease so the UI always reaches a
// terminal state.
import type { AgentRunInput } from "@credit/agent-kit/temporal/types";
import type { Db } from "@credit/db/research";
import type { Logger } from "@credit/service-kit";
import {
	contextRetryTimeoutMs,
	RESEARCH_CONTEXT_RETRY_KIND,
	RESEARCH_RUN_KIND,
	researchRunTimeoutMs,
	type RunStarter,
} from "./agent-run.js";
import type { ResearchEnv } from "./env.js";
import {
	failOverdueContextRetries,
	failOverdueQueuedRuns,
	listUnstartedContextRetries,
	listUnstartedRuns,
} from "./lifecycle.js";

export interface SweepResult {
	started: string[];
	failed: string[];
}

export async function sweepAgentRuns(deps: {
	db: Db;
	env: ResearchEnv;
	logger: Logger;
	starter: RunStarter;
}): Promise<SweepResult> {
	const { db, env, logger, starter } = deps;
	const started: string[] = [];
	// Fail first: an overdue row must reach a terminal state, not be
	// restarted just before it would be failed.
	const failed = [...(await failOverdueQueuedRuns(db)), ...(await failOverdueContextRetries(db))];
	const inputs: AgentRunInput[] = [
		...(await listUnstartedRuns(db)).map((p) => ({
			kind: RESEARCH_RUN_KIND,
			runId: p.runId,
			token: p.token,
			timeoutMs: researchRunTimeoutMs(env),
		})),
		...(await listUnstartedContextRetries(db)).map((p) => ({
			kind: RESEARCH_CONTEXT_RETRY_KIND,
			runId: p.runId,
			token: p.token,
			timeoutMs: contextRetryTimeoutMs(env),
		})),
	];
	for (const input of inputs) {
		try {
			// Idempotent: the workflow id is kind:runId:token.
			await starter.start(input);
			started.push(input.runId);
		} catch (err) {
			logger.error(
				{ kind: input.kind, runId: input.runId, err: err instanceof Error ? err.name : "unknown" },
				"sweep start failed",
			);
		}
	}
	return { started, failed };
}
