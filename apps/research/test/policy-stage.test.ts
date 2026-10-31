import { describe, expect, it } from "vitest";
import type { CaseFacts } from "@credit/core";
import {
	accountScopeMap,
	buildPolicyCaseContext,
	createCaseTokenForInput,
	createHttpPolicyRunner,
	type PolicyStageInput,
} from "../src/agents/policy-review/index.js";

const facts: CaseFacts = {
	applicationId: "22222222-2222-4222-8222-222222222222",
	reference: "APP-1",
	type: "sme",
	product: "sme_term_loan",
	amountCents: 10_000_000,
	termMonths: 24,
	submittedAt: "2026-06-30T00:00:00.000Z",
	asOf: "2026-06-30T00:00:00.000Z",
	applicantName: "Alice",
	companyName: "Alice Pte Ltd",
	registrationNumber: "202600001A",
	industry: "Retail",
	yearsTrading: 3,
	city: "Singapore",
	status: "pending_review",
	aiResearchConsent: true,
	documentProcessingConsent: true,
} as unknown as CaseFacts;

const input: PolicyStageInput = {
	applicationId: facts.applicationId,
	runId: "33333333-3333-4333-8333-333333333333",
	authorisingActorId: "44444444-4444-4444-8444-444444444444",
	authorisingActorRole: "service",
	asOf: facts.asOf,
	caseFacts: facts,
	signals: [
		{
			type: "negative_balance",
			metric: "negative_eod_days",
			periodStart: "2026-01-01",
			periodEnd: "2026-06-30",
			accountScope: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			status: "review",
			confidence: "high",
		},
		{
			type: "negative_balance",
			metric: "negative_eod_days",
			periodStart: "2026-02-01",
			periodEnd: "2026-06-30",
			accountScope: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			status: "review",
			confidence: "medium",
		},
	],
};

describe("research policy stage context", () => {
	it("maps account UUIDs to ordinals and bands the case", () => {
		const map = accountScopeMap(input.signals);
		expect([...map.values()]).toEqual(["account_1", "account_2"]);
		const context = buildPolicyCaseContext(input);
		expect(context.amountBand).toBe("50k_250k");
		expect(context.termBand).toBe("12_36m");
		expect(context.signals[0]?.accountScope).toBe("account_1");
		expect(JSON.stringify(context)).not.toContain("aaaaaaaa-aaaa");
		expect(JSON.stringify(context)).not.toContain("Alice");
	});
	it("rejects an unknown signal instead of passing it through", () => {
		const bad = {
			...input,
			signals: [{ ...input.signals[0]!, metric: "invented" }],
		};
		expect(() => buildPolicyCaseContext(bad)).toThrow();
	});
	it("mints a two-part token without applicant data", () => {
		const token = createCaseTokenForInput(
			{
				policyAssistEnabled: true,
				policyUrl: "http://policy:4006",
				policyInternalSecret: "this-is-a-test-policy-secret",
				policyCaseTokenSecret: "this-is-a-test-case-secret",
				policyCaseTokenTtlSeconds: 120,
				policyCaseTimeoutMs: 1000,
				autoTriggerServiceUserId: "00000000-0000-0000-0000-000000000000",
				autoTriggerServiceEmail: "research@internal.local",
			},
			input,
		);
		expect(token.split(".")).toHaveLength(2);
		expect(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8")).not.toContain("Alice");
	});
});

describe("policy HTTP runner", () => {
	it("posts the strict context and parses the response", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), init: init ?? {} });
			return new Response(
				JSON.stringify({
					status: "succeeded",
					summary: "ok",
					items: [],
					limitations: [],
					usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.01, model: "test" },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof fetch;
		const runner = createHttpPolicyRunner(
			{
				policyAssistEnabled: true,
				policyUrl: "http://policy:4006",
				policyInternalSecret: "this-is-a-test-policy-secret",
				policyCaseTokenSecret: "this-is-a-test-case-secret",
				policyCaseTokenTtlSeconds: 120,
				policyCaseTimeoutMs: 1000,
				autoTriggerServiceUserId: "00000000-0000-0000-0000-000000000000",
				autoTriggerServiceEmail: "research@internal.local",
			},
			fakeFetch,
		);
		const context = buildPolicyCaseContext(input);
		const result = await runner.explainCase({ caseContext: context, caseToken: "token" });
		expect(result.status).toBe("succeeded");
		expect(calls[0]?.url).toBe("http://policy:4006/internal/policy/explain-case");
		expect(calls[0]?.init.method).toBe("POST");
		expect(String(calls[0]?.init.body)).toContain("account_1");
		expect(String(calls[0]?.init.body)).not.toContain("Alice");
	});
});
