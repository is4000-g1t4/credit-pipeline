import { describe, expect, it } from "vitest";
import {
	hashQuote,
	sourceRefKey,
	type EvidenceBundle,
	type EvidenceItem,
	type SourceRef,
} from "../src/evidence.js";
import {
	adverseActionLetterContentSchema,
	policyExceptionMemoContentSchema,
	validateGeneratedText,
	type AdverseActionLetterContent,
	type CreditMemoContent,
	type PolicyExceptionMemoContent,
} from "../src/generated-text.js";

const appId = "55555555-5555-4555-8555-555555555555";
const scoreId = "33333333-3333-4333-8333-333333333333";
const documentId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const signalRef = "signal:negative_balance:negative_eod_days:2026-01-01:2026-06-30:aggregate";
const externalId = "44444444-4444-4444-8444-444444444444";
const policyQuote = "DSCR must be at least 1.25x for SME term loans.";

const refs = {
	amount: {
		type: "case_fact",
		applicationId: appId,
		field: "amountCents",
	} as SourceRef,
	term: { type: "case_fact", applicationId: appId, field: "termMonths" } as SourceRef,
	entity: { type: "case_fact", applicationId: appId, field: "companyName" } as SourceRef,
	applicant: {
		type: "case_fact",
		applicationId: appId,
		field: "applicantName",
	} as SourceRef,
	industry: { type: "case_fact", applicationId: appId, field: "industry" } as SourceRef,
	years: { type: "case_fact", applicationId: appId, field: "yearsTrading" } as SourceRef,
	score: { type: "score_reason", scoreId, code: "SCORE_IN_REFER_BAND" } as SourceRef,
	signal: { type: "context_signal", signalRef } as SourceRef,
	policy: {
		type: "policy_section",
		policyKey: "POL-CR-002",
		policyVersionId: versionId,
		sectionId: "4.2",
		quoteHash: hashQuote(policyQuote),
	} as SourceRef,
	document: {
		type: "document",
		documentFileId: documentId,
		pageNumber: 1,
		offsetStart: 0,
		offsetEnd: 16,
	} as SourceRef,
	external: { type: "external_evidence", evidenceId: externalId } as SourceRef,
};

const contents: Record<string, string> = {
	[sourceRefKey(refs.amount)]: "6000000",
	[sourceRefKey(refs.term)]: "60",
	[sourceRefKey(refs.entity)]: "Cafe Aurora",
	[sourceRefKey(refs.applicant)]: "Jane Doe",
	[sourceRefKey(refs.industry)]: "hospitality",
	[sourceRefKey(refs.years)]: "4",
	[sourceRefKey(refs.score)]: "SCORE_IN_REFER_BAND",
	[sourceRefKey(refs.signal)]: "negative_eod_days=2",
	[sourceRefKey(refs.policy)]: policyQuote,
	[sourceRefKey(refs.document)]: "Cafe Aurora Pte Ltd",
	[sourceRefKey(refs.external)]: "Cafe Aurora was named in a 2025 restructuring report.",
};

function item(ref: SourceRef): EvidenceItem {
	return {
		ref: sourceRefKey(ref),
		sourceType: ref.type,
		label: ref.type,
		content: contents[sourceRefKey(ref)] ?? "source",
		access: { retentionUntil: null, legalHold: false },
		metadata: {},
	};
}

const allRefs: SourceRef[] = [
	refs.amount,
	refs.term,
	refs.entity,
	refs.applicant,
	refs.industry,
	refs.years,
	refs.score,
	refs.signal,
	refs.policy,
	refs.document,
	refs.external,
];

function bundle(extraUnavailable = false): EvidenceBundle {
	return {
		applicationId: appId,
		asOf: "2026-06-30T00:00:00.000Z",
		assembledAt: "2026-06-30T01:00:00.000Z",
		items: allRefs.map(item),
		unavailable: extraUnavailable
			? [
					{
						ref: "document:11111111-1111-4111-8111-111111111111:p9:0-5",
						sourceType: "document",
						code: "retention_expired",
					},
				]
			: [],
	};
}

function cite(ref: SourceRef, quote = contents[sourceRefKey(ref)] ?? "source") {
	return { ref: sourceRefKey(ref), quote };
}

export function validMemo(): CreditMemoContent {
	return {
		title: "Credit memorandum draft",
		sections: [
			{
				key: "request",
				title: "Request",
				claims: [
					{
						text: "Requested amount is 6000000 cents over 60 months.",
						citations: [cite(refs.amount), cite(refs.term)],
					},
				],
				notAvailable: false,
			},
			{
				key: "entity",
				title: "Borrower",
				claims: [
					{
						text: "Borrower is the company named in the case record, in hospitality, trading for 4 years.",
						citations: [cite(refs.entity), cite(refs.industry), cite(refs.years)],
					},
				],
				notAvailable: false,
			},
			{
				key: "financial_summary",
				title: "Financial summary",
				claims: [],
				notAvailable: true,
			},
			{
				key: "strengths",
				title: "Strengths",
				claims: [
					{
						text: "The assessment factor is within the preferred range.",
						citations: [cite(refs.score)],
					},
				],
				notAvailable: false,
			},
			{
				key: "risks",
				title: "Risks",
				claims: [
					{
						text: "The assessment factor is within the review band.",
						citations: [cite(refs.score)],
					},
					{
						text: "A document consistency finding was recorded for the entity name.",
						citations: [cite(refs.document)],
					},
					{
						text: "A cash-flow signal is recorded for officer review.",
						citations: [cite(refs.signal)],
					},
					{
						text: "An external report was recorded for officer review.",
						citations: [cite(refs.external)],
					},
				],
				notAvailable: false,
			},
			{
				key: "policy_compliance",
				title: "Policy compliance",
				claims: [
					{
						text: "Policy section 4.2 is cited for this case.",
						citations: [cite(refs.policy)],
					},
				],
				notAvailable: false,
			},
		],
		openItems: [
			{
				text: "Financial information is not available in the case record.",
				code: "financials_unavailable",
			},
		],
		officerQuestions: ["What is the current status of the outstanding document request?"],
	};
}

function validPolicyMemo(): PolicyExceptionMemoContent {
	return {
		title: "Policy exception memorandum draft",
		sections: [
			{
				key: "rule_breached",
				title: "Rule breached",
				claims: [
					{
						text: "Policy rule DSCR minimum is not met.",
						citations: [cite(refs.score)],
					},
				],
				notAvailable: false,
			},
			{
				key: "compensating_factors",
				title: "Compensating factors",
				claims: [
					{
						text: "A cash-flow signal is available for officer review.",
						citations: [cite(refs.signal)],
					},
				],
				notAvailable: false,
			},
			{
				key: "mitigants",
				title: "Mitigants",
				claims: [
					{
						text: "A pricing adjustment is recorded for officer review.",
						citations: [cite(refs.policy)],
					},
				],
				notAvailable: false,
			},
			{
				key: "regularisation_plan",
				title: "Regularisation plan",
				claims: [
					{
						text: "Quarterly monitoring is proposed.",
						citations: [cite(refs.score)],
					},
				],
				notAvailable: false,
			},
		],
		openItems: [],
		rules: [],
		regularisationPlanMonths: null,
	};
}

function validLetter(): AdverseActionLetterContent {
	return {
		title: "Adverse action notice",
		applicantName: "Jane Doe",
		decisionId: "66666666-6666-4666-8666-666666666666",
		jurisdiction: "SG",
		profileVersion: "sg-feat-v2",
		decision: "declined",
		principalReasons: [
			{
				code: "SCORE_IN_REFER_BAND",
				text: "The assessment factor is below the preferred range.",
				citations: [cite(refs.score)],
			},
			{
				code: "DSCR_IN_REFER_BAND",
				text: "Debt-service coverage is within the review band.",
				citations: [cite(refs.score)],
			},
			{
				code: "AMOUNT_ABOVE_AUTO_LIMIT",
				text: "The requested amount exceeds the processing threshold.",
				citations: [cite(refs.amount)],
			},
		],
		notices: ["You may request a review of this outcome."],
		contactPath: "https://example.com/contact",
		openItems: [],
	};
}

describe("generated-text schemas", () => {
	it("parses the three artifact types", () => {
		expect(
			validateGeneratedText({
				artifactType: "credit_memo",
				content: validMemo(),
				evidence: bundle(),
			}).ok,
		).toBe(true);
		expect(
			validateGeneratedText({
				artifactType: "policy_exception_memo",
				content: validPolicyMemo(),
				evidence: bundle(),
			}).ok,
		).toBe(true);
		expect(
			validateGeneratedText({
				artifactType: "adverse_action_letter",
				content: validLetter(),
				evidence: bundle(),
			}).ok,
		).toBe(true);
	});

	it("rejects unknown fields and duplicate/missing memo sections", () => {
		const withUnknown = { ...validMemo(), extra: true };
		expect(
			validateGeneratedText({
				artifactType: "credit_memo",
				content: withUnknown,
				evidence: bundle(),
			}),
		).toMatchObject({ ok: false });

		const missing = { ...validMemo(), sections: validMemo().sections.slice(0, 5) };
		expect(
			validateGeneratedText({ artifactType: "credit_memo", content: missing, evidence: bundle() }),
		).toMatchObject({ ok: false });

		const duplicate = {
			...validMemo(),
			sections: [validMemo().sections[0], ...validMemo().sections.slice(0, 5)],
		};
		expect(
			validateGeneratedText({
				artifactType: "credit_memo",
				content: duplicate,
				evidence: bundle(),
			}),
		).toMatchObject({ ok: false });
	});

	it("rejects a not-available section that still asserts claims", () => {
		const memo = validMemo();
		memo.sections[2] = { ...memo.sections[2], claims: memo.sections[0].claims };
		const result = validateGeneratedText({
			artifactType: "credit_memo",
			content: memo,
			evidence: bundle(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.issues[0]?.code).toBe("SCHEMA_INVALID");
	});

	it("accepts the adverse letter schema directly", () => {
		expect(adverseActionLetterContentSchema.safeParse(validLetter()).success).toBe(true);
		expect(policyExceptionMemoContentSchema.safeParse(validPolicyMemo()).success).toBe(true);
	});
});

describe("citation validation", () => {
	it("rejects a narrative claim without a citation", () => {
		const memo = validMemo();
		memo.sections[4].claims[0].citations = [];
		const result = validateGeneratedText({
			artifactType: "credit_memo",
			content: memo,
			evidence: bundle(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.issues).toContainEqual(expect.objectContaining({ code: "UNSUPPORTED_CLAIM" }));
	});

	it("rejects a ref that is not in the bundle", () => {
		const memo = validMemo();
		memo.sections[0].claims[0].citations[0] = {
			ref: `case_fact:${appId}:missingField`,
			quote: "xx",
		};
		const result = validateGeneratedText({
			artifactType: "credit_memo",
			content: memo,
			evidence: bundle(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.issues).toContainEqual(expect.objectContaining({ code: "CITATION_MISSING" }));
	});

	it("rejects a malformed ref", () => {
		const memo = validMemo();
		memo.sections[0].claims[0].citations[0] = { ref: "document:nope", quote: "xx" };
		const result = validateGeneratedText({
			artifactType: "credit_memo",
			content: memo,
			evidence: bundle(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.issues).toContainEqual(expect.objectContaining({ code: "CITATION_MALFORMED" }));
	});

	it("rejects a citation to an unavailable source", () => {
		const memo = validMemo();
		memo.sections[4].claims[0].citations = [
			{
				ref: "document:11111111-1111-4111-8111-111111111111:p9:0-5",
				quote: "xx",
			},
		];
		const result = validateGeneratedText({
			artifactType: "credit_memo",
			content: memo,
			evidence: bundle(true),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.issues).toContainEqual(
				expect.objectContaining({ code: "CITATION_UNAVAILABLE" }),
			);
		}
	});

	it("rejects an open-item ref that is not in the bundle", () => {
		const memo = validMemo();
		memo.openItems.push({
			text: "A follow-up is needed.",
			code: "other",
			sourceRef: `case_fact:${appId}:missingField`,
		});
		const result = validateGeneratedText({
			artifactType: "credit_memo",
			content: memo,
			evidence: bundle(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.issues).toContainEqual(expect.objectContaining({ code: "CITATION_MISSING" }));
	});

	it("rejects a quote that is not an exact excerpt", () => {
		const memo = validMemo();
		memo.sections[0].claims[0].citations[0] = {
			ref: sourceRefKey(refs.amount),
			quote: "6000001",
		};
		const result = validateGeneratedText({
			artifactType: "credit_memo",
			content: memo,
			evidence: bundle(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.issues).toContainEqual(
				expect.objectContaining({ code: "CITATION_QUOTE_MISMATCH" }),
			);
		}
	});
});

describe("safety scans", () => {
	it("rejects decision language in free text", () => {
		const memo = validMemo();
		memo.sections[0].claims[0].text = "The application is approved.";
		const result = validateGeneratedText({
			artifactType: "credit_memo",
			content: memo,
			evidence: bundle(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.issues).toContainEqual(expect.objectContaining({ code: "DECISION_LANGUAGE" }));
	});

	it("rejects direct identifiers", () => {
		const memo = validMemo();
		memo.sections[0].claims[0].text = "Contact borrower@example.com for details.";
		const result = validateGeneratedText({
			artifactType: "credit_memo",
			content: memo,
			evidence: bundle(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.issues).toContainEqual(expect.objectContaining({ code: "PII_DETECTED" }));
	});

	it("normalises underscores before the decision/protected scans", () => {
		const memo = validMemo();
		memo.sections[0].claims[0].text = "The application was rejected.";
		const rejected = validateGeneratedText({
			artifactType: "credit_memo",
			content: memo,
			evidence: bundle(),
		});
		expect(rejected.ok).toBe(false);
		if (!rejected.ok) {
			expect(rejected.issues).toContainEqual(
				expect.objectContaining({ code: "DECISION_LANGUAGE" }),
			);
		}
		const underscored = validMemo();
		underscored.sections[0].claims[0].text = "The applicant's marital_status is recorded.";
		const protectedResult = validateGeneratedText({
			artifactType: "credit_memo",
			content: underscored,
			evidence: bundle(),
		});
		expect(protectedResult.ok).toBe(false);
		if (!protectedResult.ok) {
			expect(protectedResult.issues).toContainEqual(
				expect.objectContaining({ code: "PROTECTED_ATTRIBUTE" }),
			);
		}
	});

	it("rejects a whitespace-only citation quote", () => {
		const memo = validMemo();
		memo.sections[0].claims[0].citations[0] = {
			ref: sourceRefKey(refs.amount),
			quote: "  ",
		};
		const result = validateGeneratedText({
			artifactType: "credit_memo",
			content: memo,
			evidence: bundle(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.issues[0]?.code).toBe("SCHEMA_INVALID");
	});

	it("allows a bank contact path to contain contact details", () => {
		const letter = validLetter();
		letter.contactPath = "mailto:help@example.com";
		expect(
			validateGeneratedText({
				artifactType: "adverse_action_letter",
				content: letter,
				evidence: bundle(),
			}).ok,
		).toBe(true);
	});

	it("does not flag a short common-word company name in boilerplate", () => {
		const base = bundle();
		const creditCompany: EvidenceBundle = {
			...base,
			items: [
				...base.items,
				{
					...base.items[0],
					ref: sourceRefKey(refs.entity),
					sourceType: "case_fact",
					content: "Credit",
					metadata: { field: "companyName" },
				},
			],
		};
		const result = validateGeneratedText({
			artifactType: "credit_memo",
			content: validMemo(),
			evidence: creditCompany,
		});
		expect(result.ok, JSON.stringify(result)).toBe(true);
	});

	it("normalises camelCase before decision/protected scans", () => {
		const memo = validMemo();
		memo.sections[0].claims[0].text = "The application was preApproved.";
		const decision = validateGeneratedText({
			artifactType: "credit_memo",
			content: memo,
			evidence: bundle(),
		});
		expect(decision.ok).toBe(false);
		if (!decision.ok) {
			expect(decision.issues).toContainEqual(
				expect.objectContaining({ code: "DECISION_LANGUAGE" }),
			);
		}
		const protectedMemo = validMemo();
		protectedMemo.sections[0].claims[0].text = "The applicant's maritalStatus is recorded.";
		const protectedResult = validateGeneratedText({
			artifactType: "credit_memo",
			content: protectedMemo,
			evidence: bundle(),
		});
		expect(protectedResult.ok).toBe(false);
		if (!protectedResult.ok) {
			expect(protectedResult.issues).toContainEqual(
				expect.objectContaining({ code: "PROTECTED_ATTRIBUTE" }),
			);
		}
	});

	it("does not treat the application reference as a direct identifier", () => {
		const memo = validMemo();
		memo.title = "Credit memorandum draft — APP-2026-234567";
		expect(
			validateGeneratedText({
				artifactType: "credit_memo",
				content: memo,
				evidence: bundle(),
			}).ok,
		).toBe(true);
	});

	it("allows decision wording in an adverse-action notice", () => {
		const letter = validLetter();
		letter.notices = ["You may request a review of this decision."];
		expect(
			validateGeneratedText({
				artifactType: "adverse_action_letter",
				content: letter,
				evidence: bundle(),
			}).ok,
		).toBe(true);
	});

	it("binds the adverse applicant name to the case identity", () => {
		const letter = validLetter();
		expect(
			validateGeneratedText({
				artifactType: "adverse_action_letter",
				content: letter,
				evidence: bundle(),
			}).ok,
		).toBe(true);
		const mismatch = { ...letter, applicantName: "Someone Else" };
		const result = validateGeneratedText({
			artifactType: "adverse_action_letter",
			content: mismatch,
			evidence: bundle(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.issues).toContainEqual(expect.objectContaining({ code: "CITATION_MISSING" }));
		}
	});

	it("rejects a case-scoped PII value repeated in prose", () => {
		const memo = validMemo();
		memo.sections[0].claims[0].text = "The applicant is Cafe Aurora.";
		const result = validateGeneratedText({
			artifactType: "credit_memo",
			content: memo,
			evidence: bundle(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.issues).toContainEqual(expect.objectContaining({ code: "PII_DETECTED" }));
	});

	it("rejects protected attributes and common proxies", () => {
		const memo = validMemo();
		memo.sections[0].claims[0].text = "Applicant age is 40.";
		const protectedResult = validateGeneratedText({
			artifactType: "credit_memo",
			content: memo,
			evidence: bundle(),
		});
		expect(protectedResult.ok).toBe(false);
		if (!protectedResult.ok) {
			expect(protectedResult.issues).toContainEqual(
				expect.objectContaining({ code: "PROTECTED_ATTRIBUTE" }),
			);
		}

		const proxyMemo = validMemo();
		proxyMemo.sections[0].claims[0].text = "The applicant lives in a postal code area.";
		const proxyResult = validateGeneratedText({
			artifactType: "credit_memo",
			content: proxyMemo,
			evidence: bundle(),
		});
		expect(proxyResult.ok).toBe(false);
		if (!proxyResult.ok) {
			expect(proxyResult.issues).toContainEqual(
				expect.objectContaining({ code: "FAIR_LENDING_PROXY" }),
			);
		}
	});

	it("does not scan structured enums or citation quotes", () => {
		const result = validateGeneratedText({
			artifactType: "adverse_action_letter",
			content: validLetter(),
			evidence: bundle(),
		});
		expect(result.ok).toBe(true);
	});

	it("does not fair-lending-scan a structured applicant name", () => {
		const letter = validLetter();
		letter.applicantName = "Single Origin Coffee";
		const identityRef = sourceRefKey(refs.applicant);
		const identityBundle = bundle();
		identityBundle.items = identityBundle.items.map((entry) =>
			entry.ref === identityRef ? { ...entry, content: "Single Origin Coffee" } : entry,
		);
		const result = validateGeneratedText({
			artifactType: "adverse_action_letter",
			content: letter,
			evidence: identityBundle,
		});
		expect(result.ok, JSON.stringify(result)).toBe(true);
	});

	it("does not decision-language-scan structured name/contact fields", () => {
		const letter = validLetter();
		letter.applicantName = "Approved Finance Pte Ltd";
		letter.contactPath = "https://bank.example/rates";
		const identityRef = sourceRefKey(refs.applicant);
		const identityBundle = bundle();
		identityBundle.items = identityBundle.items.map((entry) =>
			entry.ref === identityRef ? { ...entry, content: "Approved Finance Pte Ltd" } : entry,
		);
		const result = validateGeneratedText({
			artifactType: "adverse_action_letter",
			content: letter,
			evidence: identityBundle,
		});
		expect(result.ok, JSON.stringify(result)).toBe(true);
	});

	it("rejects internal risk/model/policy references in applicant prose", () => {
		for (const text of [
			"Model scorecard-v1 internal risk grade D.",
			"EXC-14 applies.",
			"Policy exception 14 applies.",
		]) {
			const letter = validLetter();
			letter.principalReasons[0]!.text = text;
			const result = validateGeneratedText({
				artifactType: "adverse_action_letter",
				content: letter,
				evidence: bundle(),
			});
			expect(result.ok, text).toBe(false);
			if (!result.ok) {
				expect(result.issues, text).toContainEqual(
					expect.objectContaining({ code: "INTERNAL_REFERENCE" }),
				);
			}
		}
	});
});

describe("policy-exception memo profile", () => {
	it("accepts score/limit/term descriptors but rejects action language", () => {
		const descriptor = validPolicyMemo();
		descriptor.sections[0]!.claims[0]!.text =
			"The assessment value is 620 with a limit of S$15,000 over a 12 month term.";
		expect(
			validateGeneratedText({
				artifactType: "policy_exception_memo",
				content: descriptor,
				evidence: bundle(),
			}).ok,
		).toBe(true);

		const action = validPolicyMemo();
		action.sections[0]!.claims[0]!.text = "We approve this file.";
		const failed = validateGeneratedText({
			artifactType: "policy_exception_memo",
			content: action,
			evidence: bundle(),
		});
		expect(failed.ok).toBe(false);
		if (!failed.ok) {
			expect(failed.issues).toContainEqual(expect.objectContaining({ code: "DECISION_LANGUAGE" }));
		}
	});

	it("keeps the descriptor ban for credit memos", () => {
		const memo = validMemo();
		memo.sections[0]!.claims[0]!.text = "The application is approved.";
		const result = validateGeneratedText({
			artifactType: "credit_memo",
			content: memo,
			evidence: bundle(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.issues).toContainEqual(expect.objectContaining({ code: "DECISION_LANGUAGE" }));
		}
	});

	it("accepts a hard-wrapped policy quote via whitespace-tolerant matching", () => {
		const wrapped = validPolicyMemo();
		const body = contents[sourceRefKey(refs.policy)] ?? "";
		const hardWrapped = body.replace(" ", "\n");
		wrapped.sections[2]!.claims[0]!.citations = [
			{ ref: sourceRefKey(refs.policy), quote: hardWrapped },
		];
		const result = validateGeneratedText({
			artifactType: "policy_exception_memo",
			content: wrapped,
			evidence: bundle(),
		});
		expect(result.ok, JSON.stringify(result)).toBe(true);
		if (result.ok) {
			const policyRef = sourceRefKey(refs.policy);
			expect(
				result.citations.some((citation) => citation.ref === policyRef && citation.quote === body),
			).toBe(true);
		}
	});

	it("accepts rules/plan fields and rejects unknown fields", () => {
		const withMeta = {
			...validPolicyMemo(),
			rules: [
				{
					ruleId: "PL-DTI-HIGH",
					reasonCode: "DTI_TOO_HIGH",
					observed: "52.00%",
					threshold: "> 50%",
					effect: "decline",
					persisted: true,
					exceptionState: "allowed",
					approver: "team_manager",
					mitigantCodes: ["pricing_uplift_50bps"],
					ruleSectionRefs: [{ policyKey: "POL-CR-009", sectionId: "9.1" }],
				},
			],
			regularisationPlanMonths: 12,
		};
		expect(
			validateGeneratedText({
				artifactType: "policy_exception_memo",
				content: withMeta,
				evidence: bundle(),
			}).ok,
		).toBe(true);

		const unknown = { ...validPolicyMemo(), extra: true };
		expect(
			validateGeneratedText({
				artifactType: "policy_exception_memo",
				content: unknown,
				evidence: bundle(),
			}).ok,
		).toBe(false);
	});
});
