// Reconciler (SPEC FR-6.9): repairs applications whose workflow never
// started or vanished. Describe is trusted only on success — a describe
// error skips the tick, never fails the case. Every status write is
// conditional (markFailed/expiry guards), so terminal states are never
// overwritten. Temporal calls are injected (describe/startWorkflow), as is
// the store, so unit tests run compose-free with fakes.

import { APPLICATION_WORKFLOW_NAME, applicationWorkflowId, TASK_QUEUE } from "@credit/core";
import { applications, decisions } from "@credit/db/applications";
import { loans } from "@credit/db/loans";
import {
	Client,
	Connection,
	WorkflowExecutionAlreadyStartedError,
	WorkflowIdReusePolicy,
	WorkflowNotFoundError,
} from "@temporalio/client";
import { and, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { expireReview } from "./activities/decisions.js";
import { markFailed } from "./activities/fail.js";
import { resumeBooking } from "./activities/booking.js";
import { getApplicationsDb, getLoansDb, reserveApplications } from "./db.js";
import { workerEnv } from "./env.js";
import { logger } from "./logger.js";

// 4243 reuses the loans-relay value safely: advisory locks are
// per-database, and the reconciler runs on the applications DB.
export const RECONCILER_LOCK_KEY = 4243;
export const SUBMITTED_GRACE_MS = 30_000;
export const STALE_ACTIVE_MS = 15 * 60_000;
export const ENDED_WITHOUT_DECISION = "workflow-ended-without-decision";

export type DescribeState = "RUNNING" | "CLOSED" | "NOT_FOUND";
export type StartOutcome = "started" | "already";

export interface ReconcilerApp {
	id: string;
	status: string;
	// T17: null for drafts; reconciler queries only touch submitted rows.
	submittedAt: Date | null;
	updatedAt: Date;
	workflowStartedAt: Date | null;
}

export interface ReconcilerStore {
	listSubmittedUnstarted(cutoff: Date): Promise<ReconcilerApp[]>;
	listSubmittedStarted(): Promise<ReconcilerApp[]>;
	listStaleActive(cutoff: Date): Promise<ReconcilerApp[]>;
	markWorkflowStarted(id: string, now: Date): Promise<void>;
	hasDecisionOrLoan(id: string): Promise<boolean>;
	markFailed(id: string, reason: string): Promise<boolean>;
	markExpired(id: string): Promise<boolean>;
	/** Resume the booking saga from the persisted decision; true when the
	 * application is booked afterwards, false when nothing to repair. */
	repairBooking(id: string): Promise<boolean>;
}

export interface ReconcileCounts {
	started: number;
	alreadyStarted: number;
	failed: number;
	expired: number;
	skipped: number;
	repaired: number;
}

function toApp(row: typeof applications.$inferSelect): ReconcilerApp {
	return {
		id: row.id,
		status: row.status,
		submittedAt: row.submittedAt,
		updatedAt: row.updatedAt,
		workflowStartedAt: row.workflowStartedAt,
	};
}

export function drizzleReconcilerStore(): ReconcilerStore {
	return {
		async listSubmittedUnstarted(cutoff) {
			const { db } = getApplicationsDb();
			const rows = await db
				.select()
				.from(applications)
				.where(
					and(
						eq(applications.status, "submitted"),
						isNull(applications.workflowStartedAt),
						lt(applications.submittedAt, cutoff),
					),
				);
			return rows.map(toApp);
		},
		async listSubmittedStarted() {
			const { db } = getApplicationsDb();
			const rows = await db
				.select()
				.from(applications)
				.where(
					and(eq(applications.status, "submitted"), isNotNull(applications.workflowStartedAt)),
				);
			return rows.map(toApp);
		},
		async listStaleActive(cutoff) {
			const { db } = getApplicationsDb();
			const rows = await db
				.select()
				.from(applications)
				.where(
					and(
						inArray(applications.status, ["processing", "pending_review"]),
						lt(applications.updatedAt, cutoff),
					),
				);
			return rows.map(toApp);
		},
		async markWorkflowStarted(id, now) {
			const { db } = getApplicationsDb();
			await db
				.update(applications)
				.set({ workflowStartedAt: now })
				.where(and(eq(applications.id, id), isNull(applications.workflowStartedAt)));
		},
		async hasDecisionOrLoan(id) {
			const [decisionRows, loanRows] = await Promise.all([
				getApplicationsDb()
					.db.select({ id: decisions.id })
					.from(decisions)
					.where(eq(decisions.applicationId, id)),
				getLoansDb().db.select({ id: loans.id }).from(loans).where(eq(loans.applicationId, id)),
			]);
			return Boolean(decisionRows[0] ?? loanRows[0]);
		},
		// Same conditional guards the workflow path uses — never overwrites
		// a terminal state, decision, or loan.
		async markFailed(id, reason) {
			return (await markFailed({ applicationId: id, reason })).marked;
		},
		async markExpired(id) {
			return (await expireReview({ applicationId: id })).expired;
		},
		async repairBooking(id) {
			const decisionRows = await getApplicationsDb()
				.db.select({ id: decisions.id, outcome: decisions.outcome })
				.from(decisions)
				.where(eq(decisions.applicationId, id));
			if (!decisionRows[0] || decisionRows[0].outcome !== "approved") return false;
			await resumeBooking(id);
			return true;
		},
	};
}

let temporalClient: Client | null = null;

async function getTemporalClient(): Promise<Client> {
	if (!temporalClient) {
		const connection = await Connection.connect({
			address: workerEnv.temporalAddress,
		});
		temporalClient = new Client({ connection });
	}
	return temporalClient;
}

export async function describeWorkflow(workflowId: string): Promise<DescribeState> {
	const client = await getTemporalClient();
	try {
		const description = await client.workflow.getHandle(workflowId).describe();
		return description.status.name === "RUNNING" ? "RUNNING" : "CLOSED";
	} catch (err) {
		if (err instanceof WorkflowNotFoundError) return "NOT_FOUND";
		throw err;
	}
}

export async function startApplicationWorkflow(applicationId: string): Promise<StartOutcome> {
	const client = await getTemporalClient();
	try {
		await client.workflow.start(APPLICATION_WORKFLOW_NAME, {
			args: [{ applicationId }],
			taskQueue: TASK_QUEUE,
			workflowId: applicationWorkflowId(applicationId),
			workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
		});
		return "started";
	} catch (err) {
		if (err instanceof WorkflowExecutionAlreadyStartedError) return "already";
		throw err;
	}
}

async function describeOf(
	describe: (workflowId: string) => Promise<DescribeState>,
	applicationId: string,
): Promise<DescribeState | null> {
	try {
		return await describe(applicationWorkflowId(applicationId));
	} catch {
		return null; // describe errors skip the tick, never fail the case
	}
}

export async function reconcileOnce(opts: {
	now: Date;
	describe?: (workflowId: string) => Promise<DescribeState>;
	startWorkflow?: (applicationId: string) => Promise<StartOutcome>;
	store?: ReconcilerStore;
}): Promise<ReconcileCounts> {
	const store = opts.store ?? drizzleReconcilerStore();
	const describe = opts.describe ?? describeWorkflow;
	const startWorkflow = opts.startWorkflow ?? startApplicationWorkflow;
	const counts: ReconcileCounts = {
		started: 0,
		alreadyStarted: 0,
		failed: 0,
		expired: 0,
		skipped: 0,
		repaired: 0,
	};

	// (a) submitted, never started, older than 30s → start (REJECT_DUPLICATE;
	// AlreadyStarted maps to "already" and still records started_at).
	for (const app of await store.listSubmittedUnstarted(
		new Date(opts.now.getTime() - SUBMITTED_GRACE_MS),
	)) {
		const outcome = await startWorkflow(app.id);
		await store.markWorkflowStarted(app.id, opts.now);
		if (outcome === "already") counts.alreadyStarted++;
		else counts.started++;
	}

	// (b) submitted with a started workflow: only a SUCCESSFUL describe of
	// CLOSED/NOT_FOUND with no decision/loan fails the case.
	for (const app of await store.listSubmittedStarted()) {
		const state = await describeOf(describe, app.id);
		if (state === null) {
			counts.skipped++;
			continue;
		}
		if (state !== "CLOSED" && state !== "NOT_FOUND") continue;
		if (await store.hasDecisionOrLoan(app.id)) continue;
		if (await store.markFailed(app.id, ENDED_WITHOUT_DECISION)) counts.failed++;
	}

	// (c) processing|pending_review older than 15 min with a successfully
	// described CLOSED/NOT_FOUND workflow → failed (processing) / expired —
	// unless a decision/loan exists, in which case the booking saga is
	// resumed from the persisted decision instead of being failed.
	for (const app of await store.listStaleActive(new Date(opts.now.getTime() - STALE_ACTIVE_MS))) {
		const state = await describeOf(describe, app.id);
		if (state === null) {
			counts.skipped++;
			continue;
		}
		if (state !== "CLOSED" && state !== "NOT_FOUND") continue;
		if (await store.hasDecisionOrLoan(app.id)) {
			// Approved decision with no loan yet (or a loan whose booked flip
			// was lost): resume the idempotent saga. A repair error is
			// transient by policy — skip and retry next tick, never fail the
			// case into a terminal state an approved booking cannot leave.
			try {
				if (await store.repairBooking(app.id)) counts.repaired++;
				else counts.skipped++;
			} catch (err) {
				// Retry policy: never terminalise an approved case on a repair
				// error. Surface it for operators and retry next tick.
				logger.error(
					{ applicationId: app.id, err },
					"reconciler: booking repair failed",
				);
				counts.skipped++;
			}
			continue;
		}
		if (app.status === "processing") {
			if (await store.markFailed(app.id, ENDED_WITHOUT_DECISION)) counts.failed++;
		} else if (app.status === "pending_review") {
			if (await store.markExpired(app.id)) counts.expired++;
		}
	}

	return counts;
}

export interface ReconcilerLoopHandle {
	stop(): Promise<void>;
}

/** 30s loop guarded by advisory lock 4243 (multi-worker safe). Tick errors
 * are logged, never thrown. */
export function startReconcilerLoop(opts: { intervalMs?: number } = {}): ReconcilerLoopHandle {
	const intervalMs = opts.intervalMs ?? 30_000;
	let stopped = false;
	let inFlight: Promise<void> | null = null;

	const tick = async () => {
		const conn = await reserveApplications();
		try {
			const rows =
				(await conn`SELECT pg_try_advisory_lock(${RECONCILER_LOCK_KEY}) AS "locked"`) as unknown as Array<{
					locked: boolean;
				}>;
			if (rows[0]?.locked !== true) return;
			try {
				await reconcileOnce({ now: new Date() });
			} catch (err) {
				logger.error({ err }, "worker reconciler: tick failed");
			} finally {
				try {
					await conn`SELECT pg_advisory_unlock(${RECONCILER_LOCK_KEY})`;
				} catch (err) {
					logger.error({ err }, "worker reconciler: unlock failed");
				}
			}
		} catch (err) {
			logger.error({ err }, "worker reconciler: lock failed");
		} finally {
			conn.release();
		}
	};

	const timer = setInterval(() => {
		if (stopped || inFlight) return;
		inFlight = tick()
			.catch((err) => {
				logger.error({ err }, "worker reconciler: tick failed");
			})
			.finally(() => {
				inFlight = null;
			});
	}, intervalMs);
	timer.unref?.();

	return {
		async stop() {
			stopped = true;
			clearInterval(timer);
			await inFlight?.catch(() => {});
		},
	};
}
