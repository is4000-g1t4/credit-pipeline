// buildAdverseActionLetter unit tests: no DB. Decision reasons are plain
// row objects; citations are exact `score_reason` evidence items keyed by
// the decision id, mirroring what the evidence assembler produces.
import { describe, expect, it } from "vitest";
import {
	ADVERSE_JURISDICTION_PROFILES,
	sourceRefKey,
	type EvidenceBundle,
	type EvidenceItem,
} from "@credit/core";
import type { applications, decisions, scores } from "@credit/db/applications";
import { buildAdverseActionLetter } from "../../src/assist/adverse.js";

const APP_ID = "55555555-5555-4555-8555-555555555555";
const DECISION_ID = "77777777-7777-4777-8777-777777777777";
const SCORE_ID = "33333333-3333-4333-8333-333333333333";
const CONTACT_PATH = "https://example.com/contact";
const SG = ADVERSE_JURISDICTION_PROFILES.SG;
const US = ADVERSE_JURISDICTION_PROFILES.US;

function smeApp(over: Record<string, unknown> = {}): typeof applications.$inferSelect {
	return {
		id: APP_ID,
		reference: "APP-2026-0001",
		applicantUserId: "99999999-9999-4999-8999-999999999999",
		type: "sme",
		product: "sme_term_loan",
		status: "declined",
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
		decidedAt: new Date("2026-06-30T01:00:00.000Z"),
		failedReason: null,
		createdAt: new Date("2026-06-30T00:00:00.000Z"),
		updatedAt: new Date("2026-06-30T00:00:00.000Z"),
		...over,
	} as unknown as typeof applications.$inferSelect;
}

function declinedDecision(
	reasons: unknown,
	outcome: string = "declined",
): typeof decisions.$inferSelect {
	return {
		id: DECISION_ID,
		applicationId: APP_ID,
		outcome,
		decidedBy: "system",
		officerUserId: null,
		requestId: null,
		approvedAmountCents: null,
		termMonths: null,
		rateBps: null,
		reasons,
		notes: null,
		snapshot: {},
		decidedAt: new Date("2026-06-30T01:00:00.000Z"),
		createdAt: new Date("2026-06-30T01:00:00.000Z"),
	} as unknown as typeof decisions.$inferSelect;
}

function scoreRow(): typeof scores.$inferSelect {
	return {
		id: SCORE_ID,
		applicationId: APP_ID,
		modelVersion: "scorecard-v1",
		score: 520,
		grade: "D",
		components: {},
		factors: [],
		affordability: {},
		createdAt: new Date("2026-06-30T01:00:00.000Z"),
	} as unknown as typeof scores.$inferSelect;
}

function reason(code: string, text?: string): Record<string, string> {
	return text === undefined ? { code } : { code, text };
}

function bundleFor(decisionId: string, codes: readonly string[]): EvidenceBundle {
	return {
		applicationId: APP_ID,
		asOf: "2026-06-30T00:00:00.000Z",
		assembledAt: "2026-06-30T01:00:00.000Z",
		items: codes.map((code): EvidenceItem => ({
			ref: `score_reason:${decisionId}:${code}`,
			sourceType: "score_reason",
			label: code,
			content: code,
			access: { retentionUntil: null, legalHold: false },
			metadata: { kind: "decision_reason" },
		})),
		unavailable: [],
	};
}

describe("buildAdverseActionLetter", () => {
	it("uses negative snapshot factors to complete an officer decline", () => {
		const decision = declinedDecision([reason("OFFICER_JUDGEMENT", "Officer judgement")]);
		decision.snapshot = {
			factors: [
				{ code: "DELINQUENCIES", label: "Delinquencies", points: -80 },
				{ code: "CREDIT_UTILIZATION", label: "Credit utilization", points: -20 },
			],
		};
		const codes = ["OFFICER_JUDGEMENT", "DELINQUENCIES", "CREDIT_UTILIZATION"];
		const result = buildAdverseActionLetter({
			application: smeApp(),
			decision,
			score: scoreRow(),
			evidence: bundleFor(DECISION_ID, codes),
			profile: SG,
			contactPath: CONTACT_PATH,
		});
		expect(result.ok, result.ok ? "" : result.failure.detail).toBe(true);
		if (!result.ok) return;
		expect(result.content.principalReasons.map((r) => r.code)).toEqual([
			"DELINQUENCIES",
			"CREDIT_UTILIZATION",
			"OFFICER_JUDGEMENT",
		]);
	});

	it("names the bureau delinquency count and utilization in the reasons", () => {
		const codes = ["SCORE_TOO_LOW", "DELINQUENCIES", "CREDIT_UTILIZATION"];
		const evidence = bundleFor(DECISION_ID, codes);
		for (const [field, content] of [
			["bureau.delinquencies", "3"],
			["bureau.utilizationPct", "88"],
		] as const) {
			evidence.items.push({
				ref: sourceRefKey({ type: "case_fact", applicationId: APP_ID, field }),
				sourceType: "case_fact",
				label: field,
				content,
				access: { retentionUntil: null, legalHold: false },
				metadata: { field },
			});
		}
		const result = buildAdverseActionLetter({
			application: smeApp(),
			decision: declinedDecision(codes.map((code) => reason(code))),
			score: scoreRow(),
			evidence,
			profile: SG,
			contactPath: CONTACT_PATH,
		});
		expect(result.ok, result.ok ? "" : result.failure.detail).toBe(true);
		if (!result.ok) return;
		const byCode = new Map(
			result.content.principalReasons.map((principalReason) => [
				principalReason.code,
				principalReason.text,
			]),
		);
		expect(byCode.get("DELINQUENCIES")).toContain("3");
		expect(byCode.get("CREDIT_UTILIZATION")).toContain("88%");
		for (const code of ["DELINQUENCIES", "CREDIT_UTILIZATION"]) {
			const selectedReason = result.content.principalReasons.find((entry) => entry.code === code);
			expect(selectedReason?.citations).toHaveLength(2);
			expect(
				selectedReason?.citations.some((citation) => citation.ref.startsWith("case_fact:")),
			).toBe(true);
		}
	});

	it("builds an SG letter with three exactly-cited principal reasons", () => {
		const codes = ["SCORE_TOO_LOW", "DELINQUENCIES", "CREDIT_UTILIZATION"];
		const result = buildAdverseActionLetter({
			application: smeApp(),
			decision: declinedDecision(codes.map((code) => reason(code))),
			score: scoreRow(),
			evidence: bundleFor(DECISION_ID, codes),
			profile: SG,
			contactPath: CONTACT_PATH,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.content.principalReasons).toHaveLength(3);
		for (const [index, item] of result.content.principalReasons.entries()) {
			expect(item.code).toBe(codes[index]);
			expect(item.citations).toHaveLength(1);
			expect(item.citations[0]?.ref).toBe(`score_reason:${DECISION_ID}:${codes[index]}`);
			expect(item.citations[0]?.quote).toBe(codes[index]);
		}
		// An SME letter names the business, not the individual officer contact.
		expect(result.content.applicantName).toBe("Cafe Aurora");
		expect(result.content.jurisdiction).toBe("SG");
		expect(result.content.profileVersion).toBe("sg-feat-v2");
		expect(result.content.decision).toBe("not_successful");
		expect(result.content.notices).toEqual(SG.disclosures.map((notice) => notice.text));
		expect(result.content.contactPath).toBe(CONTACT_PATH);
	});

	it("builds a US letter with four reasons and declined wording", () => {
		const codes = ["SCORE_TOO_LOW", "DELINQUENCIES", "CREDIT_UTILIZATION", "BANK_RELATIONSHIP"];
		const result = buildAdverseActionLetter({
			application: smeApp(),
			decision: declinedDecision(codes.map((code) => reason(code))),
			score: scoreRow(),
			evidence: bundleFor(DECISION_ID, codes),
			profile: US,
			contactPath: CONTACT_PATH,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.content.principalReasons).toHaveLength(4);
		expect(result.content.principalReasons.map((item) => item.code)).toEqual(codes);
		expect(result.content.decision).toBe("declined");
		expect(result.content.jurisdiction).toBe("US");
		expect(result.content.profileVersion).toBe("us-ecoa-v2");
		expect(result.content.notices).toEqual(US.disclosures.map((notice) => notice.text));
	});

	it("fails closed when fewer than three reasons are available", () => {
		const codes = ["SCORE_TOO_LOW", "DELINQUENCIES"];
		const result = buildAdverseActionLetter({
			application: smeApp(),
			decision: declinedDecision(codes.map((code) => reason(code))),
			score: scoreRow(),
			evidence: bundleFor(DECISION_ID, codes),
			profile: SG,
			contactPath: CONTACT_PATH,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure.code).toBe("NEEDS_OFFICER_INPUT");
		expect(result.failure.detail).toBe("insufficient_reasons");
	});

	it("fails closed when every reason is generic", () => {
		const codes = ["OFFICER_JUDGEMENT", "INSUFFICIENT_EVIDENCE", "POLICY_EXCEPTION"];
		const result = buildAdverseActionLetter({
			application: smeApp(),
			decision: declinedDecision(codes.map((code) => reason(code))),
			score: scoreRow(),
			evidence: bundleFor(DECISION_ID, codes),
			profile: SG,
			contactPath: CONTACT_PATH,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure.code).toBe("NEEDS_OFFICER_INPUT");
		expect(result.failure.detail).toBe("insufficient_specificity");
	});

	it("fails closed on an unmapped reason code", () => {
		const codes = ["SCORE_TOO_LOW", "DELINQUENCIES", "NOT_A_REAL_CODE"];
		const result = buildAdverseActionLetter({
			application: smeApp(),
			decision: declinedDecision(codes.map((code) => reason(code))),
			score: scoreRow(),
			evidence: bundleFor(DECISION_ID, codes),
			profile: SG,
			contactPath: CONTACT_PATH,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure.code).toBe("NEEDS_OFFICER_INPUT");
		expect(result.failure.detail).toBe("unmapped_code");
		expect(result.failure.unmappedCodes).toContain("NOT_A_REAL_CODE");
	});

	it("blocks a protected attribute in a decision reason label", () => {
		const result = buildAdverseActionLetter({
			application: smeApp(),
			decision: declinedDecision([
				reason("SCORE_TOO_LOW", "Applicant age is 40."),
				reason("DELINQUENCIES"),
				reason("CREDIT_UTILIZATION"),
			]),
			score: scoreRow(),
			evidence: bundleFor(DECISION_ID, ["SCORE_TOO_LOW", "DELINQUENCIES", "CREDIT_UTILIZATION"]),
			profile: SG,
			contactPath: CONTACT_PATH,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure.code).toBe("FAIR_LENDING_BLOCKED");
		expect(result.failure.detail).toContain("input");
		expect(result.failure.terms).toContain("age");
	});

	it("blocks a fair-lending proxy in a decision reason label", () => {
		const result = buildAdverseActionLetter({
			application: smeApp(),
			decision: declinedDecision([
				reason("SCORE_TOO_LOW"),
				reason("DELINQUENCIES", "The postal code area carries higher risk."),
				reason("CREDIT_UTILIZATION"),
			]),
			score: scoreRow(),
			evidence: bundleFor(DECISION_ID, ["SCORE_TOO_LOW", "DELINQUENCIES", "CREDIT_UTILIZATION"]),
			profile: SG,
			contactPath: CONTACT_PATH,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure.code).toBe("FAIR_LENDING_BLOCKED");
		expect(result.failure.terms).toContain("postal code");
	});

	it("fails closed when a principal reason has no citable evidence", () => {
		const codes = ["SCORE_TOO_LOW", "DELINQUENCIES", "CREDIT_UTILIZATION"];
		const result = buildAdverseActionLetter({
			application: smeApp(),
			decision: declinedDecision(codes.map((code) => reason(code))),
			score: scoreRow(),
			evidence: bundleFor(DECISION_ID, ["SCORE_TOO_LOW", "DELINQUENCIES"]),
			profile: SG,
			contactPath: CONTACT_PATH,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure.code).toBe("NEEDS_OFFICER_INPUT");
		expect(result.failure.missingCitationCodes).toContain("CREDIT_UTILIZATION");
	});

	it("refuses a decision that is not a decline", () => {
		const codes = ["SCORE_TOO_LOW", "DELINQUENCIES", "CREDIT_UTILIZATION"];
		const result = buildAdverseActionLetter({
			application: smeApp(),
			decision: declinedDecision(
				codes.map((code) => reason(code)),
				"approved",
			),
			score: scoreRow(),
			evidence: bundleFor(DECISION_ID, codes),
			profile: SG,
			contactPath: CONTACT_PATH,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure.code).toBe("NOT_DECLINED");
	});

	it("fails closed when the applicant name is missing", () => {
		const codes = ["SCORE_TOO_LOW", "DELINQUENCIES", "CREDIT_UTILIZATION"];
		const result = buildAdverseActionLetter({
			application: smeApp({ identity: {}, business: {} }),
			decision: declinedDecision(codes.map((code) => reason(code))),
			score: scoreRow(),
			evidence: bundleFor(DECISION_ID, codes),
			profile: SG,
			contactPath: CONTACT_PATH,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.failure.code).toBe("NEEDS_OFFICER_INPUT");
		expect(result.failure.detail).toBe("applicant name is missing");
	});
});
