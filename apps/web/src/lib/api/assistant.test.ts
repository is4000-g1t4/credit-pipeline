import { describe, expect, it } from "vitest";
import { capAssistantHistory, MAX_HISTORY_CHARS, MAX_HISTORY_MESSAGES } from "./assistant";

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
