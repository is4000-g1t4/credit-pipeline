// monitoringWorkflow (SPEC FR-6.5): one runMonitoring call. "Today" comes
// from the workflow clock (Date.now is workflow-time inside bundles),
// formatted UTC YYYY-MM-DD to match the date column. The activity is
// idempotent, so overlapping schedule/manual runs converge.
import { proxyActivities } from "@temporalio/workflow";
import type { Activities, MonitoringResult } from "../activities/types.js";

const acts = proxyActivities<Pick<Activities, "runMonitoring">>({
	startToCloseTimeout: "30 seconds",
	retry: { maximumAttempts: 3 },
});

export interface MonitoringWorkflowInput {
	manual?: boolean;
}

export async function monitoringWorkflow(
	input: MonitoringWorkflowInput = {},
): Promise<MonitoringResult> {
	void input.manual;
	const todayUtc = new Date(Date.now()).toISOString().slice(0, 10);
	return await acts.runMonitoring({ todayUtc });
}
