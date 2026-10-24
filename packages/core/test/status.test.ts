// Status guards (FR-10.9, FR-8.4): every allowed edge passes, every other
// edge fails; terminal + markFailed guards; loan derivation; next-due.
import { describe, expect, it } from "vitest";
import {
	type ApplicationStatus,
	assertAllowedTransition,
	canMarkFailed,
	computeNextDueDate,
	deriveLoanStatus,
	isAllowedTransition,
	isTerminal,
	loanRollup,
} from "../src/index.js";

const ALLOWED: [ApplicationStatus, ApplicationStatus][] = [
	["draft", "submitted"],
	["submitted", "processing"],
	["submitted", "failed"],
	["processing", "pending_review"],
	["processing", "booked"], // auto path
	["processing", "declined"],
	["processing", "failed"],
	["pending_review", "booked"],
	["pending_review", "declined"],
	["pending_review", "expired"],
	["pending_review", "failed"],
];

const ALL: ApplicationStatus[] = [
	"draft",
	"submitted",
	"processing",
	"pending_review",
	"booked",
	"declined",
	"expired",
	"failed",
];

describe("status guards", () => {
	it("every allowed edge passes", () => {
		for (const [from, to] of ALLOWED) {
			expect(isAllowedTransition(from, to), `${from}→${to}`).toBe(true);
			expect(() => assertAllowedTransition(from, to)).not.toThrow();
		}
	});

	it("every disallowed edge fails (self-transitions included)", () => {
		const allowed = new Set(ALLOWED.map(([f, t]) => `${f}→${t}`));
		let disallowed = 0;
		for (const from of ALL) {
			for (const to of ALL) {
				if (allowed.has(`${from}→${to}`)) continue;
				disallowed++;
				expect(isAllowedTransition(from, to), `${from}→${to}`).toBe(false);
				expect(() => assertAllowedTransition(from, to)).toThrow();
			}
		}
		expect(disallowed).toBeGreaterThan(0);
	});

	it("terminals are booked/declined/expired/failed", () => {
		expect(ALL.filter(isTerminal)).toEqual(["booked", "declined", "expired", "failed"]);
	});

	it("markFailed only from non-terminal states without decision/loan", () => {
		expect(canMarkFailed("submitted", false, false)).toBe(true);
		expect(canMarkFailed("processing", false, false)).toBe(true);
		expect(canMarkFailed("pending_review", false, false)).toBe(true);
		for (const s of ALL.filter(isTerminal)) {
			expect(canMarkFailed(s, false, false), s).toBe(false);
		}
		expect(canMarkFailed("processing", true, false)).toBe(false);
		expect(canMarkFailed("processing", false, true)).toBe(false);
	});

	it("loan status derivation (FR-8.4)", () => {
		expect(deriveLoanStatus([])).toBe("active");
		expect(deriveLoanStatus([{ status: "scheduled" }, { status: "scheduled" }])).toBe("active");
		expect(deriveLoanStatus([{ status: "paid" }, { status: "overdue" }])).toBe("overdue");
		expect(deriveLoanStatus([{ status: "paid" }, { status: "paid" }])).toBe("closed");
	});

	it("next-due is the earliest unpaid date, null when paid", () => {
		expect(
			computeNextDueDate([
				{ dueDate: "2026-04-15", status: "paid" },
				{ dueDate: "2026-05-15", status: "scheduled" },
				{ dueDate: "2026-03-15", status: "overdue" },
			]),
		).toBe("2026-03-15");
		expect(computeNextDueDate([{ dueDate: "2026-04-15", status: "paid" }])).toBeNull();
		expect(computeNextDueDate([])).toBeNull();
	});

	it("loanRollup combines status, next-due, and outstanding", () => {
		expect(
			loanRollup([
				{ status: "paid", dueDate: "2026-04-15", principalCents: 10_000 },
				{ status: "scheduled", dueDate: "2026-05-15", principalCents: 10_000 },
				{ status: "overdue", dueDate: "2026-03-15", principalCents: 5_000 },
			]),
		).toEqual({ status: "overdue", nextDueDate: "2026-03-15", outstandingCents: 15_000 });
		expect(loanRollup([])).toEqual({ status: "active", nextDueDate: null, outstandingCents: 0 });
		expect(loanRollup([{ status: "paid", dueDate: "2026-04-15", principalCents: 10_000 }])).toEqual(
			{ status: "closed", nextDueDate: null, outstandingCents: 0 },
		);
	});
});
