// Case-scoped officer assistant (Ask tab, case-assistant). Read-only Q&A
// over the case evidence bundle; advisory only — answers never decide,
// score, price, or book the case.
import { ApiError, parseApiError } from "./client";

export interface CaseAssistantToolCall {
	name: string;
	resultCount: number;
	sourceTypes: string[];
}

/** UI row for a tool call, live or settled (metadata only). */
export interface AssistantToolEntry {
	callId?: number;
	name: string;
	status: "running" | "complete" | "error";
	resultCount?: number;
	sourceTypes?: string[];
	durationMs?: number;
}

/** Final answer trace → settled entries (no durations available there). */
export function toTraceEntries(calls: CaseAssistantToolCall[]): AssistantToolEntry[] {
	return calls.map((call) => ({
		name: call.name,
		status: "complete",
		resultCount: call.resultCount,
		sourceTypes: call.sourceTypes,
	}));
}

/** Upsert by callId so a running row settles in place. */
export function applyToolEvent(
	entries: AssistantToolEntry[],
	event: CaseAssistantToolEvent,
): AssistantToolEntry[] {
	const next = entries.findIndex((entry) => entry.callId === event.callId);
	const row: AssistantToolEntry = { ...event };
	if (next < 0) return [...entries, row];
	return entries.map((entry, i) => (i === next ? { ...entry, ...row } : entry));
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

/** Live progress row (metadata only; no args or tool output). */
export interface CaseAssistantToolEvent {
	callId: number;
	name: string;
	status: "running" | "complete" | "error";
	resultCount?: number;
	sourceTypes?: string[];
	durationMs?: number;
}

type StreamEvent =
	| ({ type: "tool" } & CaseAssistantToolEvent)
	| { type: "answer"; answer: CaseAssistantAnswer; latencyMs: number }
	| { type: "error"; status: number; code: string; message: string };

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

/** Ask with live tool progress: tool events arrive over SSE, then the answer. */
export async function askCaseAssistant(
	applicationId: string,
	question: string,
	history: CaseAssistantMessage[],
	onTool: (event: CaseAssistantToolEvent) => void,
): Promise<CaseAssistantAnswer> {
	const res = await fetch(`/api/review/${applicationId}/assistant`, {
		method: "POST",
		credentials: "include",
		headers: {
			"content-type": "application/json",
			accept: "text/event-stream",
		},
		body: JSON.stringify({ question, history }),
	});
	if (!res.ok) {
		let data: unknown;
		try {
			data = await res.json();
		} catch {
			data = undefined;
		}
		throw parseApiError(res, data);
	}
	// Older/edge proxies may still return the buffered JSON contract.
	if (!res.headers.get("content-type")?.includes("text/event-stream")) {
		return (await res.json()) as CaseAssistantAnswer;
	}
	if (!res.body) throw new ApiError(502, "BAD_GATEWAY", "assistant stream unavailable");
	for await (const event of readStreamEvents(res.body)) {
		if (event.type === "tool") {
			onTool(event);
		} else if (event.type === "answer") {
			return event.answer;
		} else {
			throw new ApiError(event.status, event.code, event.message);
		}
	}
	throw new ApiError(502, "BAD_GATEWAY", "assistant stream ended unexpectedly");
}

/** Parse one SSE response body into typed events. Exported for tests. */
export async function* readStreamEvents(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let boundary = buffer.indexOf("\n\n");
			while (boundary >= 0) {
				const frame = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const data = frame
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trimStart())
					.join("\n");
				if (data) yield JSON.parse(data) as StreamEvent;
				boundary = buffer.indexOf("\n\n");
			}
		}
	} finally {
		reader.releaseLock();
	}
}
