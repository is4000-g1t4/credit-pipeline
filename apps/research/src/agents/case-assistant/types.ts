// Public types and the error class of the case assistant (agent-private
// module; the agent's index re-exports them).
import type { Observability } from "../../observability.js";

export type CaseAssistantErrorCode =
	| "UNSAFE_OUTPUT"
	| "INVALID_OUTPUT"
	| "CASE_ASSISTANT_TIMEOUT"
	| "CASE_ASSISTANT_FAILED"
	| "CASE_ASSISTANT_UNAVAILABLE";

export class CaseAssistantError extends Error {
	constructor(
		public code: CaseAssistantErrorCode,
		message: string,
	) {
		super(message);
	}
}

export interface CaseAssistantHistoryMessage {
	role: "user" | "assistant";
	text: string;
}

export interface CaseAssistantInput {
	applicationId: string;
	caseFacts: Record<string, unknown>;
	asOfDate: string;
	question: string;
	history: CaseAssistantHistoryMessage[];
	actorId: string;
	actorRole: string;
	signal: AbortSignal;
	runId?: string;
	observability?: Observability;
	/** Best-effort progress callback for live tool activity (SSE). */
	onToolEvent?: (event: CaseAssistantToolEvent) => void;
}

/** One tool call's live progress; metadata only, never args or results. */
export interface CaseAssistantToolEvent {
	callId: number;
	name: string;
	status: "running" | "complete" | "error";
	resultCount?: number;
	sourceTypes?: string[];
	durationMs?: number;
}

export interface CaseAssistantToolTrace {
	name: string;
	resultCount: number;
	sourceTypes: string[];
}

export interface CaseAssistantPolicyRef {
	policyKey: string;
	sectionId: string;
	heading: string;
	version: string;
	effectiveFrom: string;
	policyVersionId: string;
	quote: string;
	drawerToken: string;
}

export interface CaseAssistantOutput {
	answer: string;
	limitations: string[];
	toolCalls: CaseAssistantToolTrace[];
	policyRefs: CaseAssistantPolicyRef[];
	usage: { inputTokens: number; outputTokens: number };
	model: string;
	promptVersion: string;
	agentVersion: string;
}

export interface CaseAssistantRunner {
	run(input: CaseAssistantInput): Promise<CaseAssistantOutput>;
}
