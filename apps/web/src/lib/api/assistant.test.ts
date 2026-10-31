import { describe, expect, it } from "vitest";
import { readSseEvents } from "./sse";
import {
	applyToolEvent,
	capAssistantHistory,
	MAX_HISTORY_CHARS,
	MAX_HISTORY_MESSAGES,
	toTraceEntries,
	type CaseAssistantAnswer,
} from "./assistant";

const msg = (i: number, text = `m${i}`) => ({
	role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
	text,
});

describe("capAssistantHistory", () => {
	it("keeps at most the last 8 messages in order", () => {
		const out = capAssistantHistory(Array.from({ length: 12 }, (_, i) => msg(i)));
		expect(out).toHaveLength(MAX_HISTORY_MESSAGES);
		expect(out[0]?.text).toBe("m4");
		expect(out.at(-1)?.text).toBe("m11");
	});

	it("drops the oldest messages until the summed text fits 6000 chars", () => {
		const out = capAssistantHistory(Array.from({ length: 8 }, (_, i) => msg(i, "x".repeat(1000))));
		expect(out).toHaveLength(6);
		expect(out.reduce((n, m) => n + m.text.length, 0)).toBe(MAX_HISTORY_CHARS);
	});
});

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

describe("readStreamEvents", () => {
	it("parses tool then answer frames split across chunks", async () => {
		const answer: CaseAssistantAnswer = {
			answer: "The score is 640.",
			limitations: [],
			toolCalls: [],
			policyRefs: [],
			usage: { inputTokens: 1, outputTokens: 1 },
			model: "m",
			promptVersion: "p",
			agentVersion: "a",
			latencyMs: 5,
		};
		const tool = 'data: {"type":"tool","callId":1,"name":"get_case_facts","status":"running"}\n\n';
		const done = `data: ${JSON.stringify({ type: "answer", answer, latencyMs: 5 })}\n\n`;
		const events = [];
		for await (const event of readSseEvents<Record<string, unknown>>(
			streamFrom([tool.slice(0, 18), tool.slice(18) + done.slice(0, 20), done.slice(20)]),
		)) {
			events.push(event);
		}
		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({ type: "tool", callId: 1, status: "running" });
		expect(events[1]).toMatchObject({ type: "answer", answer: { answer: "The score is 640." } });
	});
});

describe("applyToolEvent", () => {
	it("settles a running row in place and appends a new call", () => {
		const running = [
			{ callId: 1, name: "get_case_facts", status: "running" as const },
			{ callId: 2, name: "search_policy", status: "running" as const },
		];
		const settled = applyToolEvent(running, {
			callId: 1,
			name: "get_case_facts",
			status: "complete",
			resultCount: 1,
			sourceTypes: ["case"],
			durationMs: 12,
		});
		expect(settled[0]).toMatchObject({ status: "complete", resultCount: 1, durationMs: 12 });
		expect(settled[1]?.status).toBe("running");
		expect(
			toTraceEntries([{ name: "get_documents", resultCount: 2, sourceTypes: ["documents"] }]),
		).toEqual([
			{
				name: "get_documents",
				status: "complete",
				resultCount: 2,
				sourceTypes: ["documents"],
			},
		]);
	});
});
