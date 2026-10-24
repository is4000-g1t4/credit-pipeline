// Status machines (SPEC FR-10.9, FR-8.4).
export const APPLICATION_STATUSES = [
	"draft",
	"submitted",
	"processing",
	"pending_review",
	"booked",
	"declined",
	"expired",
	"failed",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

const TRANSITIONS: Record<ApplicationStatus, readonly ApplicationStatus[]> = {
	// T17: drafts submit once via POST /:id/submit; nothing returns to draft.
	draft: ["submitted"],
	submitted: ["processing", "failed"],
	processing: ["pending_review", "booked", "declined", "failed"],
	pending_review: ["booked", "declined", "expired", "failed"],
	booked: [],
	declined: [],
	expired: [],
	failed: [],
};

export function isAllowedTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
	return TRANSITIONS[from].includes(to);
}

export function assertAllowedTransition(from: ApplicationStatus, to: ApplicationStatus): void {
	if (!isAllowedTransition(from, to)) {
		throw new Error(`illegal application transition: ${from} → ${to}`);
	}
}

export function isTerminal(status: ApplicationStatus): boolean {
	return (
		status === "booked" || status === "declined" || status === "expired" || status === "failed"
	);
}

/** markFailed guard (FR-6.10): non-terminal, no decision, no loan. */
export function canMarkFailed(
	status: ApplicationStatus,
	hasDecision: boolean,
	hasLoan: boolean,
): boolean {
	return !isTerminal(status) && !hasDecision && !hasLoan;
}

export type LoanStatus = "active" | "overdue" | "closed";

export type InstallmentState = "scheduled" | "paid" | "overdue";

/** closed if all paid; overdue if any overdue; else active (FR-8.4). */
export function deriveLoanStatus(installments: { status: InstallmentState }[]): LoanStatus {
	if (installments.length > 0 && installments.every((i) => i.status === "paid")) return "closed";
	if (installments.some((i) => i.status === "overdue")) return "overdue";
	return "active";
}

export interface DueItem {
	/** UTC calendar date `YYYY-MM-DD`. */
	dueDate: string;
	status: InstallmentState;
}

/** Earliest unpaid due date, or null when everything is paid. */
export function computeNextDueDate(items: DueItem[]): string | null {
	let next: string | null = null;
	for (const item of items) {
		if (item.status === "paid") continue;
		if (next === null || item.dueDate < next) next = item.dueDate;
	}
	return next;
}

export interface LoanRollupItem {
	status: InstallmentState;
	dueDate: string;
	principalCents: number;
}

export interface LoanRollup {
	status: LoanStatus;
	nextDueDate: string | null;
	outstandingCents: number;
}

/** Recompute a loan row from its installments: derived status, earliest
 * unpaid due date, and outstanding principal of unpaid installments. */
export function loanRollup(items: LoanRollupItem[]): LoanRollup {
	return {
		status: deriveLoanStatus(items),
		nextDueDate: computeNextDueDate(items),
		outstandingCents: items
			.filter((item) => item.status !== "paid")
			.reduce((sum, item) => sum + item.principalCents, 0),
	};
}
