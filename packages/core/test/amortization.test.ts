// Amortization invariants (FR-8.2): Σ principal = P, final clears, month-end
// anchor clamping, no non-positive installments — across every §5.2 vector.
import { describe, expect, it } from "vitest";
import {
	buildSchedule,
	dueDateForInstallment,
	type Installment,
	monthlyPaymentCents,
	monthlyRate,
} from "../src/index.js";

const VECTORS: [number, number, number][] = [
	[1200000, 650, 48],
	[1800000, 650, 48],
	[800000, 1050, 36],
	[1000000, 1250, 36],
	[6000000, 990, 60],
	[5000000, 990, 60],
	[2000000, 840, 48],
];

function checkInvariants(schedule: Installment[], principal: number): void {
	const sumPrincipal = schedule.reduce((s, i) => s + i.principalCents, 0);
	expect(sumPrincipal).toBe(principal);
	expect(schedule.at(-1)?.outstandingAfter).toBe(0);
	for (const inst of schedule) {
		expect(inst.principalCents).toBeGreaterThan(0);
		expect(inst.interestCents).toBeGreaterThanOrEqual(0);
		expect(inst.totalCents).toBe(inst.principalCents + inst.interestCents);
	}
}

describe("amortization", () => {
	it("monthlyRate divides by 120000 (not 12000)", () => {
		expect(monthlyRate(650)).toBeCloseTo(0.005416666666666667, 12);
		expect(monthlyRate(0)).toBe(0);
	});

	it("zero rate splits evenly", () => {
		expect(monthlyPaymentCents(120000, 0, 12)).toBe(10000);
	});

	it("invariants hold for every §5.2 vector", () => {
		for (const [P, rate, n] of VECTORS) {
			const schedule = buildSchedule(P, rate, n, "2026-03-15");
			expect(schedule).toHaveLength(n);
			checkInvariants(schedule, P);
		}
	});

	it("final installment clears the balance exactly", () => {
		const schedule = buildSchedule(1000000, 1250, 36, "2026-01-10");
		const last = schedule.at(-1);
		expect(last?.outstandingAfter).toBe(0);
		// Outstanding walks down monotonically to zero.
		let prev = 1000000;
		for (const inst of schedule) {
			expect(inst.outstandingAfter).toBeLessThan(prev);
			prev = inst.outstandingAfter;
		}
	});

	it("Jan-31 anchor clamps month-end then recovers (UTC)", () => {
		expect(dueDateForInstallment(2026, 1, 31, 1)).toBe("2026-02-28");
		expect(dueDateForInstallment(2026, 1, 31, 2)).toBe("2026-03-31");
		expect(dueDateForInstallment(2026, 1, 31, 3)).toBe("2026-04-30");
		expect(dueDateForInstallment(2024, 1, 31, 1)).toBe("2024-02-29"); // leap year
		const schedule = buildSchedule(1200000, 650, 3, "2026-01-31");
		expect(schedule.map((i) => i.dueDate)).toEqual(["2026-02-28", "2026-03-31", "2026-04-30"]);
		checkInvariants(schedule, 1200000);
	});

	it("installment numbers are 1-based and sequential", () => {
		const schedule = buildSchedule(500000, 650, 12, "2026-06-15");
		expect(schedule.map((i) => i.number)).toEqual(Array.from({ length: 12 }, (_, k) => k + 1));
	});

	it("rejects bad inputs", () => {
		expect(() => monthlyPaymentCents(0, 650, 12)).toThrow();
		expect(() => monthlyPaymentCents(1000.5, 650, 12)).toThrow();
		expect(() => monthlyPaymentCents(1000, -1, 12)).toThrow();
		expect(() => buildSchedule(1000, 650, 0, "2026-01-01")).toThrow();
		expect(() => buildSchedule(1000, 650, 12, "not-a-date")).toThrow();
	});
});
