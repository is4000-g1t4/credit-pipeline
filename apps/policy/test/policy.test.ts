import { describe, expect, it } from "vitest";
import {
	isSingleClaim,
	validateCaseAnswer,
	validateNavigatorAnswer,
	type RetrievedSection,
} from "../src/answer.js";
import { policyCaseContextSchema, signalRef } from "../src/case-context.js";
import { signCaseToken, verifyCaseToken } from "../src/case-token.js";
import { parsePolicyMarkdown } from "../src/markdown.js";
import { baseContext, policyMarkdown, retrieved } from "./helper.js";

describe("policy markdown", () => {
	it("parses frontmatter and anchored sections", () => {
		const parsed = parsePolicyMarkdown(policyMarkdown);
		expect(parsed.frontmatter.policy_key).toBe("POL-CR-001");
		expect(parsed.sections).toHaveLength(2);
		expect(parsed.sections[1]?.sectionId).toBe("4.2");
		expect(parsed.sections[1]?.body).toContain("DSCR");
	});
	it("rejects duplicate anchors", () => {
		expect(() => parsePolicyMarkdown(policyMarkdown.replace("{#4.2}", "{#1}"))).toThrow(
			/duplicate section id/,
		);
	});
	it("rejects an unanchored section heading", () => {
		expect(() =>
			parsePolicyMarkdown(
				policyMarkdown.replace("## 4.2 Affordability {#4.2}", "## 4.2 Affordability"),
			),
		).toThrow(/no anchored sections|unanchored/);
	});
});

describe("PolicyCaseContext", () => {
	it("accepts real T18 signals and four account ordinals", () => {
		const context = baseContext();
		context.signals = [1, 2, 3, 4].map((n) => ({
			...context.signals[0]!,
			ref: signalRef({
				type: "negative_balance",
				metric: "negative_eod_days",
				periodStart: "2026-01-01",
				periodEnd: "2026-06-30",
				accountScope: `account_${n}`,
			}),
			accountScope: `account_${n}`,
		}));
		expect(policyCaseContextSchema.safeParse(context).success).toBe(true);
	});
	it("rejects unknown keys/PII and a metric/type mismatch", () => {
		const withPii = { ...baseContext(), applicantName: "Alice" };
		expect(policyCaseContextSchema.safeParse(withPii).success).toBe(false);
		const wrongMetric = baseContext();
		wrongMetric.signals[0] = {
			...wrongMetric.signals[0]!,
			metric: "usable_rows",
			ref: signalRef({
				type: "negative_balance",
				metric: "usable_rows",
				periodStart: "2026-01-01",
				periodEnd: "2026-06-30",
				accountScope: "account_1",
			}),
		};
		expect(policyCaseContextSchema.safeParse(wrongMetric).success).toBe(false);
	});
});

describe("case token", () => {
	const secret = "this-is-a-test-secret-with-enough-length";
	const input = {
		runId: "33333333-3333-4333-8333-333333333333",
		applicationId: "22222222-2222-4222-8222-222222222222",
		authorisingActorId: "44444444-4444-4444-8444-444444444444",
		authorisingActorRole: "service" as const,
		asOf: "2026-06-30",
	};
	it("signs and verifies all claims", () => {
		const token = signCaseToken(secret, input, 60, 1_700_000_000_000);
		const claims = verifyCaseToken(secret, token, input, 1_700_000_001_000);
		expect(claims?.jti).toMatch(/^[0-9a-f-]{36}$/);
	});
	it("rejects another case or expiry", () => {
		const token = signCaseToken(secret, input, 60, 1_700_000_000_000);
		expect(
			verifyCaseToken(
				secret,
				token,
				{ ...input, runId: "55555555-5555-4555-8555-555555555555" },
				1_700_000_001_000,
			),
		).toBeNull();
		expect(verifyCaseToken(secret, token, input, 1_700_000_999_000)).toBeNull();
	});
});

describe("navigator citation validation", () => {
	const opts = {
		secret: "citation-secret",
		asOf: "2026-06-30",
		queryId: "66666666-6666-4666-8666-666666666666",
	};
	it("treats i.e. and e.g. as abbreviations, not sentence terminators", () => {
		expect(
			isSingleClaim("Principal haircuts, i.e. relief by reducing principal, are prohibited."),
		).toBe(true);
		expect(isSingleClaim("Use a secured facility, e.g. a mortgage, for the request.")).toBe(true);
	});
	it("accepts a limitation longer than 300 characters", () => {
		const result = validateNavigatorAnswer(
			{
				status: "needs_policy_owner",
				segments: [],
				citations: [],
				limitations: ["x".repeat(420)],
			},
			retrieved,
			opts,
		);
		expect(result.ok).toBe(true);
	});
	it("drops unsafe limitations before returning them", () => {
		const result = validateNavigatorAnswer(
			{
				status: "needs_policy_owner",
				segments: [],
				citations: [],
				limitations: [
					"Email alice@example.com for the policy owner.",
					"We approve this request.",
					"The corpus is silent on this point.",
				],
			},
			retrieved,
			opts,
		);
		expect(result.ok).toBe(true);
		expect(result.answer.limitations).toEqual(["The corpus is silent on this point."]);
	});
	it("rejects applicant PII in a policy body", () => {
		const withPii = policyMarkdown.replace(
			"DSCR must be at least 1.25x for SME term loans.",
			"Contact alice@example.com for the DSCR rule.",
		);
		expect(() => parsePolicyMarkdown(withPii)).toThrow(/applicant PII/);
	});
	it("accepts one claim with an exact quote", () => {
		const result = validateNavigatorAnswer(
			{
				status: "succeeded",
				segments: [
					{ text: "SME term loans require DSCR of at least 1.25x.", citationIndexes: [0] },
				],
				citations: [
					{ policyKey: "POL-CR-001", sectionId: "4.2", quote: "DSCR must be at least 1.25x" },
				],
				limitations: [],
			},
			retrieved,
			opts,
		);
		expect(result.ok).toBe(true);
		expect(result.answer.citations[0]?.drawerToken).toBeTruthy();
	});
	it("accepts a quote that only differs by hard-wrapped whitespace", () => {
		const wrapped: RetrievedSection[] = [
			{
				...retrieved[0]!,
				body: "SME term facilities require a DSCR of at least 1.25x, computed as\nadjusted EBITDA divided by total annual debt service.",
			},
		];
		const result = validateNavigatorAnswer(
			{
				status: "succeeded",
				segments: [
					{ text: "SME term facilities require DSCR of at least 1.25x.", citationIndexes: [0] },
				],
				citations: [
					{
						policyKey: "POL-CR-001",
						sectionId: "4.2",
						quote:
							"of at least 1.25x, computed as adjusted EBITDA divided by total annual debt service",
					},
				],
				limitations: [],
			},
			wrapped,
			opts,
		);
		expect(result.ok).toBe(true);
		expect(result.answer.citations[0]?.quote).toContain("computed as\nadjusted");
	});
	it("still rejects a quote with words inserted inside it", () => {
		const wrapped: RetrievedSection[] = [
			{
				...retrieved[0]!,
				body: "Secured facilities may use a 1.15x floor.",
			},
		];
		const result = validateNavigatorAnswer(
			{
				status: "succeeded",
				segments: [
					{ text: "Secured facilities may use a 1.15x DSCR floor.", citationIndexes: [0] },
				],
				citations: [
					{
						policyKey: "POL-CR-001",
						sectionId: "4.2",
						quote: "may use a 1.15x DSCR floor",
					},
				],
				limitations: [],
			},
			wrapped,
			opts,
		);
		expect(result.ok).toBe(false);
	});
	it("rejects a quote that stitches separate list items", () => {
		const listed: RetrievedSection[] = [
			{
				...retrieved[0]!,
				body: "Rules:\n- item one\n- item two\n- item three",
			},
		];
		const result = validateNavigatorAnswer(
			{
				status: "succeeded",
				segments: [{ text: "The rules include item one and item two.", citationIndexes: [0] }],
				citations: [
					{
						policyKey: "POL-CR-001",
						sectionId: "4.2",
						quote: "item one - item two",
					},
				],
				limitations: [],
			},
			listed,
			opts,
		);
		expect(result.ok).toBe(false);
	});
	it("checks the canonical quote for PII after whitespace normalization", () => {
		const phone: RetrievedSection[] = [
			{
				...retrieved[0]!,
				body: "Call 6123 4567 for the credit committee.",
			},
		];
		const result = validateNavigatorAnswer(
			{
				status: "succeeded",
				segments: [{ text: "Call the credit committee for help.", citationIndexes: [0] }],
				citations: [
					{
						policyKey: "POL-CR-001",
						sectionId: "4.2",
						quote: "Call 6123  4567",
					},
				],
				limitations: [],
			},
			phone,
			opts,
		);
		expect(result.ok).toBe(false);
	});
	it("rejects a fabricated quote, multiple claims, and PII", () => {
		for (const output of [
			{
				status: "succeeded",
				segments: [
					{ text: "SME term loans require DSCR of at least 1.25x.", citationIndexes: [0] },
				],
				citations: [
					{ policyKey: "POL-CR-001", sectionId: "4.2", quote: "DSCR must be at least 2x" },
				],
				limitations: [],
			},
			{
				status: "succeeded",
				segments: [
					{
						text: "SME term loans require DSCR of at least 1.25x. Exceptions need approval.",
						citationIndexes: [0],
					},
				],
				citations: [
					{ policyKey: "POL-CR-001", sectionId: "4.2", quote: "DSCR must be at least 1.25x" },
				],
				limitations: [],
			},
			{
				status: "succeeded",
				segments: [{ text: "Email alice@example.com for an exception.", citationIndexes: [0] }],
				citations: [
					{
						policyKey: "POL-CR-001",
						sectionId: "4.2",
						quote: "Exceptions require documented approval",
					},
				],
				limitations: [],
			},
		]) {
			expect(validateNavigatorAnswer(output, retrieved, opts).ok).toBe(false);
		}
	});
});

describe("case answer validation", () => {
	it("keeps valid refs and drops unknown refs", () => {
		const context = baseContext();
		const result = validateCaseAnswer(
			{
				status: "succeeded",
				items: [
					{
						ref: context.signals[0]!.ref,
						explanationSegments: [
							{
								text: "Negative end-of-day balances are an affordability signal.",
								citationIndexes: [0],
							},
						],
						citations: [
							{ policyKey: "POL-CR-001", sectionId: "4.2", quote: "DSCR must be at least 1.25x" },
						],
						confidence: "high",
					},
					{
						ref: "document:company_name:99",
						explanationSegments: [{ text: "Unknown.", citationIndexes: [0] }],
						citations: [
							{ policyKey: "POL-CR-001", sectionId: "4.2", quote: "DSCR must be at least 1.25x" },
						],
						confidence: "low",
					},
				],
				limitations: [],
			},
			context,
			retrieved,
			{
				secret: "citation-secret",
				asOf: context.asOf,
				queryId: "66666666-6666-4666-8666-666666666666",
			},
		);
		expect(result.ok).toBe(true);
		expect(result.answer.items).toHaveLength(1);
		expect(result.answer.items[0]?.ref).toBe(context.signals[0]!.ref);
	});
	it("rejects a valid quote bound to the wrong section or policy", () => {
		const context = baseContext();
		const opts = {
			secret: "citation-secret",
			asOf: context.asOf,
			queryId: "66666666-6666-4666-8666-666666666666",
		};
		for (const citations of [
			[{ policyKey: "POL-CR-001", sectionId: "9.9", quote: "DSCR must be at least 1.25x" }],
			[{ policyKey: "POL-CR-999", sectionId: "4.2", quote: "DSCR must be at least 1.25x" }],
		]) {
			expect(
				validateNavigatorAnswer(
					{
						status: "succeeded",
						segments: [
							{ text: "SME term loans require DSCR of at least 1.25x.", citationIndexes: [0] },
						],
						citations,
						limitations: [],
					},
					retrieved,
					opts,
				).ok,
			).toBe(false);
		}
	});
});
