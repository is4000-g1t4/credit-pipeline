// UBS §1 queue read-model unit tests: pure helpers, no DB.
import { describe, expect, it } from "vitest";
import {
	clientNameFor,
	flagsForQueueItem,
	riskForScore,
	summarizeQueue,
	topFactorCodes,
	type QueueSummaryItem,
} from "../src/routes/queue-summary.js";

const item = (over: Partial<QueueSummaryItem> = {}): QueueSummaryItem => ({
	id: "00000000-0000-4000-8000-000000000000",
	waitMs: 1_000,
	flags: { referred: false, aboveAutoLimit: false },
	...over,
});

describe("riskForScore", () => {
	it("thresholds at 760/640, missing score is medium", () => {
		expect(riskForScore(800)).toBe("low");
		expect(riskForScore(760)).toBe("low");
		expect(riskForScore(759)).toBe("medium");
		expect(riskForScore(640)).toBe("medium");
		expect(riskForScore(639)).toBe("high");
		expect(riskForScore(null)).toBe("medium");
		expect(riskForScore(undefined)).toBe("medium");
	});
});

describe("flagsForQueueItem", () => {
	it("referred on refer outcome or any reason; aboveLimit only on the code", () => {
		expect(flagsForQueueItem("refer", [])).toEqual({ referred: true, aboveAutoLimit: false });
		expect(flagsForQueueItem("pass", ["SCORE_TOO_LOW"])).toEqual({
			referred: true,
			aboveAutoLimit: false,
		});
		expect(flagsForQueueItem("pass", ["AMOUNT_ABOVE_AUTO_LIMIT"])).toEqual({
			referred: true,
			aboveAutoLimit: true,
		});
		expect(flagsForQueueItem("pass", [])).toEqual({ referred: false, aboveAutoLimit: false });
		expect(flagsForQueueItem(null, [])).toEqual({ referred: false, aboveAutoLimit: false });
	});
});

describe("clientNameFor / topFactorCodes", () => {
	it("sme uses companyName, otherwise fullName", () => {
		expect(clientNameFor("sme", { fullName: "Owner" }, { companyName: "Acme Pte Ltd" })).toBe(
			"Acme Pte Ltd",
		);
		expect(clientNameFor("individual", { fullName: "Jane Doe" }, null)).toBe("Jane Doe");
	});
	it("top factors by |points|, max 5", () => {
		const factors = [
			{ code: "A", points: 5 },
			{ code: "B", points: -40 },
			{ code: "C", points: 75 },
			{ code: "D", points: 1 },
			{ code: "E", points: 2 },
			{ code: "F", points: 3 },
		];
		expect(topFactorCodes(factors)).toEqual(["C", "B", "A", "F", "E"]);
	});
});

describe("summarizeQueue", () => {
	it("empty queue is JSON-stable", () => {
		expect(summarizeQueue([], 0)).toEqual({
			total: 0,
			shown: 0,
			truncated: false,
			medianWaitMs: 0,
			over24hCount: 0,
			referredCount: 0,
			aboveAutoLimitCount: 0,
			oldestCaseId: null,
		});
	});
	it("odd median takes the middle", () => {
		const s = summarizeQueue(
			[item({ id: "a", waitMs: 10 }), item({ id: "b", waitMs: 30 }), item({ id: "c", waitMs: 20 })],
			3,
		);
		expect(s.medianWaitMs).toBe(20);
		expect(s.shown).toBe(3);
		expect(s.total).toBe(3);
		expect(s.truncated).toBe(false);
		expect(s.oldestCaseId).toBe("a");
	});
	it("even median averages the middle two, rounded", () => {
		const s = summarizeQueue([item({ waitMs: 10 }), item({ waitMs: 21 })], 2);
		expect(s.medianWaitMs).toBe(16);
	});
	it("below the cap forces total = shown; at the cap clamps up", () => {
		const full = Array.from({ length: 100 }, (_, i) => item({ id: `id-${i}`, waitMs: i }));
		expect(summarizeQueue(full.slice(0, 99), 5_000).total).toBe(99);
		expect(summarizeQueue(full, 5_000)).toMatchObject({ total: 5_000, truncated: true });
		expect(summarizeQueue(full, 12).total).toBe(100);
	});
	it("counts over-24h, referred and above-limit over returned items", () => {
		const s = summarizeQueue(
			[
				item({ id: "a", waitMs: 90_000_000, flags: { referred: true, aboveAutoLimit: true } }),
				item({ id: "b", waitMs: 1_000, flags: { referred: true, aboveAutoLimit: false } }),
				item({ id: "c", waitMs: 1_000, flags: { referred: false, aboveAutoLimit: false } }),
			],
			3,
		);
		expect(s).toMatchObject({
			over24hCount: 1,
			referredCount: 2,
			aboveAutoLimitCount: 1,
			oldestCaseId: "a",
		});
	});
});
