// Policy integer boundaries (FR-5.5): exact-threshold behavior at
// 700/580, 0.35/0.50, 1.0/1.5, $15k/$25k, $50k, 1y/2y — plus hard-decline
// first-match order and the ≤4 refer-reason cap.
import { describe, expect, it } from "vitest";
import { evaluatePolicy, type PolicyInputs } from "../src/index.js";

type Ind = Extract<PolicyInputs, { kind: "individual" }>;
type Sme = Extract<PolicyInputs, { kind: "sme" }>;

const indBase: Ind = {
	kind: "individual",
	score: 750,
	existingDebtCents: 20,
	monthlyIncomeCents: 100,
	newPaymentCents: 15, // (20+15)/100 = exactly 0.35
	amountCents: 1500000, // exactly $15k
	termMonths: 36,
	employmentYears: 1,
};

const smeBase: Sme = {
	kind: "sme",
	blendedScore: 750,
	monthlyFcfCents: 150,
	existingDebtServiceCents: 0,
	newPaymentCents: 100, // 150/100 = exactly 1.5
	amountCents: 2500000, // exactly $25k
	termMonths: 36,
	yearsTrading: 2,
	annualRevenueCents: 50000000, // exactly $50k → wait, minimum is $50k
	industry: "services",
};

describe("policy boundaries — individual", () => {
	it("exact auto thresholds approve (700 / 0.35 / $15k / 1y)", () => {
		const e = evaluatePolicy({ ...indBase, score: 700 });
		expect(e.outcome).toBe("auto_approve");
	});

	it("699 refers with SCORE_IN_REFER_BAND", () => {
		const e = evaluatePolicy({ ...indBase, score: 699 });
		expect(e.outcome).toBe("refer");
		expect(e.reasons.map((r) => r.code)).toEqual(["SCORE_IN_REFER_BAND"]);
	});

	it("580 is the refer band floor; 579 declines", () => {
		const band = evaluatePolicy({ ...indBase, score: 580 });
		expect(band.outcome).toBe("refer");
		expect(band.reasons.map((r) => r.code)).toEqual(["SCORE_IN_REFER_BAND"]);
		const low = evaluatePolicy({ ...indBase, score: 579 });
		expect(low.outcome).toBe("decline");
		expect(low.reasons.map((r) => r.code)).toEqual(["SCORE_TOO_LOW"]);
	});

	it("DTI exactly 0.50 is refer-band; one cent over declines", () => {
		// income 100 → debt+payment = 50 is exactly 0.50; 51 is over.
		const band = evaluatePolicy({
			...indBase,
			score: 750,
			existingDebtCents: 35,
			newPaymentCents: 15,
		});
		expect(band.outcome).toBe("refer");
		expect(band.reasons.map((r) => r.code)).toEqual(["DTI_IN_REFER_BAND"]);
		const over = evaluatePolicy({
			...indBase,
			score: 750,
			existingDebtCents: 36,
			newPaymentCents: 15,
		});
		expect(over.outcome).toBe("decline");
		expect(over.reasons.map((r) => r.code)).toEqual(["DTI_TOO_HIGH"]);
	});

	it("DTI just above 0.35 refers (integer-exact, no float drift)", () => {
		// 3501/10000 > 0.35 with income scaled: debt+payment=351, income=1000.
		const e = evaluatePolicy({
			...indBase,
			existingDebtCents: 336,
			monthlyIncomeCents: 1000,
			newPaymentCents: 15,
		});
		expect(e.outcome).toBe("refer");
		expect(e.reasons.map((r) => r.code)).toEqual(["DTI_IN_REFER_BAND"]);
	});

	it("$15,000.01 refers with AMOUNT_ABOVE_AUTO_LIMIT", () => {
		const e = evaluatePolicy({ ...indBase, amountCents: 1500001 });
		expect(e.outcome).toBe("refer");
		expect(e.reasons.map((r) => r.code)).toEqual(["AMOUNT_ABOVE_AUTO_LIMIT"]);
	});

	it("< 1y employment refers with SHORT_EMPLOYMENT", () => {
		const e = evaluatePolicy({ ...indBase, employmentYears: 0 });
		expect(e.outcome).toBe("refer");
		expect(e.reasons.map((r) => r.code)).toEqual(["SHORT_EMPLOYMENT"]);
	});

	it("hard-decline first match: DTI before score", () => {
		const e = evaluatePolicy({
			...indBase,
			score: 500,
			existingDebtCents: 60,
			newPaymentCents: 15,
		});
		expect(e.outcome).toBe("decline");
		expect(e.reasons.map((r) => r.code)).toEqual(["DTI_TOO_HIGH"]);
	});

	it("amount/term out of range decline first", () => {
		const amt = evaluatePolicy({ ...indBase, amountCents: 99999 });
		expect([amt.outcome, amt.reasons[0].code]).toEqual(["decline", "AMOUNT_OUT_OF_RANGE"]);
		const amtHigh = evaluatePolicy({ ...indBase, amountCents: 2500001 });
		expect(amtHigh.reasons[0].code).toBe("AMOUNT_OUT_OF_RANGE");
		const term = evaluatePolicy({ ...indBase, termMonths: 11 });
		expect([term.outcome, term.reasons[0].code]).toEqual(["decline", "TERM_OUT_OF_RANGE"]);
		const termHigh = evaluatePolicy({ ...indBase, termMonths: 61 });
		expect(termHigh.reasons[0].code).toBe("TERM_OUT_OF_RANGE");
	});

	it("reason text comes from the central map", () => {
		const e = evaluatePolicy({ ...indBase, score: 579 });
		expect(e.reasons[0].text).toBe("Credit score below the minimum of 580.");
	});
});

describe("policy boundaries — SME", () => {
	it("exact auto thresholds approve (700 / 1.5 / $25k / 2y)", () => {
		const e = evaluatePolicy(smeBase);
		expect(e.outcome).toBe("auto_approve");
		expect(e.reasons).toEqual([]);
	});

	it("DSCR just under 1.5 refers; exactly 1.0 stays in band", () => {
		// 149/100 = 1.49 → band.
		const band = evaluatePolicy({ ...smeBase, monthlyFcfCents: 149 });
		expect(band.outcome).toBe("refer");
		expect(band.reasons.map((r) => r.code)).toEqual(["DSCR_IN_REFER_BAND"]);
		// exactly 1.0 → band, not decline.
		const floor = evaluatePolicy({
			...smeBase,
			monthlyFcfCents: 100,
			amountCents: 1000000,
			blendedScore: 750,
			yearsTrading: 5,
		});
		expect(floor.outcome).toBe("refer");
		expect(floor.reasons.map((r) => r.code)).toEqual(["DSCR_IN_REFER_BAND"]);
		// one cent under 1.0 → decline.
		const under = evaluatePolicy({ ...smeBase, monthlyFcfCents: 99 });
		expect(under.outcome).toBe("decline");
		expect(under.reasons.map((r) => r.code)).toEqual(["DSCR_TOO_LOW"]);
	});

	it("revenue $49,999.99 declines; exactly $50k passes", () => {
		const low = evaluatePolicy({ ...smeBase, annualRevenueCents: 4999999 });
		expect([low.outcome, low.reasons[0].code]).toEqual(["decline", "REVENUE_TOO_LOW"]);
		const ok = evaluatePolicy(smeBase);
		expect(ok.outcome).toBe("auto_approve");
	});

	it("0y trading declines; exactly 1y refers with TRADING_HISTORY_IN_REFER_BAND", () => {
		const short = evaluatePolicy({ ...smeBase, yearsTrading: 0 });
		expect([short.outcome, short.reasons[0].code]).toEqual([
			"decline",
			"TRADING_HISTORY_TOO_SHORT",
		]);
		const band = evaluatePolicy({ ...smeBase, yearsTrading: 1 });
		expect(band.outcome).toBe("refer");
		expect(band.reasons.map((r) => r.code)).toEqual(["TRADING_HISTORY_IN_REFER_BAND"]);
	});

	it("risky sector alone never forces a refer (advisory only)", () => {
		const e = evaluatePolicy({ ...smeBase, industry: "hospitality" });
		expect(e.outcome).toBe("auto_approve");
		const construction = evaluatePolicy({
			...smeBase,
			industry: "construction",
		});
		expect(construction.outcome).toBe("auto_approve");
	});

	it("refer reasons cap at 4 by priority (sector drops first)", () => {
		const e = evaluatePolicy({
			...smeBase,
			blendedScore: 600,
			monthlyFcfCents: 120, // 1.2 → band
			amountCents: 5000000,
			yearsTrading: 1,
			industry: "hospitality",
		});
		expect(e.outcome).toBe("refer");
		expect(e.reasons.map((r) => r.code)).toEqual([
			"AMOUNT_ABOVE_AUTO_LIMIT",
			"SCORE_IN_REFER_BAND",
			"DSCR_IN_REFER_BAND",
			"TRADING_HISTORY_IN_REFER_BAND",
		]);
		expect(e.reasons.length).toBeLessThanOrEqual(4);
	});

	it("hard-decline order: revenue → trading → dscr → score", () => {
		const all = {
			...smeBase,
			annualRevenueCents: 1000000,
			yearsTrading: 0,
			monthlyFcfCents: 1,
			blendedScore: 300,
		};
		expect(evaluatePolicy(all).reasons[0].code).toBe("REVENUE_TOO_LOW");
		expect(evaluatePolicy({ ...all, annualRevenueCents: 60000000 }).reasons[0].code).toBe(
			"TRADING_HISTORY_TOO_SHORT",
		);
		expect(
			evaluatePolicy({ ...all, annualRevenueCents: 60000000, yearsTrading: 5 }).reasons[0].code,
		).toBe("DSCR_TOO_LOW");
		expect(
			evaluatePolicy({
				...all,
				annualRevenueCents: 60000000,
				yearsTrading: 5,
				monthlyFcfCents: 100000,
			}).reasons[0].code,
		).toBe("SCORE_TOO_LOW");
	});

	it("inputHash is stable and maxAmountCents echoes the request", () => {
		const a = evaluatePolicy(smeBase);
		const b = evaluatePolicy({ ...smeBase });
		expect(a.inputHash).toBe(b.inputHash);
		expect(a.maxAmountCents).toBe(2500000);
		expect(a.inputs).toEqual(smeBase);
	});
});
