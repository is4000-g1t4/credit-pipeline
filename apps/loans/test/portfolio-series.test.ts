// weekBuckets/buildSeries unit test (compose-free): SGT Monday boundaries,
// 12-week window oldest first, zero fill.
import { describe, expect, it } from "vitest";
import { buildSeries, weekBuckets } from "../src/portfolio.js";

describe("weekBuckets", () => {
	it("ends with the SGT week containing now, 12 buckets oldest first", () => {
		// Sunday 2026-10-25 23:59 SGT (= 15:59Z) → week starts Mon 2026-10-19.
		const buckets = weekBuckets(new Date("2026-10-25T15:59:00.000Z"));
		expect(buckets).toHaveLength(12);
		expect(buckets[11]).toBe("2026-10-19");
		expect(buckets[0]).toBe("2026-08-03");
		for (let i = 1; i < buckets.length; i++) {
			expect(Date.parse(buckets[i] as string) - Date.parse(buckets[i - 1] as string)).toBe(
				7 * 86_400_000,
			);
		}
	});

	it("a Monday 00:00 SGT belongs to the new week", () => {
		// Mon 2026-10-19 00:00 SGT = Sun 2026-10-18 16:00Z.
		expect(weekBuckets(new Date("2026-10-18T16:00:00.000Z"))[11]).toBe("2026-10-19");
	});

	it("a Sunday 23:59:59 SGT stays in the old week", () => {
		// Sun 2026-10-18 23:59:59 SGT = 15:59:59Z.
		expect(weekBuckets(new Date("2026-10-18T15:59:59.000Z"))[11]).toBe("2026-10-12");
	});
});

describe("buildSeries", () => {
	it("zero-fills weeks with no bookings", () => {
		expect(buildSeries(["2026-10-05", "2026-10-12", "2026-10-19"], { "2026-10-12": 500 })).toEqual([
			{ weekStart: "2026-10-05", bookedCents: 0 },
			{ weekStart: "2026-10-12", bookedCents: 500 },
			{ weekStart: "2026-10-19", bookedCents: 0 },
		]);
	});
});
