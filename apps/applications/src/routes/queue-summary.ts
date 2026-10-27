// UBS queue read model (§1): pure item/summary projections for
// GET /internal/review/queue. No DB, no fraud fields — unit-tested.
export type QueueRisk = "low" | "medium" | "high";

export interface QueueFlags {
	referred: boolean;
	aboveAutoLimit: boolean;
}

export interface QueueSummaryItem {
	id: string;
	waitMs: number;
	flags: QueueFlags;
}

export interface QueueSummary {
	total: number;
	shown: number;
	truncated: boolean;
	medianWaitMs: number;
	over24hCount: number;
	referredCount: number;
	aboveAutoLimitCount: number;
	oldestCaseId: string | null;
}

export const OVER_24H_MS = 86_400_000;
export const QUEUE_CAP = 100;

export function riskForScore(score: number | null | undefined): QueueRisk {
	if (score === null || score === undefined) return "medium";
	if (score >= 760) return "low";
	if (score >= 640) return "medium";
	return "high";
}

export function flagsForQueueItem(
	outcome: string | null | undefined,
	reasons: string[],
): QueueFlags {
	return {
		referred: outcome === "refer" || reasons.length > 0,
		aboveAutoLimit: reasons.includes("AMOUNT_ABOVE_AUTO_LIMIT"),
	};
}

export function clientNameFor(
	type: string,
	identity: { fullName?: string } | null | undefined,
	business: { companyName?: string } | null | undefined,
): string {
	if (type === "sme") return business?.companyName ?? identity?.fullName ?? "";
	return identity?.fullName ?? "";
}

/** Score factor codes, largest |points| first, max 5. Reasons stay policy codes. */
export function topFactorCodes(
	factors: Array<{ code: string; points: number }>,
	limit = 5,
): string[] {
	return [...factors]
		.sort((x, y) => Math.abs(y.points) - Math.abs(x.points))
		.slice(0, limit)
		.map((f) => f.code);
}

export function summarizeQueue(items: QueueSummaryItem[], pendingCount: number): QueueSummary {
	const shown = items.length;
	// Below the cap the queue is complete: force total = shown so a stale
	// count cannot report a false truncation.
	const total = shown < QUEUE_CAP ? shown : Math.max(pendingCount, shown);
	const waitMs = items.map((i) => i.waitMs).sort((a, b) => a - b);
	// Empty queue reports 0 (JSON-stable; no null median).
	let medianWaitMs = 0;
	if (waitMs.length > 0) {
		const mid = Math.floor(waitMs.length / 2);
		medianWaitMs =
			waitMs.length % 2 === 1
				? waitMs[mid]!
				: Math.round(((waitMs[mid - 1] ?? 0) + (waitMs[mid] ?? 0)) / 2);
	}
	return {
		total,
		shown,
		truncated: total > shown,
		medianWaitMs,
		over24hCount: items.filter((i) => i.waitMs > OVER_24H_MS).length,
		referredCount: items.filter((i) => i.flags.referred).length,
		aboveAutoLimitCount: items.filter((i) => i.flags.aboveAutoLimit).length,
		oldestCaseId: items[0]?.id ?? null,
	};
}
