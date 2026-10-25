// buildCreditMemo unit tests: no DB. The key assertion is that the built
// content passes validateGeneratedText against the same evidence bundle.
import { describe, expect, it } from "vitest";
import {
	hashQuote,
	validateGeneratedText,
	type EvidenceBundle,
	type EvidenceItem,
	type UnavailableSource,
} from "@credit/core";
import type { applications } from "@credit/db/applications";
import { buildCreditMemo } from "../../src/assist/memo.js";

type ApplicationRow = typeof applications.$inferSelect;

const APP_ID = "55555555-5555-4555-8555-555555555555";
const SCORE_ID = "33333333-3333-4333-8333-333333333333";
const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const EXTERNAL_ID = "44444444-4444-4444-8444-444444444444";
const SIGNAL_REF = "signal:negative_balance:negative_eod_days:2026-01-01:2026-06-30:aggregate";
const POLICY_QUOTE = "DSCR must be at least 1.25x for SME lending.";
const POLICY_REF = `policy_section:POL-CR-002:${VERSION_ID}:4.2:${hashQuote(POLICY_QUOTE)}`;
const MISSING_DOC_REF = `document:${DOCUMENT_ID}:p9:0-5`;

function fact(field: string, content: string): EvidenceItem {
	return {
		ref: `case_fact:${APP_ID}:${field}`,
		sourceType: "case_fact",
		label: field,
		content,
		access: { retentionUntil: null, legalHold: false },
		metadata: {},
	};
}

function item(
	ref: string,
	sourceType: EvidenceItem["sourceType"],
	label: string,
	content: string,
	metadata: Record<string, string | number | boolean | null> = {},
): EvidenceItem {
	return {
		ref,
		sourceType,
		label,
		content,
		access: { retentionUntil: null, legalHold: false },
		metadata,
	};
}

function smeApp(): ApplicationRow {
	return {
		id: APP_ID,
		reference: "APP-2026-0001",
		applicantUserId: "99999999-9999-4999-8999-999999999999",
		type: "sme",
		product: "sme_term_loan",
		status: "pending_review",
		amountCents: 6000000,
		termMonths: 60,
		purpose: "Working capital",
		identity: { fullName: "Owner Name", city: "Singapore" },
		financial: null,
		business: {
			companyName: "Cafe Aurora",
			industry: "hospitality",
			yearsTrading: 4,
			annualRevenueCents: 120000000,
			monthlyFcfCents: 8000000,
			existingDebtServiceCents: 1500000,
		},
		consents: [true, true, true],
		aiResearchConsent: false,
		documentProcessingConsent: false,
		documentConsentAt: null,
		documentConsentVersion: null,
		source: "live",
		fixtureKey: null,
		contextAnalysisConsent: false,
		contextConsentAt: null,
		contextConsentVersion: null,
		submittedAt: new Date("2026-06-30T00:00:00.000Z"),
		workflowStartedAt: null,
		decidedAt: null,
		failedReason: null,
		createdAt: new Date("2026-06-30T00:00:00.000Z"),
		updatedAt: new Date("2026-06-30T00:00:00.000Z"),
	};
}

function richBundle(): EvidenceBundle {
	return {
		applicationId: APP_ID,
		asOf: "2026-06-30T00:00:00.000Z",
		assembledAt: "2026-06-30T01:00:00.000Z",
		items: [
			fact("amountCents", "6000000"),
			fact("termMonths", "60"),
			fact("product", "sme_term_loan"),
			fact("companyName", "Cafe Aurora"),
			fact("industry", "hospitality"),
			fact("yearsTrading", "4"),
			fact("city", "Singapore"),
			fact("business.annualRevenueCents", "120000000"),
			fact("business.monthlyFcfCents", "8000000"),
			fact("business.existingDebtServiceCents", "1500000"),
			item(
				`score_reason:${SCORE_ID}:BANK_RELATIONSHIP`,
				"score_reason",
				"factor",
				"BANK_RELATIONSHIP +40",
				{
					kind: "factor",
					impact: "positive",
					code: "BANK_RELATIONSHIP",
					label: "Bank relationship",
				},
			),
			item(`score_reason:${SCORE_ID}:DEBT_BURDEN`, "score_reason", "factor", "DEBT_BURDEN -40", {
				kind: "factor",
				impact: "negative",
				code: "DEBT_BURDEN",
				label: "Debt burden",
			}),
			item(
				`score_reason:${SCORE_ID}:SCORE_IN_REFER_BAND`,
				"score_reason",
				"reason",
				"SCORE_IN_REFER_BAND",
				{
					kind: "reason",
					code: "SCORE_IN_REFER_BAND",
				},
			),
			item(`document:${DOCUMENT_ID}:p1:0-16`, "document", "document", "Cafe Aurora Pte Ltd", {
				status: "mismatch",
				field: "company_name",
			}),
			item(`context_signal:${SIGNAL_REF}`, "context_signal", "signal", "negative_eod_days=2", {}),
			item(
				`external_evidence:${EXTERNAL_ID}`,
				"external_evidence",
				"report",
				"Bureau file on file for review.",
				{},
			),
			item(POLICY_REF, "policy_section", "policy", POLICY_QUOTE, {}),
		],
		unavailable: [
			{
				ref: MISSING_DOC_REF,
				sourceType: "document",
				code: "missing",
			} satisfies UnavailableSource,
		],
	};
}

describe("buildCreditMemo", () => {
	it("builds content that passes EN-03 validation", () => {
		const evidence = richBundle();
		const content = buildCreditMemo({ application: smeApp(), evidence });
		const result = validateGeneratedText({ artifactType: "credit_memo", content, evidence });
		expect(result.ok).toBe(true);
	});

	it("covers all six sections and the unavailable source", () => {
		const evidence = richBundle();
		const content = buildCreditMemo({ application: smeApp(), evidence });
		expect(content.sections.map((s) => s.key)).toEqual([
			"request",
			"entity",
			"financial_summary",
			"strengths",
			"risks",
			"policy_compliance",
		]);
		const financials = content.sections.find((s) => s.key === "financial_summary");
		expect(financials?.notAvailable).toBe(false);
		expect(financials?.claims).toHaveLength(3);
		expect(content.openItems.some((o) => o.sourceRef === MISSING_DOC_REF)).toBe(true);
		expect(content.officerQuestions.length).toBeGreaterThanOrEqual(3);
		expect(content.officerQuestions.length).toBeLessThanOrEqual(5);
	});

	it("uses correct neutral text for low/short policy reasons", () => {
		const evidence = richBundle();
		evidence.items = evidence.items.filter(
			(entry) => entry.ref !== `score_reason:${SCORE_ID}:SCORE_IN_REFER_BAND`,
		);
		evidence.items.push(
			item(`score_reason:${SCORE_ID}:DSCR_TOO_LOW`, "score_reason", "reason", "DSCR_TOO_LOW", {
				kind: "reason",
				code: "DSCR_TOO_LOW",
			}),
			item(`score_reason:${SCORE_ID}:DTI_TOO_HIGH`, "score_reason", "reason", "DTI_TOO_HIGH", {
				kind: "reason",
				code: "DTI_TOO_HIGH",
			}),
			item(
				`score_reason:${SCORE_ID}:TRADING_HISTORY_TOO_SHORT`,
				"score_reason",
				"reason",
				"TRADING_HISTORY_TOO_SHORT",
				{ kind: "reason", code: "TRADING_HISTORY_TOO_SHORT" },
			),
		);
		const content = buildCreditMemo({ application: smeApp(), evidence });
		const risks = content.sections.find((section) => section.key === "risks");
		const text = risks?.claims.map((claim) => claim.text).join(" ") ?? "";
		expect(text).toContain("Debt-service coverage is below the preferred minimum.");
		expect(text).toContain("Debt-to-income is above the preferred maximum.");
		expect(text).toContain("Trading history is below the preferred minimum.");
		expect(validateGeneratedText({ artifactType: "credit_memo", content, evidence }).ok).toBe(true);
	});

	it("caps a rich risks section at the validator bound and stays valid", () => {
		const evidence = richBundle();
		for (let i = 0; i < 30; i++) {
			evidence.items.push(
				item(
					`context_signal:signal:negative_balance:negative_eod_days:2026-01-0${i % 9}:2026-06-30:account_${i}`,
					"context_signal",
					"signal",
					`observed=${i} status=review confidence=high`,
					{},
				),
			);
		}
		const content = buildCreditMemo({ application: smeApp(), evidence });
		const risks = content.sections.find((section) => section.key === "risks");
		expect(risks?.claims.length).toBeLessThanOrEqual(20);
		const riskText = risks?.claims.map((claim) => claim.text).join(" ") ?? "";
		expect(riskText).toContain("Debt burden");
		expect(riskText).toContain("document consistency check");
		expect(validateGeneratedText({ artifactType: "credit_memo", content, evidence }).ok).toBe(true);
	});

	it("truncates a long source excerpt to the citation schema cap", () => {
		const evidence = richBundle();
		const long = "x".repeat(4_500);
		evidence.items.push(
			item(
				"external_evidence:66666666-6666-4666-8666-666666666666",
				"external_evidence",
				"report",
				long,
			),
		);
		const content = buildCreditMemo({ application: smeApp(), evidence });
		const result = validateGeneratedText({ artifactType: "credit_memo", content, evidence });
		expect(result.ok, JSON.stringify(result)).toBe(true);
	});

	it("builds valid content for a thin case with open items", () => {
		const application: ApplicationRow = {
			...smeApp(),
			type: "individual",
			product: "personal_loan",
			financial: null,
			business: null,
		};
		const evidence: EvidenceBundle = {
			applicationId: APP_ID,
			asOf: "2026-06-30T00:00:00.000Z",
			assembledAt: "2026-06-30T01:00:00.000Z",
			items: [
				fact("amountCents", "500000"),
				fact("termMonths", "36"),
				fact("product", "personal_loan"),
				fact("city", "Singapore"),
			],
			unavailable: [],
		};
		const content = buildCreditMemo({ application, evidence });
		const result = validateGeneratedText({ artifactType: "credit_memo", content, evidence });
		expect(result.ok).toBe(true);
		expect(content.sections.map((s) => s.key)).toEqual([
			"request",
			"entity",
			"financial_summary",
			"strengths",
			"risks",
			"policy_compliance",
		]);
		const financials = content.sections.find((s) => s.key === "financial_summary");
		expect(financials?.notAvailable).toBe(true);
		expect(financials?.claims).toEqual([]);
		expect(content.openItems.length).toBeGreaterThan(0);
		expect(content.openItems.some((o) => o.code === "financials_unavailable")).toBe(true);
	});
});
