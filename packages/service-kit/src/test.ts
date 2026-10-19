// Fake WorkflowGateway for service tests: records calls, returns canned
// results, or throws a canned GatewayError. Production code never touches
// this — only unit/integration tests import it.
import {
	GatewayError,
	type MonitoringCounts,
	type OfficerDecisionInput,
	type OfficerDecisionResult,
	type WorkflowGateway,
} from "./gateway.js";

export interface FakeGateway extends WorkflowGateway {
	started: string[];
	decisionCalls: Array<{ applicationId: string; input: OfficerDecisionInput }>;
	monitoringCalls: number;
	decisionResult: OfficerDecisionResult;
	decisionError: GatewayError | null;
	monitoringResult: MonitoringCounts;
	monitoringTimedOut: boolean;
	monitoringError: GatewayError | null;
}

export function stubGateway(): FakeGateway {
	const fake: FakeGateway = {
		started: [],
		decisionCalls: [],
		monitoringCalls: 0,
		decisionResult: {
			outcome: "booked",
			decisionId: "decision-1",
			loanId: "loan-1",
		},
		decisionError: null,
		monitoringResult: { markedOverdue: 0, alertsCreated: 0, loansUpdated: 0 },
		monitoringTimedOut: false,
		monitoringError: null,
		async startApplication(applicationId: string): Promise<void> {
			fake.started.push(applicationId);
		},
		async sendOfficerDecision(
			applicationId: string,
			input: OfficerDecisionInput,
		): Promise<OfficerDecisionResult> {
			fake.decisionCalls.push({ applicationId, input });
			if (fake.decisionError) throw fake.decisionError;
			return fake.decisionResult;
		},
		async runMonitoring(_manual: boolean): Promise<{
			counts: MonitoringCounts | null;
			workflowId: string;
			timedOut: boolean;
		}> {
			fake.monitoringCalls++;
			if (fake.monitoringError) throw fake.monitoringError;
			if (fake.monitoringTimedOut) {
				return {
					counts: null,
					workflowId: "monitoring-manual-test",
					timedOut: true,
				};
			}
			return {
				counts: fake.monitoringResult,
				workflowId: "monitoring-manual-test",
				timedOut: false,
			};
		},
	};
	return fake;
}
