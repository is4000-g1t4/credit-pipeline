// Determinism: mocks are pure functions of their inputs — identical across
// calls, stable across processes (pinned by a golden report, not a formula).
import { describe, expect, it } from "vitest";
import { mockBankIndividual, mockBankSme, mockBureau, syntheticBalances } from "../src/index.js";

describe("mock bureau", () => {
	it("fixed demo profiles match §5.1 exactly", () => {
		expect(mockBureau({ email: "maria@example.com" })).toMatchObject({
			bureauScore: 742,
			delinquencies: 0,
			utilizationPct: 28,
			inquiries6m: 1,
		});
		expect(mockBureau({ email: "alex@example.com" })).toMatchObject({
			bureauScore: 638,
			delinquencies: 1,
			utilizationPct: 65,
			inquiries6m: 2,
		});
		expect(mockBureau({ email: "sam@example.com" })).toMatchObject({
			bureauScore: 528,
			delinquencies: 3,
			utilizationPct: 88,
			inquiries6m: 5,
		});
		expect(mockBureau({ email: "tomas@cafe-aurora.example" })).toMatchObject({
			bureauScore: 711,
			delinquencies: 1,
			utilizationPct: 41,
			inquiries6m: 2,
		});
		expect(mockBureau({ email: "lena@bakery.example" })).toMatchObject({
			bureauScore: 780,
			delinquencies: 0,
			utilizationPct: 22,
			inquiries6m: 0,
		});
	});

	it("email matching is case-insensitive", () => {
		expect(mockBureau({ email: "MARIA@EXAMPLE.COM" })).toEqual(
			mockBureau({ email: "maria@example.com" }),
		);
	});

	it("identical inputs give identical outputs", () => {
		const id = { email: "someone@example.com", nationalId: "AB12345678" };
		expect(mockBureau(id)).toEqual(mockBureau({ ...id }));
	});

	it("fallback is a stable golden report for a fixed id", () => {
		expect(mockBureau({ email: "new.person@example.com", nationalId: "ZX98765432" })).toEqual({
			provider: "mock-bureau-v1",
			version: "mock-bureau-v1",
			bureauScore: 762,
			delinquencies: 0,
			utilizationPct: 87,
			inquiries6m: 0,
		});
	});

	it("fallback distribution stays in range over many seeds", () => {
		for (let i = 0; i < 200; i++) {
			const r = mockBureau({
				email: `user${i}@example.com`,
				nationalId: `ID${i}ABCDEFG`,
			});
			expect(r.bureauScore).toBeGreaterThanOrEqual(520);
			expect(r.bureauScore).toBeLessThanOrEqual(800);
			expect(r.delinquencies).toBeLessThanOrEqual(3);
			expect(r.utilizationPct).toBeGreaterThanOrEqual(10);
			expect(r.utilizationPct).toBeLessThanOrEqual(90);
			expect(r.inquiries6m).toBeLessThanOrEqual(5);
		}
	});

	it("different ids can differ; forcedFailure throws", () => {
		const a = mockBureau({ email: "a@example.com", nationalId: "AAAAAAAA" });
		const b = mockBureau({ email: "b@example.com", nationalId: "BBBBBBBB" });
		expect(JSON.stringify(a) === JSON.stringify(b)).toBe(false);
		expect(() => mockBureau({ email: "maria@example.com" }, { forcedFailure: true })).toThrow(
			/forced failure/,
		);
	});
});

describe("mock bank", () => {
	it("individual echoes income/FCF and is deterministic", () => {
		const input = {
			email: "maria@example.com",
			monthlyIncomeCents: 420000,
			existingDebtCents: 61000,
			relationshipYears: 3,
		};
		const a = mockBankIndividual(input);
		const b = mockBankIndividual({ ...input });
		expect(a).toEqual(b);
		expect(a.monthlyInflowCents).toBe(420000);
		expect(a.monthlyFreeCashFlowCents).toBe(359000);
		expect(a.balancesCents).toHaveLength(12);
		expect(a.accountAgeYears).toBe(3);
	});

	it("SME uses revenue/12 inflow and declared FCF", () => {
		const r = mockBankSme({
			email: "tomas@cafe-aurora.example",
			annualRevenueCents: 61000000,
			declaredFcfCents: 380000,
			accountAgeYears: 4,
		});
		expect(r.monthlyFreeCashFlowCents).toBe(380000);
		expect(r.monthlyInflowCents).toBe(5_083_333); // round(61_000_000 / 12)
		expect(r.balancesCents).toHaveLength(12);
		expect(r).toEqual(
			mockBankSme({
				email: "tomas@cafe-aurora.example",
				annualRevenueCents: 61000000,
				declaredFcfCents: 380000,
				accountAgeYears: 4,
			}),
		);
	});

	it("balances are integer cents and seed-dependent", () => {
		const a = syntheticBalances("a@example.com", 420000);
		expect(a).toHaveLength(12);
		for (const b of a) expect(Number.isInteger(b)).toBe(true);
		expect(syntheticBalances("a@example.com", 420000)).toEqual(a);
		expect(syntheticBalances("b@example.com", 420000)).not.toEqual(a);
	});

	it("forcedFailure throws", () => {
		expect(() =>
			mockBankIndividual(
				{
					email: "x@y.z",
					monthlyIncomeCents: 1,
					existingDebtCents: 0,
					relationshipYears: 0,
				},
				{ forcedFailure: true },
			),
		).toThrow(/forced failure/);
		expect(() =>
			mockBankSme(
				{
					email: "x@y.z",
					annualRevenueCents: 0,
					declaredFcfCents: 0,
					accountAgeYears: 0,
				},
				{ forcedFailure: true },
			),
		).toThrow(/forced failure/);
	});
});
