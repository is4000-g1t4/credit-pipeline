// Fake WorkflowGateway for service tests: records calls, returns canned
// results, or throws a canned GatewayError. Production code never touches
// this — only unit/integration tests import it.
import { randomUUID } from "node:crypto";
import {
	GatewayError,
	type MonitoringCounts,
	type OfficerDecisionInput,
	type OfficerDecisionResult,
	type WorkflowGateway,
} from "./gateway.js";
import { signInternalHeaders, type InternalRole, type InternalUser } from "./internal.js";

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

/** Synthetic user for `app.request` tests (identity is signed headers
 * only — most service DBs carry no users table). Same shape as
 * `InternalUser`; ids/emails are unique per call. */
export function testUser(
	role: InternalRole = "applicant",
	overrides: { id?: string; email?: string } = {},
): InternalUser {
	const id = overrides.id ?? randomUUID();
	return { id, email: overrides.email ?? `${role}-${id}@example.com`, role };
}

export interface SignedTestHeadersOptions {
	/** Exact request bytes being sent; omitted signs the empty hash. */
	body?: string | ArrayBuffer | Uint8Array | null;
	requestId?: string;
	/** Millis since epoch; defaults to now. */
	ts?: number;
	/** Merged over the signed headers (e.g. content-type). */
	extra?: Record<string, string>;
}

/** Signed internal headers for `app.request`, as the gateway would send. */
export function signedInternalHeaders(
	secret: string,
	user: Pick<InternalUser, "id" | "email" | "role">,
	method: string,
	path: string,
	opts: SignedTestHeadersOptions = {},
): Record<string, string> {
	return {
		...signInternalHeaders(secret, {
			userId: user.id,
			role: user.role,
			email: user.email,
			method,
			path,
			body: opts.body,
			requestId: opts.requestId,
			ts: opts.ts,
		}),
		...opts.extra,
	};
}

/** JSON stub Response for downstream fetch fakes; status defaults to 200. */
export function jsonResponse(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}
