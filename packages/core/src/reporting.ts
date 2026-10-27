// One reporting timezone for every day/week boundary the UI shows (spec §1).
// Asia/Singapore is UTC+8 with no DST, so a constant offset is exact; using
// Intl here would make these pure helpers environment-dependent.

export const REPORTING_TIMEZONE = "Asia/Singapore";

const OFFSET_MS = 8 * 60 * 60 * 1000;

/** Reporting-calendar date (YYYY-MM-DD) containing `now`. */
export function reportingDay(now: Date): string {
	return shifted(now).toISOString().slice(0, 10);
}

/** Monday (YYYY-MM-DD) of the reporting week containing `now`. */
export function reportingWeekStart(now: Date): string {
	const day = shifted(now);
	day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
	return day.toISOString().slice(0, 10);
}

function shifted(now: Date): Date {
	return new Date(now.getTime() + OFFSET_MS);
}
