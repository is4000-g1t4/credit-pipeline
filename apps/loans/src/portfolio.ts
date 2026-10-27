// Portfolio summary helpers (SPEC §5): SGT week buckets + zero-filled series.
// Pure (no DB) so Monday boundaries are unit-testable without compose.
import { reportingWeekStart } from "@credit/core";

export const SERIES_WEEKS = 12;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 12 Monday-start (YYYY-MM-DD, SGT) week buckets ending with the current
 * week, oldest first. */
export function weekBuckets(now: Date = new Date(), weeks: number = SERIES_WEEKS): string[] {
	const start = reportingWeekStart(now);
	const [y, m, d] = start.split("-").map(Number);
	const base = Date.UTC(y as number, (m as number) - 1, d as number);
	return Array.from({ length: weeks }, (_, i) =>
		new Date(base - (weeks - 1 - i) * 7 * DAY_MS).toISOString().slice(0, 10),
	);
}

/** Merge per-week booked totals onto the bucket list; missing weeks zero-fill. */
export function buildSeries(
	weeks: string[],
	bookedByWeek: Record<string, number>,
): Array<{ weekStart: string; bookedCents: number }> {
	return weeks.map((weekStart) => ({ weekStart, bookedCents: bookedByWeek[weekStart] ?? 0 }));
}

/** bigint cents (pg may return string|number|bigint) → safe JS number. */
export function toCents(value: unknown): number {
	if (value === null || value === undefined) return 0;
	return Number(value);
}
