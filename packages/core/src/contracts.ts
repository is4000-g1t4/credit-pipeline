// Workflow/schedule contract (SPEC FR-6.1/6.2, FR-6.5): queue name, workflow
// IDs, and the officer-decision update name. Workflows, activities, the API,
// and tests all import these — never inline the strings.
export const TASK_QUEUE = "credit-pipeline";

export function applicationWorkflowId(applicationId: string): string {
	return `app-${applicationId}`;
}

export const OFFICER_DECISION_UPDATE = "officerDecision";

export const MONITORING_SCHEDULE_ID = "monitoring";
export const monitoringWorkflowName = "monitoringWorkflow";
