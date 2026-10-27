// Shared application-wizard logic (routes/apply.tsx): dollar parsing, the
// step-gated manual checks (kept verbatim — they encode distinct UX copy),
// the submit payload builder, and the one-shot customer-profile prefill.
// The component keeps the render-guard setState calls; everything pure
// lives here.
import { TERM_MAX_MONTHS, TERM_MIN_MONTHS } from "@credit/core/browser";

import type { CustomerProfileResponse } from "./api";

export type Errors = Record<string, string>;

export const dollars = (s: string): number | null => {
	const n = Number(s);
	return s.trim() !== "" && Number.isFinite(n) ? Math.round(n * 100) : null;
};

export interface ApplyIdentity {
	fullName: string;
	dob: string;
	nationalId: string;
	email: string;
	phone: string;
	address: string;
	city: string;
}

export interface ApplyIndividual {
	employmentStatus: string;
	employerName: string;
	employmentYears: string;
	monthlyIncome: string;
	existingDebt: string;
	bankRelationshipYears: string;
}

export interface ApplySme {
	companyName: string;
	registrationNumber: string;
	industry: string;
	yearsTrading: string;
	employees: string;
	annualRevenue: string;
	monthlyFcf: string;
	existingDebtService: string;
}

export interface ApplyStepInput {
	amount: string;
	term: string;
	purpose: string;
	identity: ApplyIdentity;
	ind: ApplyIndividual;
	sme: ApplySme;
	borrowerType: "individual" | "sme";
	product: string;
	minCents: number;
	maxCents: number;
}

export function validateApplyStep(target: number, s: ApplyStepInput): Errors {
	const next: Errors = {};
	if (target >= 1) {
		const cents = dollars(s.amount);
		if (cents === null) next.amount = "enter an amount in dollars";
		else if (cents < s.minCents || cents > s.maxCents)
			next.amount = `must be $${s.minCents / 100}–$${s.maxCents / 100} for ${s.product}`;
		const t = Number(s.term);
		if (!Number.isInteger(t) || t < TERM_MIN_MONTHS || t > TERM_MAX_MONTHS)
			next.term = `term must be ${TERM_MIN_MONTHS}–${TERM_MAX_MONTHS} months`;
		if (s.purpose.trim().length === 0) next.purpose = "purpose is required";
	}
	// Step 2's fields belong to the 2→3 transition; validating them on
	// 1→2 would block with empty identity fields (caught by E2E).
	if (target >= 3) {
		if (!s.identity.fullName.trim()) next["identity.fullName"] = "full name is required";
		if (!/^\d{4}-\d{2}-\d{2}$/.test(s.identity.dob)) next["identity.dob"] = "use YYYY-MM-DD";
		if (!/^[A-Za-z0-9]{8,20}$/.test(s.identity.nationalId))
			next["identity.nationalId"] = "8–20 alphanumeric characters";
		if (!s.identity.email.includes("@")) next["identity.email"] = "valid email required";
		if (!s.identity.phone.trim()) next["identity.phone"] = "phone is required";
		if (!s.identity.address.trim()) next["identity.address"] = "address is required";
		if (s.identity.city.trim().length < 2 || s.identity.city.trim().length > 80)
			next["identity.city"] = "city must be 2–80 characters";
		if (s.borrowerType === "individual") {
			if (
				(s.ind.employmentStatus === "employed" || s.ind.employmentStatus === "self_employed") &&
				!s.ind.employerName.trim()
			)
				next["individual.employerName"] = "employer name is required";
			const income = dollars(s.ind.monthlyIncome);
			if (income === null || income < 100000)
				next["individual.monthlyIncome"] = "must be ≥ $1,000/mo";
			if (dollars(s.ind.existingDebt) === null) next["individual.existingDebt"] = "enter 0 or more";
		} else {
			if (!s.sme.companyName.trim()) next["sme.companyName"] = "company name is required";
			if (!/^[A-Za-z0-9]{6,20}$/.test(s.sme.registrationNumber))
				next["sme.registrationNumber"] = "6–20 alphanumeric characters";
			if (dollars(s.sme.monthlyFcf) === null) next["sme.monthlyFcf"] = "enter 0 or more";
		}
	}
	return next;
}

export interface ApplyPayloadInput extends ApplyStepInput {
	consents: boolean[];
	aiResearchConsent: boolean;
	documentProcessingConsent: boolean;
	contextAnalysisConsent: boolean;
}

export function buildApplyPayload(s: ApplyPayloadInput) {
	const base = {
		type: s.borrowerType,
		product: s.product,
		amountCents: dollars(s.amount) as number,
		termMonths: Number(s.term),
		purpose: s.purpose.trim(),
		consents: s.consents,
		aiResearchConsent: s.aiResearchConsent,
		documentProcessingConsent: s.documentProcessingConsent,
		contextAnalysisConsent: s.contextAnalysisConsent,
		identity: { ...s.identity, fullName: s.identity.fullName.trim() },
	};
	return s.borrowerType === "individual"
		? {
				...base,
				individual: {
					employmentStatus: s.ind.employmentStatus,
					employerName: s.ind.employerName.trim() || undefined,
					employmentYears: Number(s.ind.employmentYears),
					monthlyIncomeCents: dollars(s.ind.monthlyIncome) as number,
					existingDebtCents: dollars(s.ind.existingDebt) as number,
					bankRelationshipYears: Number(s.ind.bankRelationshipYears),
				},
			}
		: {
				...base,
				sme: {
					companyName: s.sme.companyName.trim(),
					registrationNumber: s.sme.registrationNumber,
					industry: s.sme.industry,
					yearsTrading: Number(s.sme.yearsTrading),
					employees: Number(s.sme.employees),
					annualRevenueCents: dollars(s.sme.annualRevenue) as number,
					monthlyFcfCents: dollars(s.sme.monthlyFcf) as number,
					existingDebtServiceCents: dollars(s.sme.existingDebtService) as number,
				},
			};
}

// T17 prefill coercions (module scope): profile values are strings for
// identity, numbers for business cents/counts; empty stays empty.
const profStr = (v: unknown): string => (typeof v === "string" ? v : "");
const profCents = (v: unknown): string => (typeof v === "number" ? String(v / 100) : "");
const profNum = (v: unknown): string => (typeof v === "number" ? String(v) : "");

export function prefillFromProfile(
	profile: CustomerProfileResponse,
	fallbackEmail: string,
): {
	identity: ApplyIdentity;
	sme: ApplySme | null;
	borrowerType: "individual" | "sme";
	prefilled: string[];
} {
	const profIdentity = (profile.profile.identity ?? {}) as Record<string, unknown>;
	const business = (profile.profile.business ?? null) as Record<string, unknown> | null;
	const marked: string[] = [];
	const take = (field: string, value: string): string => {
		if (value !== "") marked.push(field);
		return value;
	};
	const nextIdentity = {
		fullName: take("identity.fullName", profStr(profIdentity.fullName)),
		dob: take("identity.dob", profStr(profIdentity.dob)),
		nationalId: take("identity.nationalId", profStr(profIdentity.nationalId)),
		email: take("identity.email", profStr(profIdentity.email)) || fallbackEmail,
		phone: take("identity.phone", profStr(profIdentity.phone)),
		address: take("identity.address", profStr(profIdentity.address)),
		city: take("identity.city", profStr(profIdentity.city)),
	};
	const nextSme = business
		? {
				companyName: take("sme.companyName", profStr(business.companyName)),
				registrationNumber: take("sme.registrationNumber", profStr(business.registrationNumber)),
				industry: take("sme.industry", profStr(business.industry) || "retail"),
				yearsTrading: take("sme.yearsTrading", profNum(business.yearsTrading)),
				employees: take("sme.employees", profNum(business.employees)),
				annualRevenue: take("sme.annualRevenueCents", profCents(business.annualRevenueCents)),
				monthlyFcf: take("sme.monthlyFcfCents", profCents(business.monthlyFcfCents)),
				existingDebtService: take(
					"sme.existingDebtServiceCents",
					profCents(business.existingDebtServiceCents),
				),
			}
		: null;
	return {
		identity: nextIdentity,
		sme: nextSme,
		borrowerType: profile.profile.segment === "sme" ? "sme" : "individual",
		prefilled: marked,
	};
}
