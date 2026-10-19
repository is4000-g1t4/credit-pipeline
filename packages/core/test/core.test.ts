// References, money integer rules, pricing card, schemas, factors/reasons maps.
import { describe, expect, it } from "vitest";
import {
	ageInYears,
	apiErrorSchema,
	applicationCreateSchema,
	dscrGte,
	dtiLte,
	generateReference,
	isAdult,
	officerDecisionSchema,
	REASON_TEXT,
	rateBps,
	roundHalfUp,
	roundHalfUpDiv,
	validateReference,
} from "../src/index.js";

const VALID_INDIVIDUAL = {
	type: "individual",
	product: "personal_loan",
	amountCents: 1200000,
	termMonths: 48,
	purpose: "home renovation",
	consents: [true, true, true],
	identity: {
		fullName: "Maria Example",
		dob: "1990-05-01",
		nationalId: "AB12345678",
		email: "maria@example.com",
		phone: "+1-555-0100",
		address: "123 Main St",
	},
	individual: {
		employmentStatus: "employed",
		employerName: "Acme",
		employmentYears: 6,
		monthlyIncomeCents: 420000,
		existingDebtCents: 61000,
		bankRelationshipYears: 3,
	},
} as const;

const VALID_SME = {
	type: "sme",
	product: "sme_term_loan",
	amountCents: 6000000,
	termMonths: 60,
	purpose: "equipment",
	consents: [true, true, true],
	identity: {
		fullName: "Tomas Owner",
		dob: "1985-03-10",
		nationalId: "CD98765432",
		email: "tomas@cafe-aurora.example",
		phone: "+1-555-0200",
		address: "5 Market Sq",
	},
	sme: {
		companyName: "Cafe Aurora",
		registrationNumber: "REG123456",
		industry: "hospitality",
		yearsTrading: 4,
		employees: 9,
		annualRevenueCents: 61000000,
		monthlyFcfCents: 380000,
		existingDebtServiceCents: 30000,
	},
} as const;

describe("reference", () => {
	it("generates APP-<year>-<6 base32> and validates", () => {
		const ref = generateReference(2026);
		expect(ref).toMatch(/^APP-2026-[A-Z2-7]{6}$/);
		expect(validateReference(ref)).toBe(true);
		expect(validateReference("APP-2026-ABCDE")).toBe(false);
		expect(validateReference("APP-2026-ABCDEF8")).toBe(false);
		expect(validateReference("app-2026-ABCDEF")).toBe(false);
		expect(validateReference("APP-26-ABCDEF")).toBe(false);
	});

	it("references are unique", () => {
		const refs = new Set(Array.from({ length: 200 }, () => generateReference(2026)));
		expect(refs.size).toBe(200);
	});
});

describe("money", () => {
	it("roundHalfUp rounds halves up, exact on big integers", () => {
		expect(roundHalfUp(2.5)).toBe(3);
		expect(roundHalfUp(2.4)).toBe(2);
		expect(roundHalfUp(-2.5)).toBe(-3);
		expect(roundHalfUp(2 ** 40 + 0.5)).toBe(2 ** 40 + 1);
		expect(roundHalfUpDiv(5, 2)).toBe(3);
		expect(roundHalfUpDiv(4, 2)).toBe(2);
		expect(roundHalfUpDiv(Number.MAX_SAFE_INTEGER, 1)).toBe(Number.MAX_SAFE_INTEGER);
		expect(roundHalfUpDiv(Number.MAX_SAFE_INTEGER - 1, 2)).toBe(4503599627370495);
	});

	it("dti/dscr integer rules hit exact boundaries", () => {
		expect(dtiLte(20, 15, 100, 3500)).toBe(true); // exactly 0.35
		expect(dtiLte(21, 15, 100, 3500)).toBe(false);
		expect(dtiLte(35, 15, 100, 5000)).toBe(true); // exactly 0.50
		expect(dtiLte(36, 15, 100, 5000)).toBe(false);
		expect(dscrGte(150, 100, 0, 150)).toBe(true); // exactly 1.5
		expect(dscrGte(149, 100, 0, 150)).toBe(false);
		expect(dscrGte(100, 100, 0, 100)).toBe(true); // exactly 1.0
		expect(dscrGte(99, 100, 0, 100)).toBe(false);
		// 351/1000 = 0.351 — float 0.351*1000 !== 351 territory; integers hold.
		expect(dtiLte(336, 15, 1000, 3500)).toBe(false);
		expect(dtiLte(335, 15, 1000, 3500)).toBe(true);
	});
});

describe("pricing", () => {
	it("rate card: 650 + spread + margin, cap 2400", () => {
		expect(rateBps("A", "personal_loan")).toBe(650);
		expect(rateBps("B", "personal_loan")).toBe(750);
		expect(rateBps("C", "personal_loan")).toBe(900);
		expect(rateBps("D", "personal_loan")).toBe(1050);
		expect(rateBps("E", "personal_loan")).toBe(1250);
		expect(rateBps("A", "sme_term_loan")).toBe(740);
		expect(rateBps("B", "sme_term_loan")).toBe(840);
		expect(rateBps("E", "sme_term_loan")).toBe(1340);
		expect(rateBps("E", "sme_term_loan")).toBeLessThanOrEqual(2400);
	});
});

describe("schemas", () => {
	it("accepts valid individual and SME payloads", () => {
		expect(applicationCreateSchema.safeParse(VALID_INDIVIDUAL).success).toBe(true);
		expect(applicationCreateSchema.safeParse(VALID_SME).success).toBe(true);
	});

	it("rejects FR-1.5 invariant violations", () => {
		// type↔product mismatch
		expect(
			applicationCreateSchema.safeParse({
				...VALID_INDIVIDUAL,
				product: "sme_term_loan",
			}).success,
		).toBe(false);
		// amount out of bounds
		expect(
			applicationCreateSchema.safeParse({
				...VALID_INDIVIDUAL,
				amountCents: 99999,
			}).success,
		).toBe(false);
		// term out of bounds
		expect(applicationCreateSchema.safeParse({ ...VALID_INDIVIDUAL, termMonths: 11 }).success).toBe(
			false,
		);
		// missing consents
		expect(
			applicationCreateSchema.safeParse({
				...VALID_INDIVIDUAL,
				consents: [true, true, false],
			}).success,
		).toBe(false);
		// missing block
		const { individual: _drop, ...noBlock } = VALID_INDIVIDUAL;
		expect(applicationCreateSchema.safeParse(noBlock).success).toBe(false);
		// non-integer cents
		expect(
			applicationCreateSchema.safeParse({
				...VALID_INDIVIDUAL,
				amountCents: 1000.5,
			}).success,
		).toBe(false);
		// income under $1,000
		expect(
			applicationCreateSchema.safeParse({
				...VALID_INDIVIDUAL,
				individual: {
					...VALID_INDIVIDUAL.individual,
					monthlyIncomeCents: 99999,
				},
			}).success,
		).toBe(false);
		// bad national ID
		expect(
			applicationCreateSchema.safeParse({
				...VALID_INDIVIDUAL,
				identity: { ...VALID_INDIVIDUAL.identity, nationalId: "00000000!!" },
			}).success,
		).toBe(false);
		// fcf above revenue/12
		expect(
			applicationCreateSchema.safeParse({
				...VALID_SME,
				sme: { ...VALID_SME.sme, monthlyFcfCents: 6000000 },
			}).success,
		).toBe(false);
		// missing employer when employed
		expect(
			applicationCreateSchema.safeParse({
				...VALID_INDIVIDUAL,
				individual: { ...VALID_INDIVIDUAL.individual, employerName: "" },
			}).success,
		).toBe(false);
	});

	it("age helper enforces 18+ with an injected clock", () => {
		const now = new Date("2026-10-19T00:00:00Z");
		expect(isAdult("2008-10-19", now)).toBe(true); // exactly 18
		expect(isAdult("2008-10-20", now)).toBe(false); // 17y364d
		expect(ageInYears("1990-05-01", now)).toBe(36);
	});

	it("officer decision: decline needs code + notes", () => {
		const id = "00000000-0000-4000-8000-000000000001";
		expect(officerDecisionSchema.safeParse({ requestId: id, outcome: "approve" }).success).toBe(
			true,
		);
		expect(
			officerDecisionSchema.safeParse({
				requestId: id,
				outcome: "decline",
				reasonCode: "OFFICER_JUDGEMENT",
				notes: "cash flow unclear",
			}).success,
		).toBe(true);
		expect(officerDecisionSchema.safeParse({ requestId: id, outcome: "decline" }).success).toBe(
			false,
		);
		expect(
			officerDecisionSchema.safeParse({
				requestId: id,
				outcome: "decline",
				reasonCode: "OFFICER_JUDGEMENT",
				notes: "  ",
			}).success,
		).toBe(false);
	});

	it("API error envelope validates", () => {
		expect(
			apiErrorSchema.safeParse({
				error: {
					code: "VALIDATION",
					message: "bad",
					fields: { amountCents: ["too low"] },
				},
			}).success,
		).toBe(true);
		expect(apiErrorSchema.safeParse({ error: { code: "X" } }).success).toBe(false);
	});
});

describe("factors + reasons maps", () => {
	it("every reason code has human text", () => {
		const codes = [
			"AMOUNT_OUT_OF_RANGE",
			"TERM_OUT_OF_RANGE",
			"DTI_TOO_HIGH",
			"SCORE_TOO_LOW",
			"REVENUE_TOO_LOW",
			"TRADING_HISTORY_TOO_SHORT",
			"DSCR_TOO_LOW",
			"AMOUNT_ABOVE_AUTO_LIMIT",
			"SCORE_IN_REFER_BAND",
			"DTI_IN_REFER_BAND",
			"DSCR_IN_REFER_BAND",
			"SHORT_EMPLOYMENT",
			"TRADING_HISTORY_IN_REFER_BAND",
			"SECTOR_REVIEW",
			"IDENTITY_FAILED",
			"SANCTIONS_HIT",
			"OFFICER_JUDGEMENT",
			"INSUFFICIENT_EVIDENCE",
			"POLICY_EXCEPTION",
		] as const;
		for (const code of codes) {
			expect(typeof REASON_TEXT[code]).toBe("string");
			expect(REASON_TEXT[code].length).toBeGreaterThan(0);
		}
	});
});
