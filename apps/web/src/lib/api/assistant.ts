// Case-scoped officer assistant (Ask tab, case-assistant). Read-only Q&A
// over the case evidence bundle; advisory only — answers never decide,
// score, price, or book the case.
import { api } from "./client";

export interface CaseAssistantToolCall {
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

export interface CaseAssistantAnswer {
	answer: string;
	limitations: string[];
	toolCalls: CaseAssistantToolCall[];
	policyRefs: CaseAssistantPolicyRef[];
	usage: { inputTokens: number; outputTokens: number };
	model: string;
	promptVersion: string;
	agentVersion: string;
	latencyMs: number;
}

export interface CaseAssistantMessage {
	role: "user" | "assistant";
	text: string;
}

/** Server bounds (review + research): 8 trailing messages, 6000 chars total.
 * Keep the browser inside them so the chat does not 422 after a few turns. */
export const MAX_HISTORY_MESSAGES = 8;
export const MAX_HISTORY_CHARS = 6000;

export function capAssistantHistory(messages: CaseAssistantMessage[]): CaseAssistantMessage[] {
	const out = messages.slice(-MAX_HISTORY_MESSAGES);
	let total = out.reduce((n, m) => n + m.text.length, 0);
	while (total > MAX_HISTORY_CHARS && out.length > 0) {
		total -= out.shift()!.text.length;
	}
	return out;
}

export function askCaseAssistant(
	applicationId: string,
	question: string,
	history: CaseAssistantMessage[],
): Promise<CaseAssistantAnswer> {
	return api<CaseAssistantAnswer>(`/api/review/${applicationId}/assistant`, {
		method: "POST",
		body: { question, history },
	});
}
