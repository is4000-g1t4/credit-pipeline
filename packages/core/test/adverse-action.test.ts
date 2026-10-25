import { describe, expect, it } from "vitest";
import {
	ADVERSE_JURISDICTION_PROFILES,
	ADVERSE_REASON_TAXONOMY,
	adverseTaxonomyCoverage,
	adverseTaxonomyExpectedCodes,
	isAdverseReasonCode,
	resolveAdverseJurisdictionProfile,
	selectAdverseReasons,
	validateAdverseJurisdictionProfile,
	validateAdverseLetterContent,
	validateAdverseLetterDecisionBinding,
	type AdverseJurisdictionProfile,
} from "../src/adverse-action.js";
import { scanFairLending } from "../src/fair-lending.js";
import {
	containsDecisionLanguage,
	type AdverseActionLetterContent,
} from "../src/generated-text.js";

const APP_ID = "55555555-5555-4555-8555-555555555555";
const SG = ADVERSE_JURISDICTION_PROFILES.SG;
const US = ADVERSE_JURISDICTION_PROFILES.US;

const facts = {
	product: "personal_loan",
	amountCents: 1_000_000,
	termMonths: 36,
	annualRevenueCents: 61_000_000,
	yearsTrading: 4,
	employmentYears: 1,
	bankRelationshipYears: 3,
	existingDebtServiceCents: 30_000,
	industry: "hospitality",
	delinquencies: 2,
	utilizationPct: 88,
	assessmentResult: 540,
};

function letter(over: Partial<AdverseActionLetterContent> = {}): AdverseActionLetterContent {
	const base: AdverseActionLetterContent = {
		title: SG.title,
		applicantName: "Sam Demo",
		decisionId: "66666666-6666-4666-8666-666666666666",
		jurisdiction: "SG",
		profileVersion: SG.version,
		decision: "not_successful",
		principalReasons: [
			{
				code: "SCORE_TOO_LOW",
				text: "The credit assessment result of 540 is below the minimum required level of 580.",
				citations: [
					{
						ref: `score_reason:66666666-6666-4666-8666-666666666666:SCORE_TOO_LOW`,
						quote: "SCORE_TOO_LOW",
					},
				],
			},
			{
				code: "DELINQUENCIES",
				text: "The credit record shows 2 past payment delinquencies.",
				citations: [
					{
						ref: `score_reason:66666666-6666-4666-8666-666666666666:DELINQUENCIES`,
						quote: "DELINQUENCIES",
					},
				],
			},
			{
				code: "CREDIT_UTILIZATION",
				text: "Credit utilization of 88% is above the preferred level.",
				citations: [
					{
						ref: `score_reason:66666666-6666-4666-8666-666666666666:CREDIT_UTILIZATION`,
						quote: "CREDIT_UTILIZATION",
					},
				],
			},
		],
		notices: SG.disclosures.map((d) => d.text),
		contactPath: "https://example.com/contact",
		openItems: [],
	};
	return { ...base, ...over };
}

describe("EN-08 adverse-action taxonomy", () => {
	it("maps every known reason and factor code", () => {
		const expected = adverseTaxonomyExpectedCodes();
		expect(Object.keys(ADVERSE_REASON_TAXONOMY).sort()).toEqual(expected);
		const coverage = adverseTaxonomyCoverage(expected);
		expect(coverage.unmapped).toEqual([]);
		expect(coverage.mapped).toHaveLength(expected.length);
		expect(adverseTaxonomyCoverage(["NOT_A_REASON"])).toEqual({
			mapped: [],
			unmapped: ["NOT_A_REASON"],
		});
		expect(isAdverseReasonCode("SCORE_TOO_LOW")).toBe(true);
		expect(isAdverseReasonCode("NOT_A_REASON")).toBe(false);
	});

	it("renders specific, applicant-safe reasons for every code", () => {
		for (const [code, definition] of Object.entries(ADVERSE_REASON_TAXONOMY)) {
			const text = definition.render(facts);
			expect(text.length, code).toBeGreaterThan(0);
			expect(text.length, code).toBeLessThanOrEqual(500);
			expect(containsDecisionLanguage(text), `${code}: ${text}`).toBe(false);
			const scan = scanFairLending(text);
			expect(scan.protectedAttributes, code).toEqual([]);
			expect(scan.proxies, code).toEqual([]);
		}
	});

	it("includes value or threshold detail for specific factors", () => {
		expect(ADVERSE_REASON_TAXONOMY.SCORE_TOO_LOW.render(facts)).toContain("540");
		expect(ADVERSE_REASON_TAXONOMY.SCORE_TOO_LOW.render(facts)).toContain("580");
		expect(ADVERSE_REASON_TAXONOMY.DTI_TOO_HIGH.render(facts)).toContain("50%");
		expect(ADVERSE_REASON_TAXONOMY.DSCR_TOO_LOW.render(facts)).toContain("1.0x");
		expect(ADVERSE_REASON_TAXONOMY.REVENUE_TOO_LOW.render(facts)).toContain("50,000.00");
		expect(ADVERSE_REASON_TAXONOMY.TERM_OUT_OF_RANGE.render(facts)).toContain("12 to 60");
		expect(ADVERSE_REASON_TAXONOMY.EMPLOYMENT_TENURE.render(facts)).toContain("1 year");
		expect(ADVERSE_REASON_TAXONOMY.REVENUE_SCALE.render(facts)).toContain("610,000.00");
		expect(ADVERSE_REASON_TAXONOMY.SECTOR_RISK.render(facts)).toContain("hospitality");
		expect(ADVERSE_REASON_TAXONOMY.BANK_RELATIONSHIP.render(facts)).toContain("3 years");
		expect(ADVERSE_REASON_TAXONOMY.DEBT_BURDEN.render(facts)).toContain("300.00");
		expect(ADVERSE_REASON_TAXONOMY.DELINQUENCIES.render(facts)).toContain("2");
		expect(ADVERSE_REASON_TAXONOMY.CREDIT_UTILIZATION.render(facts)).toContain("88%");
	});
});

describe("US-ADV-4 deny-list normalization", () => {
	it("catches underscores, camelCase, and phrases without flagging ordinary words", () => {
		expect(scanFairLending("marital_status").protectedAttributes).toContain("marital");
		expect(scanFairLending("AGE_AT_APPLICATION").protectedAttributes).toContain("age");
		expect(scanFairLending("postal_code").proxies).toContain("postal code");
		expect(scanFairLending("The applicant is 40 years old.").protectedAttributes).toContain(
			"years old",
		);
		expect(scanFairLending("average coverage").protectedAttributes).toEqual([]);
		expect(scanFairLending("average coverage").proxies).toEqual([]);
	});
});

describe("US-ADV-1 principal-reason selection", () => {
	it("returns 3-4 specific reasons in deterministic order", () => {
		const result = selectAdverseReasons({
			reasonCodes: ["SCORE_TOO_LOW", "DELINQUENCIES", "CREDIT_UTILIZATION", "BANK_RELATIONSHIP"],
			facts,
			profile: SG,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.reasons.map((r) => r.code)).toEqual([
			"SCORE_TOO_LOW",
			"DELINQUENCIES",
			"CREDIT_UTILIZATION",
			"BANK_RELATIONSHIP",
		]);
		expect(result.reasons.every((r) => r.specificity === "specific")).toBe(true);
	});

	it("allows one supporting generic reason but never invents a reason", () => {
		const result = selectAdverseReasons({
			reasonCodes: ["SCORE_TOO_LOW", "DELINQUENCIES", "OFFICER_JUDGEMENT", "INSUFFICIENT_EVIDENCE"],
			facts,
			profile: SG,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.reasons.map((r) => r.code)).toEqual([
			"SCORE_TOO_LOW",
			"DELINQUENCIES",
			"OFFICER_JUDGEMENT",
		]);
		expect(result.droppedCodes).toEqual(["INSUFFICIENT_EVIDENCE"]);
	});

	it("fails closed when there are too few or only generic reasons", () => {
		const tooFew = selectAdverseReasons({
			reasonCodes: ["SCORE_TOO_LOW", "DELINQUENCIES"],
			facts,
			profile: SG,
		});
		expect(tooFew.ok).toBe(false);
		if (!tooFew.ok) {
			expect(tooFew.failure).toMatchObject({
				code: "NEEDS_OFFICER_INPUT",
				detail: "insufficient_reasons",
			});
		}

		const genericOnly = selectAdverseReasons({
			reasonCodes: ["OFFICER_JUDGEMENT", "INSUFFICIENT_EVIDENCE", "POLICY_EXCEPTION"],
			facts,
			profile: SG,
		});
		expect(genericOnly.ok).toBe(false);
		if (!genericOnly.ok) {
			expect(genericOnly.failure).toMatchObject({
				code: "NEEDS_OFFICER_INPUT",
				detail: "insufficient_specificity",
			});
		}
	});

	it("fails closed on an unmapped code", () => {
		const result = selectAdverseReasons({
			reasonCodes: ["SCORE_TOO_LOW", "DELINQUENCIES", "MYSTERY_REASON"],
			facts,
			profile: SG,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.failure).toMatchObject({
				code: "NEEDS_OFFICER_INPUT",
				detail: "unmapped_code",
				unmappedCodes: ["MYSTERY_REASON"],
			});
		}
	});

	it("blocks protected attributes and proxies in the inputs", () => {
		for (const label of ["Applicant age is 40.", "The applicant lives in a postal code area."]) {
			const result = selectAdverseReasons({
				reasonCodes: ["SCORE_TOO_LOW", "DELINQUENCIES", "CREDIT_UTILIZATION"],
				inputLabels: [label],
				facts,
				profile: SG,
			});
			expect(result.ok, label).toBe(false);
			if (!result.ok) {
				expect(result.failure).toMatchObject({ code: "FAIR_LENDING_BLOCKED", stage: "input" });
			}
		}
	});
});

describe("EN-08 jurisdiction profiles", () => {
	it("separates SG and US wording, notices, and reason counts", () => {
		expect(SG.decision).toBe("not_successful");
		expect(US.decision).toBe("declined");
		expect(SG.disclosures.map((d) => d.text)).not.toEqual(US.disclosures.map((d) => d.text));
		expect(SG.minReasons).toBeGreaterThanOrEqual(3);
		expect(SG.maxReasons).toBeLessThanOrEqual(4);
		expect(US.minReasons).toBeGreaterThanOrEqual(3);
		expect(US.maxReasons).toBeLessThanOrEqual(4);
		expect(SG.legalReview.reference).not.toBe(US.legalReview.reference);
		expect(SG.changeLog[0]?.legalReviewRef).toBe(SG.legalReview.reference);
		expect(US.changeLog[0]?.legalReviewRef).toBe(US.legalReview.reference);
	});

	it("resolves supported jurisdictions and fails closed on an unknown one", () => {
		expect(resolveAdverseJurisdictionProfile("sg")?.code).toBe("SG");
		expect(resolveAdverseJurisdictionProfile("US")?.code).toBe("US");
		expect(resolveAdverseJurisdictionProfile("XX")).toBeNull();
		expect(resolveAdverseJurisdictionProfile(undefined)).toBeNull();
	});

	it("rejects an unapproved or incomplete profile", () => {
		const invalid: AdverseJurisdictionProfile = {
			...SG,
			disclosures: [],
			legalReview: { ...SG.legalReview, reference: "" },
			changeLog: [],
		};
		const result = validateAdverseJurisdictionProfile(invalid);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			const codes = new Set(result.issues.map((issue) => issue.code));
			expect(codes.has("PROFILE_DISCLOSURE")).toBe(true);
			expect(codes.has("PROFILE_LEGAL_REVIEW")).toBe(true);
			expect(codes.has("PROFILE_CHANGELOG")).toBe(true);
		}
		expect(validateAdverseJurisdictionProfile(SG).ok).toBe(true);
		expect(validateAdverseJurisdictionProfile(US).ok).toBe(true);
	});

	it("detects an in-place wording or reason-count edit without a version bump", () => {
		const edited: AdverseJurisdictionProfile = {
			...SG,
			disclosures: SG.disclosures.map((disclosure, index) =>
				index === 0 ? { ...disclosure, text: "A silently edited disclosure." } : disclosure,
			),
		};
		const result = validateAdverseJurisdictionProfile(edited);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.issues.map((issue) => issue.code)).toContain("PROFILE_WORDING_HASH");
		}

		const countEdit: AdverseJurisdictionProfile = { ...SG, minReasons: 4 };
		const countResult = validateAdverseJurisdictionProfile(countEdit);
		expect(countResult.ok).toBe(false);
		if (!countResult.ok) {
			expect(countResult.issues.map((issue) => issue.code)).toContain("PROFILE_WORDING_HASH");
		}
	});
});

describe("US-ADV-2/US-ADV-5 letter profile validation", () => {
	it("accepts a fully disclosed SG letter", () => {
		expect(validateAdverseLetterContent(letter(), SG).ok).toBe(true);
	});

	it("fails closed on wrong jurisdiction, profile version, notices, or count", () => {
		expect(validateAdverseLetterContent(letter({ jurisdiction: "US" }), SG).ok).toBe(false);
		expect(validateAdverseLetterContent(letter({ profileVersion: "old" }), SG).ok).toBe(false);
		expect(
			validateAdverseLetterContent(letter({ notices: [SG.disclosures[0]?.text ?? ""] }), SG).ok,
		).toBe(false);
		expect(
			validateAdverseLetterContent(
				letter({ principalReasons: letter().principalReasons.slice(0, 2) }),
				SG,
			).ok,
		).toBe(false);
	});

	it("rejects unmapped or generic-only reason codes", () => {
		const unmapped = letter();
		unmapped.principalReasons[0] = {
			code: "MYSTERY_REASON",
			text: "A reason that is not in the taxonomy.",
			citations: unmapped.principalReasons[0]?.citations ?? [],
		};
		const unmappedResult = validateAdverseLetterContent(unmapped, SG);
		expect(unmappedResult.ok).toBe(false);
		if (!unmappedResult.ok) {
			expect(unmappedResult.issues.map((issue) => issue.code)).toContain("REASON_CODE_UNMAPPED");
		}

		const generic = letter({
			principalReasons: [
				{ code: "OFFICER_JUDGEMENT", text: "Officer judgement.", citations: [] },
				{ code: "INSUFFICIENT_EVIDENCE", text: "Insufficient information.", citations: [] },
				{ code: "POLICY_EXCEPTION", text: "Exception criteria.", citations: [] },
			],
		});
		const genericResult = validateAdverseLetterContent(generic, SG);
		expect(genericResult.ok).toBe(false);
		if (!genericResult.ok) {
			expect(genericResult.issues.map((issue) => issue.code)).toContain("REASON_SPECIFICITY");
		}
	});

	it("rejects duplicate reasons, extra notices, and a changed title", () => {
		const duplicate = letter();
		duplicate.principalReasons[1] = {
			...duplicate.principalReasons[1]!,
			code: duplicate.principalReasons[0]!.code,
		};
		const duplicateResult = validateAdverseLetterContent(duplicate, SG);
		expect(duplicateResult.ok).toBe(false);
		if (!duplicateResult.ok) {
			expect(duplicateResult.issues.map((issue) => issue.code)).toContain("DUPLICATE_REASON_CODE");
		}

		const extraNotice = letter({ notices: [...SG.disclosures.map((d) => d.text), "Extra."] });
		const extraResult = validateAdverseLetterContent(extraNotice, SG);
		expect(extraResult.ok).toBe(false);
		if (!extraResult.ok) {
			expect(extraResult.issues.map((issue) => issue.code)).toContain("NOTICE_MISMATCH");
		}

		const titleResult = validateAdverseLetterContent(letter({ title: "Changed title" }), SG);
		expect(titleResult.ok).toBe(false);
		if (!titleResult.ok) {
			expect(titleResult.issues.map((issue) => issue.code)).toContain("TITLE_MISMATCH");
		}
	});

	it("binds an edited letter to the decision, profile, and contact path", () => {
		const content = letter();
		expect(
			validateAdverseLetterDecisionBinding({
				content,
				applicationId: APP_ID,
				decisionId: content.decisionId,
				decisionReasonCodes: content.principalReasons.map((reason) => reason.code),
				profile: SG,
				contactPath: content.contactPath,
				facts,
			}).ok,
		).toBe(true);

		const forgedText = structuredClone(content);
		forgedText.principalReasons[0]!.text = "Recent gambling activity affected the outcome.";
		const textResult = validateAdverseLetterDecisionBinding({
			content: forgedText,
			applicationId: APP_ID,
			decisionId: content.decisionId,
			decisionReasonCodes: content.principalReasons.map((reason) => reason.code),
			profile: SG,
			contactPath: content.contactPath,
			facts,
		});
		expect(textResult.ok).toBe(false);
		if (!textResult.ok) {
			expect(textResult.issues.map((issue) => issue.code)).toContain("REASON_TEXT_MISMATCH");
		}

		const forgedId = validateAdverseLetterDecisionBinding({
			content,
			applicationId: APP_ID,
			decisionId: "77777777-7777-4777-8777-777777777777",
			decisionReasonCodes: content.principalReasons.map((reason) => reason.code),
			profile: SG,
			contactPath: content.contactPath,
			facts,
		});
		expect(forgedId.ok).toBe(false);
		if (!forgedId.ok) {
			expect(forgedId.issues.map((issue) => issue.code)).toContain("DECISION_ID_MISMATCH");
		}

		const inventedCode = validateAdverseLetterDecisionBinding({
			content,
			applicationId: APP_ID,
			decisionId: content.decisionId,
			decisionReasonCodes: ["SCORE_TOO_LOW"],
			profile: SG,
			contactPath: content.contactPath,
			facts,
		});
		expect(inventedCode.ok).toBe(false);
		if (!inventedCode.ok) {
			expect(inventedCode.issues.map((issue) => issue.code)).toContain(
				"REASON_CODE_NOT_IN_DECISION",
			);
		}

		const wrongCitation = structuredClone(content);
		wrongCitation.principalReasons[0]!.citations[0] = {
			ref: "score_reason:77777777-7777-4777-8777-777777777777:SCORE_TOO_LOW",
			quote: "SCORE_TOO_LOW",
		};
		const citationResult = validateAdverseLetterDecisionBinding({
			content: wrongCitation,
			applicationId: APP_ID,
			decisionId: content.decisionId,
			decisionReasonCodes: content.principalReasons.map((reason) => reason.code),
			profile: SG,
			contactPath: content.contactPath,
			facts,
		});
		expect(citationResult.ok).toBe(false);
		if (!citationResult.ok) {
			expect(citationResult.issues.map((issue) => issue.code)).toContain(
				"CITATION_NOT_DECISION_REASON",
			);
		}

		const contactResult = validateAdverseLetterDecisionBinding({
			content,
			applicationId: APP_ID,
			decisionId: content.decisionId,
			decisionReasonCodes: content.principalReasons.map((reason) => reason.code),
			profile: SG,
			contactPath: "https://evil.example/contact",
			facts,
		});
		expect(contactResult.ok).toBe(false);
		if (!contactResult.ok) {
			expect(contactResult.issues.map((issue) => issue.code)).toContain("CONTACT_PATH_MISMATCH");
		}
	});
});
