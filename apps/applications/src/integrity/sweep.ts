// Agent-worker sweep: closes the gap between "row committed" and "workflow
// started" (the API commits first), and guarantees nothing stays active
// forever. Starts are idempotent (workflow id = kind:runId:token).
//
// The sweep never fails work a live workflow still owns:
//   - a queued row is failed only when its workflow cannot be started (the
//     re-issued start failed, or this worker does not dispatch) and it is
//     older than the whole-run horizon. A queued row whose workflow exists
//     is backlog waiting for a worker slot and is left alone (up to a day).
//   - a running row is failed only when its lease went stale beyond the
//     whole-run horizon (the workflow and its cleanup were lost), fenced on
//     the stale lease token so a re-lease wins.
import { documentIntegrityRuns } from "@credit/db/applications";
import { and, asc, eq, lt, sql } from "drizzle-orm";
import {
	failIntegrityRun,
	integrityLeaseSeconds,
	startIntegrityRun,
	type IntegrityRunDeps,
} from "./runs.js";
import type { IntegrityConfig } from "./types.js";

export const SWEEP_RESTART_AFTER_MS = 10_000;
export const SWEEP_OVERDUE_GRACE_MS = 5 * 60_000;
/** Queued backlog whose workflow exists is still failed after this long. */
export const SWEEP_ABANDON_AFTER_MS = 24 * 3_600_000;
/** agentRunWorkflow's backoff cap between attempts (2s doubling to 30s). */
const WORKFLOW_BACKOFF_CAP_MS = 30_000;
const SWEEP_BATCH = 50;

export interface SweepResult {
	restarted: number;
	failed: number;
}

/**
 * Longest a started run can legitimately stay active: every attempt uses
 * its full lease (the activity's start-to-close budget) plus the maximum
 * backoff, plus grace.
 */
export function integrityRunHorizonMs(
	config: Pick<IntegrityConfig, "timeoutMs">,
	maxAttempts: number,
): number {
	const perAttemptMs = integrityLeaseSeconds(config) * 1000 + WORKFLOW_BACKOFF_CAP_MS;
	return Math.max(1, maxAttempts) * perAttemptMs + SWEEP_OVERDUE_GRACE_MS;
}

async function queuedBefore(
	deps: IntegrityRunDeps,
	before: Date,
): Promise<Array<{ id: string; maxAttempts: number; createdAt: Date }>> {
	return deps.db
		.select({
			id: documentIntegrityRuns.id,
			maxAttempts: documentIntegrityRuns.maxAttempts,
			createdAt: documentIntegrityRuns.createdAt,
		})
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

/** Running rows whose lease expired longer ago than the whole-run horizon. */
async function orphanedRunning(
	deps: IntegrityRunDeps,
	now: Date,
): Promise<Array<{ id: string; leaseToken: string | null }>> {
	const perAttemptMs = integrityLeaseSeconds(deps.config) * 1000 + WORKFLOW_BACKOFF_CAP_MS;
	return deps.db
		.select({ id: documentIntegrityRuns.id, leaseToken: documentIntegrityRuns.leaseToken })
		.from(documentIntegrityRuns)
		.where(
			and(
				eq(documentIntegrityRuns.feature, "document_analysis"),
				eq(documentIntegrityRuns.status, "running"),
				sql`${documentIntegrityRuns.leaseExpiresAt} + (GREATEST(${documentIntegrityRuns.maxAttempts}, 1) * ${perAttemptMs}::bigint + ${SWEEP_OVERDUE_GRACE_MS}::bigint) * interval '1 millisecond' < ${now.toISOString()}::timestamptz`,
			),
		)
		.orderBy(asc(documentIntegrityRuns.leaseExpiresAt))
		.limit(SWEEP_BATCH);
}

/**
 * Re-issues the idempotent start for queued rows older than 10s (when
 * `dispatch`), fails queued rows that cannot be started past the run
 * horizon, and fails running rows orphaned past it.
 */
export async function sweepQueuedIntegrityRuns(
	deps: IntegrityRunDeps,
	opts: { dispatch: boolean; now?: Date },
): Promise<SweepResult> {
	const now = opts.now ?? deps.now?.() ?? new Date();
	const canStart = opts.dispatch && Boolean(deps.starter);
	let failed = 0;
	let restarted = 0;
	for (const row of await queuedBefore(deps, new Date(now.getTime() - SWEEP_RESTART_AFTER_MS))) {
		const ageMs = now.getTime() - row.createdAt.getTime();
		const overdue = ageMs > integrityRunHorizonMs(deps.config, row.maxAttempts);
		let startable = false;
		if (canStart) {
			const outcome = await startIntegrityRun(deps, row);
			startable = outcome === "started" || outcome === "exists";
			if (startable) restarted++;
		}
		const abandon = overdue && (!startable || ageMs > SWEEP_ABANDON_AFTER_MS);
		if (
			abandon &&
			(await failIntegrityRun(deps, row.id, "LEASE_EXPIRED", "queued too long", {
				onlyStatus: "queued",
			}))
		) {
			failed++;
		}
	}
	for (const row of await orphanedRunning(deps, now)) {
		if (!row.leaseToken) continue;
		if (
			await failIntegrityRun(deps, row.id, "LEASE_EXPIRED", "lease abandoned", {
				onlyStatus: "running",
				leaseToken: row.leaseToken,
			})
		) {
			failed++;
		}
	}
	return { restarted, failed };
}
