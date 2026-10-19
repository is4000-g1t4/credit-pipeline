// Temporal gateway (SPEC FR-1.8, FR-6.2, FR-6.5/8.5): a service's only path
// to workflow state — production code never imports @credit/worker, only
// @credit/core contracts + the Temporal client directly. The interface keeps
// a factory seam so tests inject a fake.
import { randomUUID } from "node:crypto";
import {
	applicationWorkflowId,
	monitoringWorkflowName,
	OFFICER_DECISION_UPDATE,
	TASK_QUEUE,
} from "@credit/core";
import {
	Client,
	Connection,
	WorkflowExecutionAlreadyStartedError,
	WorkflowIdReusePolicy,
	WorkflowNotFoundError,
} from "@temporalio/client";

export interface OfficerDecisionInput {
	requestId: string;
	outcome: "approve" | "decline";
	approvedAmountCents?: number;
	termMonths?: number;
	reasonCode?: "OFFICER_JUDGEMENT" | "INSUFFICIENT_EVIDENCE" | "POLICY_EXCEPTION";
	notes?: string;
	officerUserId?: string;
}

export interface OfficerDecisionResult {
	outcome: "booked" | "declined";
	decisionId: string;
	loanId: string | null;
}

export interface MonitoringCounts {
	markedOverdue: number;
	alertsCreated: number;
	loansUpdated: number;
}

export interface WorkflowGateway {
	startApplication(applicationId: string): Promise<void>;
	sendOfficerDecision(
		applicationId: string,
		input: OfficerDecisionInput,
	): Promise<OfficerDecisionResult>;
	runMonitoring(manual: boolean): Promise<{
		counts: MonitoringCounts | null;
		workflowId: string;
		timedOut: boolean;
	}>;
}

/** Typed gateway failure — routes map it straight to the status/code. */
export class GatewayError extends Error {
	constructor(
		public status: number,
		public code: string,
		message: string,
	) {
		super(message);
	}
}

/**
 * Pure Temporal-update error mapping (SPEC §6): validator failures → 422,
 * state conflicts / not running → 409, anything else → 500 (message
 * scrubbed — Temporal failure chains can carry internals).
 */
export function mapDecisionError(err: unknown): {
	status: 422 | 409 | 500;
	code: string;
	message: string;
} {
	if (err instanceof WorkflowNotFoundError) {
		return {
			status: 409,
			code: "CASE_NOT_RUNNING",
			message: "case is not running",
		};
	}
	const message =
		err instanceof Error ? (err.message.split("\n")[0] ?? "decision failed") : String(err);
	if (/not running|not found|no such workflow/i.test(message)) {
		return { status: 409, code: "CASE_NOT_RUNNING", message };
	}
	if (
		/not awaiting|already exists|already decided|already booked|conflict|in progress|inprogress/i.test(
			message,
		)
	) {
		return { status: 409, code: "DECISION_CONFLICT", message };
	}
	if (/invalid|rejected|breach|must be|required|terms|out of range|exceeds/i.test(message)) {
		return { status: 422, code: "DECISION_REJECTED", message };
	}
	return {
		status: 500,
		code: "DECISION_FAILED",
		message: "officer decision failed",
	};
}

const MONITORING_TIMEOUT_MS = 30_000;

export function createTemporalGateway(opts: { address: string }): WorkflowGateway {
	let cached: Promise<Client> | null = null;
	const getClient = (): Promise<Client> => {
		cached ??= (async () => {
			const connection = await Connection.connect({ address: opts.address });
			return new Client({ connection });
		})().catch((err: unknown) => {
			// A failed connect must not poison the cache — the next request
			// reconnects instead of replaying the same rejection forever.
			cached = null;
			throw err;
		});
		return cached;
	};

	return {
		async startApplication(applicationId: string): Promise<void> {
			const client = await getClient();
			try {
				await client.workflow.start("applicationWorkflow", {
					args: [{ applicationId }],
					taskQueue: TASK_QUEUE,
					workflowId: applicationWorkflowId(applicationId),
					workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
				});
			} catch (err) {
				// AlreadyStarted is success (FR-1.8) — reconciler owns the rest.
				if (err instanceof WorkflowExecutionAlreadyStartedError) return;
				throw err;
			}
		},

		async sendOfficerDecision(
			applicationId: string,
			input: OfficerDecisionInput,
		): Promise<OfficerDecisionResult> {
			const client = await getClient();
			try {
				return await client.workflow
					.getHandle(applicationWorkflowId(applicationId))
					.executeUpdate(OFFICER_DECISION_UPDATE, { args: [input] });
			} catch (err) {
				const mapped = mapDecisionError(err);
				throw new GatewayError(mapped.status, mapped.code, mapped.message);
			}
		},

		async runMonitoring(manual: boolean): Promise<{
			counts: MonitoringCounts | null;
			workflowId: string;
			timedOut: boolean;
		}> {
			const client = await getClient();
			const workflowId = `monitoring-manual-${randomUUID()}`;
			const handle = await client.workflow.start(monitoringWorkflowName, {
				args: [{ manual }],
				taskQueue: TASK_QUEUE,
				workflowId,
			});
			let timer: ReturnType<typeof setTimeout> | null = null;
			try {
				const counts = await Promise.race([
					handle.result(),
					new Promise<null>((resolve) => {
						timer = setTimeout(() => resolve(null), MONITORING_TIMEOUT_MS);
					}),
				]);
				if (counts === null) return { counts: null, workflowId, timedOut: true };
				return {
					counts: counts as MonitoringCounts,
					workflowId,
					timedOut: false,
				};
			} finally {
				if (timer) clearTimeout(timer);
			}
		},
	};
}
