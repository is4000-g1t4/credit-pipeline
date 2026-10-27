// SGT reporting boundaries: the dashboard day flips at 00:00 Asia/Singapore,
// not UTC, and weeks start on Monday.
import { describe, expect, it } from "vitest";
import { REPORTING_TIMEZONE, reportingDay, reportingWeekStart } from "../src/index.js";

describe("reporting calendar", () => {
	it("uses Asia/Singapore", () => {
		expect(REPORTING_TIMEZONE).toBe("Asia/Singapore");
	});

	it("reportingDay flips at SGT midnight, not UTC midnight", () => {
		// 2026-10-26T16:30Z = 2026-10-27T00:30 SGT
		expect(reportingDay(new Date("2026-10-26T16:30:00Z"))).toBe("2026-10-27");
		// 2026-10-26T15:59Z = 2026-10-26T23:59 SGT
		expect(reportingDay(new Date("2026-10-26T15:59:00Z"))).toBe("2026-10-26");
		expect(reportingDay(new Date("2026-10-26T00:00:00Z"))).toBe("2026-10-26");
	});

	it("reportingWeekStart is the Monday of the SGT week", () => {
		// Tuesday 2026-10-27 SGT
		expect(reportingWeekStart(new Date("2026-10-27T10:00:00+08:00"))).toBe("2026-10-26");
		// Monday itself
		expect(reportingWeekStart(new Date("2026-10-26T00:00:00+08:00"))).toBe("2026-10-26");
		// Sunday 2026-11-01 SGT belongs to the week starting Monday 10-26
		expect(reportingWeekStart(new Date("2026-11-01T23:59:00+08:00"))).toBe("2026-10-26");
		// Next Monday starts a new week
		expect(reportingWeekStart(new Date("2026-11-02T00:00:00+08:00"))).toBe("2026-11-02");
		// Sunday 2026-11-01T16:30Z is Monday 11-02 SGT
		expect(reportingWeekStart(new Date("2026-11-01T16:30:00Z"))).toBe("2026-11-02");
	});
});
