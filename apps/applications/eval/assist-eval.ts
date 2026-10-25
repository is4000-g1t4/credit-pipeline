// EN-03 validator eval (deterministic, no LLM). Archetype: pure
// gate/classifier. Cases are compact mutations of a valid memo plus one
// policy memo and one adverse letter; the runner grades the production
// validator (accept/reject + typed code), not prose quality.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	ADVERSE_JURISDICTION_PROFILES,
	hashQuote,
	sourceRefKey,
	validateGeneratedText,
	type AdverseActionLetterContent,
	type CreditMemoContent,
	type EvidenceBundle,
	type EvidenceItem,
	type PolicyExceptionMemoContent,
	type SourceRef,
} from "@credit/core";
import { buildCreditMemo } from "../src/assist/memo.js";
import type { applications } from "@credit/db/applications";

const appId = "55555555-5555-4555-8555-555555555555";
const scoreId = "33333333-3333-4333-8333-333333333333";
const documentId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const signalRef = "signal:negative_balance:negative_eod_days:2026-01-01:2026-06-30:aggregate";
const externalId = "44444444-4444-4444-8444-444444444444";
const policyQuote = "DSCR must be at least 1.25x for SME term loans.";

const refs = {
	amount: { type: "case_fact", applicationId: appId, field: "amountCents" } as SourceRef,
	term: { type: "case_fact", applicationId: appId, field: "termMonths" } as SourceRef,
	entity: { type: "case_fact", applicationId: appId, field: "companyName" } as SourceRef,
	applicantName: { type: "case_fact", applicationId: appId, field: "applicantName" } as SourceRef,
	industry: { type: "case_fact", applicationId: appId, field: "industry" } as SourceRef,
	years: { type: "case_fact", applicationId: appId, field: "yearsTrading" } as SourceRef,
	revenue: {
		type: "case_fact",
		applicationId: appId,
		field: "business.annualRevenueCents",
	} as SourceRef,
	fcf: { type: "case_fact", applicationId: appId, field: "business.monthlyFcfCents" } as SourceRef,
	debt: {
		type: "case_fact",
		applicationId: appId,
		field: "business.existingDebtServiceCents",
	} as SourceRef,
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
		offsetEnd: 18,
	} as SourceRef,
	external: { type: "external_evidence", evidenceId: externalId } as SourceRef,
};

const contents: Record<string, string> = {
	[sourceRefKey(refs.amount)]: "6000000",
	[sourceRefKey(refs.term)]: "60",
	[sourceRefKey(refs.entity)]: "Cafe Aurora",
	[sourceRefKey(refs.applicantName)]: "Tomas Aurora",
	[sourceRefKey(refs.industry)]: "hospitality",
	[sourceRefKey(refs.years)]: "4",
	[sourceRefKey(refs.revenue)]: "61000000",
	[sourceRefKey(refs.fcf)]: "380000",
	[sourceRefKey(refs.debt)]: "30000",
	[sourceRefKey(refs.score)]: "SCORE_IN_REFER_BAND",
	[sourceRefKey(refs.signal)]: "observed=2 status=review confidence=high",
	[sourceRefKey(refs.policy)]: policyQuote,
	[sourceRefKey(refs.document)]: "Cafe Aurora Pte Ltd",
	[sourceRefKey(refs.external)]: "Cafe Aurora was named in a 2025 restructuring report.",
};

function item(ref: SourceRef): EvidenceItem {
	const key = sourceRefKey(ref);
	return {
		ref: key,
		sourceType: ref.type,
		label: ref.type,
		content: contents[key] ?? "source",
		access: { retentionUntil: null, legalHold: false },
		metadata: {},
	};
}

const allRefs: SourceRef[] = [
	refs.amount,
	refs.term,
	refs.entity,
	refs.applicantName,
	refs.industry,
	refs.years,
	refs.revenue,
	refs.fcf,
	refs.debt,
	refs.score,
	refs.signal,
	refs.policy,
	refs.document,
	refs.external,
];

const bundle: EvidenceBundle = {
	applicationId: appId,
	asOf: "2026-06-30T00:00:00.000Z",
	assembledAt: "2026-06-30T01:00:00.000Z",
	items: allRefs.map(item),
	unavailable: [],
};

const application = {
	id: appId,
	reference: "APP-2026-EVAL01",
	type: "sme",
	product: "sme_term_loan",
	status: "pending_review",
	amountCents: 6_000_000,
	termMonths: 60,
	purpose: "Cafe expansion",
	identity: { fullName: "Tomas Aurora", city: "Singapore" },
	business: {
		companyName: "Cafe Aurora",
		industry: "hospitality",
		yearsTrading: 4,
		annualRevenueCents: 61_000_000,
		monthlyFcfCents: 380_000,
		existingDebtServiceCents: 30_000,
	},
	financial: null,
	submittedAt: new Date("2026-06-30T00:00:00Z"),
	createdAt: new Date("2026-06-30T00:00:00Z"),
} as unknown as typeof applications.$inferSelect;

function cite(ref: SourceRef) {
	return { ref: sourceRefKey(ref), quote: contents[sourceRefKey(ref)] ?? "source" };
}

function validMemo(): CreditMemoContent {
	return buildCreditMemo({ application, evidence: bundle });
}

function policyMemo(): PolicyExceptionMemoContent {
	return {
		title: "Policy exception memorandum draft",
		sections: [
			{
				key: "rule_breached",
				title: "Rule breached",
				claims: [{ text: "Policy rule DSCR minimum is not met.", citations: [cite(refs.score)] }],
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
				claims: [{ text: "Quarterly monitoring is proposed.", citations: [cite(refs.score)] }],
				notAvailable: false,
			},
		],
		openItems: [],
	};
}

function adverseLetter(): AdverseActionLetterContent {
	return {
		title: "Adverse action notice",
		applicantName: "Tomas Aurora",
		decisionId: "77777777-7777-4777-8777-777777777777",
		jurisdiction: "US",
		profileVersion: "us-ecoa-v2",
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
		notices: ADVERSE_JURISDICTION_PROFILES.US.disclosures.map((disclosure) => disclosure.text),
		contactPath: "https://example.com/contact",
		openItems: [],
	};
}

interface EvalCase {
	id: string;
	artifactType: "credit_memo" | "policy_exception_memo" | "adverse_action_letter";
	content: unknown;
	expected: "accept" | string;
	tags: string[];
}

function mutateMemo(mutator: (memo: CreditMemoContent) => void): CreditMemoContent {
	const memo = structuredClone(validMemo());
	mutator(memo);
	return memo;
}

function cases(): EvalCase[] {
	const memo = validMemo();
	return [
		{
			id: "valid-memo",
			artifactType: "credit_memo",
			content: memo,
			expected: "accept",
			tags: ["happy"],
		},
		{
			id: "valid-policy-memo",
			artifactType: "policy_exception_memo",
			content: policyMemo(),
			expected: "accept",
			tags: ["happy", "policy"],
		},
		{
			id: "valid-adverse-letter",
			artifactType: "adverse_action_letter",
			content: adverseLetter(),
			expected: "accept",
			tags: ["happy", "adverse"],
		},
		{
			id: "adverse-name-mismatch",
			artifactType: "adverse_action_letter",
			content: { ...adverseLetter(), applicantName: "Jane Doe" },
			expected: "CITATION_MISSING",
			tags: ["adverse", "pii"],
		},
		{
			id: "missing-citation",
			artifactType: "credit_memo",
			content: mutateMemo((m) => {
				m.sections[4].claims[0].citations = [];
			}),
			expected: "UNSUPPORTED_CLAIM",
			tags: ["citation"],
		},
		{
			id: "quote-mismatch",
			artifactType: "credit_memo",
			content: mutateMemo((m) => {
				m.sections[0].claims[0].citations[0] = {
					ref: sourceRefKey(refs.amount),
					quote: "6000001",
				};
			}),
			expected: "CITATION_QUOTE_MISMATCH",
			tags: ["citation"],
		},
		{
			id: "missing-ref",
			artifactType: "credit_memo",
			content: mutateMemo((m) => {
				m.sections[0].claims[0].citations[0] = {
					ref: `case_fact:${appId}:missingField`,
					quote: "xx",
				};
			}),
			expected: "CITATION_MISSING",
			tags: ["citation"],
		},
		{
			id: "unavailable-ref",
			artifactType: "credit_memo",
			content: mutateMemo((m) => {
				m.sections[4].claims[0].citations = [{ ref: `document:${documentId}:p9:0-1`, quote: "xx" }];
			}),
			expected: "CITATION_UNAVAILABLE",
			tags: ["citation"],
		},
		{
			id: "malformed-ref",
			artifactType: "credit_memo",
			content: mutateMemo((m) => {
				m.sections[0].claims[0].citations[0] = { ref: "document:nope", quote: "xx" };
			}),
			expected: "CITATION_MALFORMED",
			tags: ["citation"],
		},
		{
			id: "open-item-missing-ref",
			artifactType: "credit_memo",
			content: mutateMemo((m) => {
				m.openItems.push({
					text: "A follow-up is needed.",
					code: "other",
					sourceRef: `case_fact:${appId}:missingField`,
				});
			}),
			expected: "CITATION_MISSING",
			tags: ["citation", "open-item"],
		},
		{
			id: "schema-extra-field",
			artifactType: "credit_memo",
			content: { ...memo, injected: true },
			expected: "SCHEMA_INVALID",
			tags: ["schema"],
		},
		{
			id: "schema-empty-section",
			artifactType: "credit_memo",
			content: mutateMemo((m) => {
				m.sections[3] = { key: "strengths", title: "Strengths", claims: [], notAvailable: false };
			}),
			expected: "SCHEMA_INVALID",
			tags: ["schema"],
		},
		...[
			["decision-approved", "The application is approved."],
			["decision-declined", "The application is declined."],
			["decision-recommend", "We recommend the request."],
			["decision-score", "The score is 640."],
			["decision-rate", "The rate is fixed."],
			["decision-limit", "The limit is set."],
			["decision-terms", "The terms are agreed."],
		].map(([id, text]): EvalCase => ({
			id: id as string,
			artifactType: "credit_memo",
			content: mutateMemo((m) => {
				m.sections[0].claims[0].text = text as string;
			}),
			expected: "DECISION_LANGUAGE",
			tags: ["decision-language"],
		})),
		...[
			["pii-known-name", "The applicant is Cafe Aurora."],
			["pii-email", "Contact borrower@example.com for details."],
			["pii-phone", "Call +65 9123 4567 for details."],
			["pii-nric", "NRIC S1234567D is on file."],
		].map(([id, text]): EvalCase => ({
			id: id as string,
			artifactType: "credit_memo",
			content: mutateMemo((m) => {
				m.sections[0].claims[0].text = text as string;
			}),
			expected: "PII_DETECTED",
			tags: ["pii"],
		})),
		...[
			["protected-age", "Applicant age is 40."],
			["protected-gender", "The applicant is male."],
			["protected-race", "The applicant's race is recorded."],
			["protected-marital", "The applicant is married."],
		].map(([id, text]): EvalCase => ({
			id: id as string,
			artifactType: "credit_memo",
			content: mutateMemo((m) => {
				m.sections[0].claims[0].text = text as string;
			}),
			expected: "PROTECTED_ATTRIBUTE",
			tags: ["protected"],
		})),
	];
}

interface CaseResult {
	id: string;
	expected: string;
	observed: string;
	pass: boolean;
	tags: string[];
}

function claimStats(
	content: unknown,
	type: EvalCase["artifactType"],
): {
	claims: number;
	cited: number;
} {
	if (type === "adverse_action_letter") {
		const letter = content as AdverseActionLetterContent;
		return {
			claims: letter.principalReasons.length,
			cited: letter.principalReasons.filter((reason) => reason.citations.length > 0).length,
		};
	}
	const document = content as CreditMemoContent | PolicyExceptionMemoContent;
	const claims = document.sections.flatMap((section) => section.claims);
	return {
		claims: claims.length,
		cited: claims.filter((claim) => claim.citations.length > 0).length,
	};
}

function runOnce(): CaseResult[] {
	const evalCases = cases();
	// Add one unavailable source to the shared bundle only for the
	// unavailable-ref case; the others keep the clean bundle.
	const unavailableBundle: EvidenceBundle = {
		...bundle,
		unavailable: [
			{
				ref: `document:${documentId}:p9:0-1`,
				sourceType: "document",
				code: "retention_expired",
			},
		],
	};
	return evalCases.map((testCase) => {
		const result = validateGeneratedText({
			artifactType: testCase.artifactType,
			content: testCase.content,
			evidence: testCase.id === "unavailable-ref" ? unavailableBundle : bundle,
		});
		const observed = result.ok ? "accept" : (result.issues[0]?.code ?? "UNKNOWN");
		return {
			id: testCase.id,
			expected: testCase.expected,
			observed,
			pass: observed === testCase.expected,
			tags: testCase.tags,
		};
	});
}

const trials = [runOnce(), runOnce(), runOnce()];
const first = trials[0];
const passAt1 = first.filter((r) => r.pass).length / first.length;
const passAt3 =
	first.filter((_, index) => trials.every((trial) => trial[index]?.pass)).length / first.length;
const acceptedCases = cases().filter((testCase) => testCase.expected === "accept");
const claimTotals = acceptedCases.reduce(
	(acc, testCase) => {
		const stats = claimStats(testCase.content, testCase.artifactType);
		return { claims: acc.claims + stats.claims, cited: acc.cited + stats.cited };
	},
	{ claims: 0, cited: 0 },
);
const accepted = first.filter((r) => r.observed === "accept").length;
const unsafe = first.filter((r) => r.expected !== "accept");
const safetyPass = unsafe.filter((r) => r.pass).length / unsafe.length;
const falsePositive = first.filter((r) => r.expected === "accept" && !r.pass).length;
const falseNegative = first.filter(
	(r) => r.expected !== "accept" && r.observed === "accept",
).length;
const byCode = Object.fromEntries(
	[...new Set(first.map((r) => r.observed))]
		.sort()
		.map((code) => [code, first.filter((r) => r.observed === code).length]),
);

const summary = {
	feature: "case-assist EN-03 generated-text validator",
	archetype: "pure gate/classifier",
	model: "deterministic",
	costUsd: 0,
	n: first.length,
	trials: 3,
	passAt1,
	passAt3,
	accepted,
	safetyPass,
	falsePositive,
	falseNegative,
	unsupportedClaimCount: claimTotals.claims - claimTotals.cited,
	citationCoverage: claimTotals.claims === 0 ? 1 : claimTotals.cited / claimTotals.claims,
	byCode,
	failures: first.filter((r) => !r.pass),
};

const outDir = fileURLToPath(new URL("./results/", import.meta.url));
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
writeFileSync(
	`${outDir}assist-${stamp}.json`,
	`${JSON.stringify({ summary, cases: first }, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));
if (passAt1 < 1) process.exitCode = 1;
