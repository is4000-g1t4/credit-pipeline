// SPEC §5.2 exact vectors: score/grade, rate, payment (within 2¢ of the
// table), DTI/DSCR (within 0.5%), policy outcome + reason codes.
import { describe, expect, it } from "vitest";
import {
	computeAffordability,
	evaluatePolicy,
	individualScore,
	monthlyPaymentCents,
	type PolicyInputs,
	rateBps,
	smeScores,
} from "../src/index.js";

function withinCents(actual: number, dollars: number): void {
	expect(Math.abs(actual - Math.round(dollars * 100))).toBeLessThanOrEqual(2);
}

function withinPct(actual: number, expected: number): void {
	expect(Math.abs(actual - expected) / expected).toBeLessThanOrEqual(0.005);
}

const maria = individualScore({
	bureauScore: 742,
	employmentYears: 6,
	delinquencies: 0,
	utilizationPct: 28,
	bankRelationshipYears: 3,
});
const alex = individualScore({
	bureauScore: 638,
	employmentYears: 2,
	delinquencies: 1,
	utilizationPct: 65,
	bankRelationshipYears: 1,
});
const sam = individualScore({
	bureauScore: 528,
	employmentYears: 1,
	delinquencies: 3,
	utilizationPct: 88,
	bankRelationshipYears: 0,
});
const tomas = smeScores({
	ownerBureauScore: 711,
	yearsTrading: 4,
	annualRevenueCents: 61000000,
	industry: "hospitality",
	existingDebtServiceCents: 30000,
});
const lena = smeScores({
	ownerBureauScore: 780,
	yearsTrading: 6,
	annualRevenueCents: 42000000,
	industry: "retail",
	existingDebtServiceCents: 0,
});

describe("§5.2 vectors", () => {
	it("Maria scores 777 / A with exact factor points", () => {
		expect(maria.score).toBe(777);
		expect(maria.grade).toBe("A");
		expect(maria.factors).toEqual([
			{
				code: "EMPLOYMENT_TENURE",
				label: "Employment tenure",
				points: 18,
				impact: "positive",
			},
			{
				code: "BANK_RELATIONSHIP",
				label: "Bank relationship",
				points: 12,
				impact: "positive",
			},
			{
				code: "CREDIT_UTILIZATION",
				label: "Credit utilization",
				points: 5,
				impact: "positive",
			},
			{
				code: "DELINQUENCIES",
				label: "Delinquencies",
				points: 0,
				impact: "neutral",
			},
		]);
	});

	it("Alex scores 588 / D, Sam 391 / E", () => {
		expect([alex.score, alex.grade]).toEqual([588, "D"]);
		expect([sam.score, sam.grade]).toEqual([391, "E"]);
	});

	it("Tomás blends to 652 / C, Lena to 701 / B", () => {
		expect([tomas.ownerScore, tomas.businessScore, tomas.blendedScore, tomas.grade]).toEqual([
			711,
			612,
			652,
			"C",
		]);
		expect([lena.ownerScore, lena.businessScore, lena.blendedScore, lena.grade]).toEqual([
			780,
			648,
			701,
			"B",
		]);
	});

	it("rates match the table exactly", () => {
		expect(rateBps(maria.grade, "personal_loan")).toBe(650);
		expect(rateBps(alex.grade, "personal_loan")).toBe(1050);
		expect(rateBps(sam.grade, "personal_loan")).toBe(1250);
		expect(rateBps(tomas.grade, "sme_term_loan")).toBe(990);
		expect(rateBps(lena.grade, "sme_term_loan")).toBe(840);
	});

	it("payments match the table within 2 cents", () => {
		withinCents(monthlyPaymentCents(1200000, 650, 48), 284.58);
		withinCents(monthlyPaymentCents(1800000, 650, 48), 426.87);
		withinCents(monthlyPaymentCents(800000, 1050, 36), 260.02);
		withinCents(monthlyPaymentCents(1000000, 1250, 36), 334.54);
		withinCents(monthlyPaymentCents(6000000, 990, 60), 1271.87);
		withinCents(monthlyPaymentCents(5000000, 990, 60), 1059.89);
		withinCents(monthlyPaymentCents(2000000, 840, 48), 492.02);
	});

	it("exact payment cents (regression pins)", () => {
		expect(monthlyPaymentCents(1200000, 650, 48)).toBe(28458);
		expect(monthlyPaymentCents(1800000, 650, 48)).toBe(42687);
		expect(monthlyPaymentCents(800000, 1050, 36)).toBe(26002);
		expect(monthlyPaymentCents(1000000, 1250, 36)).toBe(33454);
		expect(monthlyPaymentCents(6000000, 990, 60)).toBe(127187);
		expect(monthlyPaymentCents(5000000, 990, 60)).toBe(105989);
		expect(monthlyPaymentCents(2000000, 840, 48)).toBe(49202);
	});

	it("affordability matches the table within 0.5%", () => {
		const m12 = computeAffordability({
			kind: "individual",
			monthlyIncomeCents: 420000,
			existingDebtCents: 61000,
			newPaymentCents: 28458,
		});
		const m18 = computeAffordability({
			kind: "individual",
			monthlyIncomeCents: 420000,
			existingDebtCents: 61000,
			newPaymentCents: 42687,
		});
		const ax = computeAffordability({
			kind: "individual",
			monthlyIncomeCents: 320000,
			existingDebtCents: 90000,
			newPaymentCents: 26002,
		});
		const sm = computeAffordability({
			kind: "individual",
			monthlyIncomeCents: 280000,
			existingDebtCents: 95000,
			newPaymentCents: 33454,
		});
		if (m12.kind !== "individual" || m18.kind !== "individual") throw new Error("kind");
		withinPct(m12.dti, 0.213);
		withinPct(m18.dti, 0.2469);
		if (ax.kind !== "individual" || sm.kind !== "individual") throw new Error("kind");
		withinPct(ax.dti, 0.3625);
		withinPct(sm.dti, 0.4588);

		const t60 = computeAffordability({
			kind: "sme",
			monthlyFreeCashFlowCents: 380000,
			existingDebtServiceCents: 30000,
			newPaymentCents: 127187,
		});
		const t50 = computeAffordability({
			kind: "sme",
			monthlyFreeCashFlowCents: 380000,
			existingDebtServiceCents: 30000,
			newPaymentCents: 105989,
		});
		const le = computeAffordability({
			kind: "sme",
			monthlyFreeCashFlowCents: 260000,
			existingDebtServiceCents: 0,
			newPaymentCents: 49202,
		});
		if (t60.kind !== "sme" || t50.kind !== "sme" || le.kind !== "sme") throw new Error("kind");
		withinPct(t60.dscr, 2.42);
		withinPct(t50.dscr, 2.79);
		withinPct(le.dscr, 5.28);
	});

	function indPolicy(over: Partial<Extract<PolicyInputs, { kind: "individual" }>> = {}) {
		return evaluatePolicy({
			kind: "individual",
			score: 777,
			existingDebtCents: 61000,
			monthlyIncomeCents: 420000,
			newPaymentCents: 28458,
			amountCents: 1200000,
			termMonths: 48,
			employmentYears: 6,
			...over,
		});
	}

	it("Maria $12k auto-approves with no reasons", () => {
		const e = indPolicy();
		expect(e.outcome).toBe("auto_approve");
		expect(e.reasons).toEqual([]);
		expect(e.policyVersion).toBe("policy-v1.0");
		expect(e.maxAmountCents).toBe(1200000);
	});

	it("Maria $18k refers with AMOUNT_ABOVE_AUTO_LIMIT", () => {
		const e = indPolicy({ amountCents: 1800000, newPaymentCents: 42687 });
		expect(e.outcome).toBe("refer");
		expect(e.reasons.map((r) => r.code)).toEqual(["AMOUNT_ABOVE_AUTO_LIMIT"]);
	});

	it("Alex refers with score + DTI band reasons", () => {
		const e = evaluatePolicy({
			kind: "individual",
			score: 588,
			existingDebtCents: 90000,
			monthlyIncomeCents: 320000,
			newPaymentCents: 26002,
			amountCents: 800000,
			termMonths: 36,
			employmentYears: 2,
		});
		expect(e.outcome).toBe("refer");
		expect(e.reasons.map((r) => r.code)).toEqual(["SCORE_IN_REFER_BAND", "DTI_IN_REFER_BAND"]);
	});

	it("Sam declines with SCORE_TOO_LOW", () => {
		const e = evaluatePolicy({
			kind: "individual",
			score: 391,
			existingDebtCents: 95000,
			monthlyIncomeCents: 280000,
			newPaymentCents: 33454,
			amountCents: 1000000,
			termMonths: 36,
			employmentYears: 1,
		});
		expect(e.outcome).toBe("decline");
		expect(e.reasons.map((r) => r.code)).toEqual(["SCORE_TOO_LOW"]);
	});

	it("Tomás $60k refers with amount + score band + SECTOR_REVIEW", () => {
		const e = evaluatePolicy({
			kind: "sme",
			blendedScore: 652,
			monthlyFcfCents: 380000,
			existingDebtServiceCents: 30000,
			newPaymentCents: 127187,
			amountCents: 6000000,
			termMonths: 60,
			yearsTrading: 4,
			annualRevenueCents: 61000000,
			industry: "hospitality",
		});
		expect(e.outcome).toBe("refer");
		expect(e.reasons.map((r) => r.code)).toEqual([
			"AMOUNT_ABOVE_AUTO_LIMIT",
			"SCORE_IN_REFER_BAND",
			"SECTOR_REVIEW",
		]);
	});

	it("Tomás $50k officer terms still satisfy the hard floors", () => {
		const e = evaluatePolicy({
			kind: "sme",
			blendedScore: 652,
			monthlyFcfCents: 380000,
			existingDebtServiceCents: 30000,
			newPaymentCents: 105989,
			amountCents: 5000000,
			termMonths: 60,
			yearsTrading: 4,
			annualRevenueCents: 61000000,
			industry: "hospitality",
		});
		expect(e.outcome).toBe("refer");
		expect(e.reasons.map((r) => r.code)).toContain("AMOUNT_ABOVE_AUTO_LIMIT");
		// Officer revalidation floors (FR-6.2): DSCR ≥ 1.0 and amount in bounds.
		expect(e.outcome).not.toBe("decline");
	});

	it("Lena auto-approves", () => {
		const e = evaluatePolicy({
			kind: "sme",
			blendedScore: 701,
			monthlyFcfCents: 260000,
			existingDebtServiceCents: 0,
			newPaymentCents: 49202,
			amountCents: 2000000,
			termMonths: 48,
			yearsTrading: 6,
			annualRevenueCents: 42000000,
			industry: "retail",
		});
		expect(e.outcome).toBe("auto_approve");
		expect(e.reasons).toEqual([]);
	});
});
