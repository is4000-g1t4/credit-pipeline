// Amortization (SPEC FR-8.2): nominal annual rate / 12, half-up rounding,
// anchor-day-preserving due dates with month-end clamping, all in UTC.
import { roundHalfUp } from "./money.js";

export interface Installment {
	number: number;
	/** UTC calendar date `YYYY-MM-DD`. */
	dueDate: string;
	principalCents: number;
	interestCents: number;
	totalCents: number;
	outstandingAfter: number;
}

/** Monthly rate r = rateBps / 120000. */
export function monthlyRate(rateBps: number): number {
	if (!Number.isInteger(rateBps) || rateBps < 0) {
		throw new RangeError(`rateBps must be a non-negative integer, got ${rateBps}`);
	}
	return rateBps / 120000;
}

/** Level monthly payment in cents: round_half_up(P*r / (1 − (1+r)^−n)). */
export function monthlyPaymentCents(
	principalCents: number,
	rateBps: number,
	termMonths: number,
): number {
	if (!Number.isInteger(principalCents) || principalCents <= 0) {
		throw new RangeError(`principalCents must be a positive integer, got ${principalCents}`);
	}
	if (!Number.isInteger(termMonths) || termMonths < 1) {
		throw new RangeError(`termMonths must be a positive integer, got ${termMonths}`);
	}
	const r = monthlyRate(rateBps);
	if (r === 0) return roundHalfUp(principalCents / termMonths);
	return roundHalfUp((principalCents * r) / (1 - (1 + r) ** -termMonths));
}

function daysInMonthUtc(year: number, monthIndex: number): number {
	return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function pad2(n: number): string {
	return n < 10 ? `0${n}` : `${n}`;
}

/** anchor + k months, preserving the anchor day with month-end clamping. */
export function dueDateForInstallment(
	anchorYear: number,
	anchorMonth: number,
	anchorDay: number,
	k: number,
): string {
	const total = anchorMonth - 1 + k;
	const year = anchorYear + Math.floor(total / 12);
	const monthIndex = ((total % 12) + 12) % 12;
	const day = Math.min(anchorDay, daysInMonthUtc(year, monthIndex));
	return `${year}-${pad2(monthIndex + 1)}-${pad2(day)}`;
}

export function parseAnchorDate(anchor: string | Date): {
	year: number;
	month: number;
	day: number;
} {
	let year: number;
	let month: number;
	let day: number;
	if (typeof anchor === "string") {
		const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(anchor);
		if (!m) throw new RangeError(`anchor must be YYYY-MM-DD, got ${anchor}`);
		year = Number(m[1]);
		month = Number(m[2]);
		day = Number(m[3]);
	} else {
		year = anchor.getUTCFullYear();
		month = anchor.getUTCMonth() + 1;
		day = anchor.getUTCDate();
	}
	if (month < 1 || month > 12 || day < 1 || day > daysInMonthUtc(year, month - 1)) {
		throw new RangeError(`invalid anchor date: ${year}-${month}-${day}`);
	}
	return { year, month, day };
}

/**
 * Full schedule. Interest = round(outstanding × r), principal = payment −
 * interest; the final installment clears the balance so Σ principal = P
 * exactly. Non-positive principals are rebalanced to 1 cent (interest takes
 * the remainder) so every installment stays positive.
 */
export function buildSchedule(
	principalCents: number,
	rateBps: number,
	termMonths: number,
	anchorDate: string | Date,
): Installment[] {
	const payment = monthlyPaymentCents(principalCents, rateBps, termMonths);
	if (payment < 1) throw new RangeError("payment must be positive");
	const r = monthlyRate(rateBps);
	const { year, month, day } = parseAnchorDate(anchorDate);
	const installments: Installment[] = [];
	let outstanding = principalCents;
	for (let k = 1; k <= termMonths; k++) {
		const dueDate = dueDateForInstallment(year, month, day, k);
		if (k === termMonths) {
			const interestCents = roundHalfUp(outstanding * r);
			const principal = outstanding;
			if (principal < 1) throw new RangeError("final principal must be positive");
			installments.push({
				number: k,
				dueDate,
				principalCents: principal,
				interestCents,
				totalCents: principal + interestCents,
				outstandingAfter: 0,
			});
		} else {
			let interestCents = roundHalfUp(outstanding * r);
			let principal = payment - interestCents;
			if (principal < 1) {
				// ponytail: 1-cent floor keeps every installment positive; the
				// final installment still clears, so Σ principal = P holds.
				principal = 1;
				interestCents = payment - 1;
			}
			outstanding -= principal;
			installments.push({
				number: k,
				dueDate,
				principalCents: principal,
				interestCents,
				totalCents: principal + interestCents,
				outstandingAfter: outstanding,
			});
		}
	}
	return installments;
}
