// --- Formatting / status helpers. ---

import { isTerminal as coreIsTerminal, type ApplicationStatus } from "@credit/core/browser";

const usd = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
});

/** Null-safe cents → USD; check-only decisions carry null amounts (SPEC §2.2). */
export function formatMoney(cents: number | null | undefined): string {
	return cents === null || cents === undefined ? "—" : usd.format(cents / 100);
}

export function formatDate(iso: string | null | undefined): string {
	if (!iso) return "—";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

/** Date-only values (YYYY-MM-DD or date-only ISO) render in UTC: parsing
 * them as local midnight shifts the day for negative offsets. */
export function formatDateOnly(iso: string | null | undefined): string {
	if (!iso) return "—";
	const datePart = iso.length >= 10 ? iso.slice(0, 10) : iso;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return formatDate(iso);
	const d = new Date(`${datePart}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleDateString("en-US", { timeZone: "UTC" });
}

export function formatDateTime(iso: string | null | undefined): string {
	if (!iso) return "—";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

export function formatWait(ms: number): string {
	const mins = Math.floor(ms / 60000);
	if (mins < 1) return "<1m";
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

/** Terminal application statuses — single source of truth in @credit/core. */
export function isTerminal(status: string): boolean {
	return coreIsTerminal(status as ApplicationStatus);
}
