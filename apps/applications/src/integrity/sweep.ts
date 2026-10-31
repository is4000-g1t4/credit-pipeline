// Agent-worker sweep: closes the gap between "row committed" and "workflow
// started" (the API commits first), and guarantees nothing stays queued
// forever. Starts are idempotent (workflow id = kind:runId:token).
import { documentIntegrityRuns } from "@credit/db/applications";
import { and, asc, eq, lt } from "drizzle-orm";
import {
	failIntegrityRun,
	integrityLeaseSeconds,
	startIntegrityRun,
	type IntegrityRunDeps,
} from "./runs.js";

export const SWEEP_RESTART_AFTER_MS = 10_000;
export const SWEEP_OVERDUE_GRACE_MS = 5 * 60_000;
const SWEEP_BATCH = 50;

export interface SweepResult {
	restarted: number;
	failed: number;
}

async function queuedBefore(
	deps: IntegrityRunDeps,
	before: Date,
): Promise<Array<{ id: string; maxAttempts: number }>> {
	return deps.db
		.select({ id: documentIntegrityRuns.id, maxAttempts: documentIntegrityRuns.maxAttempts })
		.from(documentIntegrityRuns)
		.where(
			and(
				eq(documentIntegrityRuns.feature, "document_analysis"),
				eq(documentIntegrityRuns.status, "queued"),
				lt(documentIntegrityRuns.createdAt, before),
			),
		)
		.orderBy(asc(documentIntegrityRuns.createdAt))
		.limit(SWEEP_BATCH);
}

/**
 * Fails queued rows older than lease + 5 min, then (when `dispatch`) re-issues
 * the idempotent start for queued rows older than 10s.
 */
export async function sweepQueuedIntegrityRuns(
	deps: IntegrityRunDeps,
	opts: { dispatch: boolean; now?: Date },
): Promise<SweepResult> {
	const now = opts.now ?? deps.now?.() ?? new Date();
	const overdueBefore = new Date(
		now.getTime() - integrityLeaseSeconds(deps.config) * 1000 - SWEEP_OVERDUE_GRACE_MS,
	);
	let failed = 0;
	for (const row of await queuedBefore(deps, overdueBefore)) {
		if (await failIntegrityRun(deps, row.id, "LEASE_EXPIRED", "queued too long")) failed++;
	}
	let restarted = 0;
	if (opts.dispatch && deps.starter) {
		for (const row of await queuedBefore(deps, new Date(now.getTime() - SWEEP_RESTART_AFTER_MS))) {
			await startIntegrityRun(deps, row);
			restarted++;
		}
	}
	return { restarted, failed };
}
