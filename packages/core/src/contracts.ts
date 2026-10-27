// Workflow/schedule contract (SPEC FR-6.1/6.2, FR-6.5): queue name, workflow
// IDs, and the officer-decision update name. Workflows, activities, the API,
// and tests all import these — never inline the strings.
import type { OfficerReasonCode } from "./reasons.js";
import type { ResearchBundle } from "./schemas.js";
export const TASK_QUEUE = "credit-pipeline";

export function applicationWorkflowId(applicationId: string): string {
	return `app-${applicationId}`;
}

export const OFFICER_DECISION_UPDATE = "officerDecision";

export const MONITORING_SCHEDULE_ID = "monitoring";
export const monitoringWorkflowName = "monitoringWorkflow";
export const APPLICATION_WORKFLOW_NAME = "applicationWorkflow";

// Single home for the officer-decision update contract (SPEC FR-6.2): the
// gateway's WorkflowGateway, the worker's update handler/activities, and
// their tests all import these — never redeclare them.
export interface OfficerDecisionInput {
	requestId: string;
	outcome: "approve" | "decline";
	approvedAmountCents?: number;
	termMonths?: number;
	reasonCode?: OfficerReasonCode;
	notes?: string;
	officerUserId?: string;
	/** Server-built frozen bundle (review resolves the public selection to
	 * this; the selection itself never travels here). */
	research?: ResearchBundle;
}

export interface OfficerDecisionResult {
	outcome: "booked" | "declined";
	decisionId: string;
	loanId: string | null;
}

// Single home for the monitoring counts shape (SPEC FR-6.5): the gateway's
// runMonitoring result and the worker's runMonitoring activity return this.
export interface MonitoringCounts {
	markedOverdue: number;
	alertsCreated: number;
	loansUpdated: number;
}
