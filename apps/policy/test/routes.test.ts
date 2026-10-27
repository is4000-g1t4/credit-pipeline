import { describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { signCaseToken } from "../src/case-token.js";
import { createDrawerToken } from "../src/answer.js";
import type { PolicyDeps } from "../src/store.js";
import type { ServiceVariables } from "@credit/service-kit";
import { appWithUser, baseContext, baseDeps, fakePolicyStore } from "./helper.js";

const versionId = "11111111-1111-4111-8111-111111111111";
const policyId = "22222222-2222-4222-8222-222222222222";

const officer = {
	id: "44444444-4444-4444-8444-444444444444",
	email: "officer@example.com",
	role: "officer" as const,
};
const service = {
	id: "00000000-0000-0000-0000-000000000000",
	email: "research@internal.local",
	role: "service" as const,
};

function officerApp(d: PolicyDeps): Hono<{ Variables: ServiceVariables }> {
	return appWithUser(d, officer);
}

function serviceApp(d: PolicyDeps): Hono<{ Variables: ServiceVariables }> {
	return appWithUser(d, service);
}

async function postJson(app: Hono<{ Variables: ServiceVariables }>, path: string, body: unknown) {
	return app.request(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function caseTokenFor(d: PolicyDeps, context: ReturnType<typeof baseContext>): string {
	return signCaseToken(
		d.env.caseTokenSecret,
		{
			runId: context.runId,
			applicationId: context.applicationId,
			authorisingActorId: context.authorisingActorId,
			authorisingActorRole: context.authorisingActorRole,
			asOf: context.asOf,
		},
		120,
	);
}

describe("policy routes", () => {
	it("returns a validated navigator answer and logs the query", async () => {
		const { deps: d, stats } = baseDeps();
		const res = await postJson(officerApp(d), "/api/policy/ask", {
			question: "What DSCR must an SME term loan meet?",
			product: "sme_term_loan",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string; citations: unknown[] };
		expect(body.status).toBe("succeeded");
		expect(body.citations.length).toBe(1);
		expect(stats.queries).toBe(1);
		expect(stats.citations).toBe(1);
	});

	it("short-circuits an out-of-scope question without embedding or answering", async () => {
		const { deps: d, stats } = baseDeps();
		const res = await postJson(officerApp(d), "/api/policy/ask", {
			question: "What is the AML training requirement for HR?",
			product: "sme_term_loan",
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as { status: string }).status).toBe("out_of_scope");
		expect(stats.queries).toBe(1);
		expect(stats.embeds).toBe(0);
		expect(stats.answers).toBe(0);
	});

	it("blocks a direct identifier before embedding or answering", async () => {
		const { deps: d, stats } = baseDeps();
		const res = await postJson(officerApp(d), "/api/policy/ask", {
			question: "What is the TDSR for applicant S1234567D?",
			product: "personal_loan",
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as { status: string }).status).toBe("identifier_blocked");
		expect(stats.queries).toBe(1);
		expect(stats.embeds).toBe(0);
		expect(stats.answers).toBe(0);
	});
	it("serves a case explanation for the service principal with a bound token", async () => {
		const { deps: d, stats } = baseDeps();
		const context = baseContext();
		const token = caseTokenFor(d, context);
		const res = await postJson(serviceApp(d), "/internal/policy/explain-case", {
			caseContext: context,
			caseToken: token,
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string; items: unknown[] };
		expect(body.status).toBe("succeeded");
		expect(body.items).toHaveLength(1);
		expect(stats.queries).toBe(1);
		expect(stats.answers).toBe(1);
	});

	it("rejects a case token bound to another run", async () => {
		const { deps: d } = baseDeps();
		const token = signCaseToken(
			d.env.caseTokenSecret,
			{
				runId: "99999999-9999-4999-8999-999999999999",
				applicationId: "22222222-2222-4222-8222-222222222222",
				authorisingActorId: "44444444-4444-4444-8444-444444444444",
				authorisingActorRole: "service",
				asOf: "2026-06-30",
			},
			120,
		);
		const res = await postJson(serviceApp(d), "/internal/policy/explain-case", {
			caseContext: baseContext(),
			caseToken: token,
		});
		expect(res.status).toBe(401);
	});

	it("returns no_match when the ACL denies every chunk", async () => {
		const { deps: inner, stats } = baseDeps();
		const d: PolicyDeps = {
			...inner,
			store: {
				...inner.store,
				async loadAcls() {
					return [];
				},
			},
		};
		const res = await postJson(officerApp(d), "/api/policy/ask", {
			question: "What DSCR must an SME term loan meet?",
			product: "sme_term_loan",
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as { status: string }).status).toBe("no_match");
		expect(stats.queries).toBe(1);
		expect(stats.answers).toBe(0);
	});

	it("returns budget_exceeded without embedding when the reserve fails", async () => {
		const { deps: inner, stats } = baseDeps();
		const d: PolicyDeps = {
			...inner,
			store: {
				...inner.store,
				async reserveBudget() {
					return { error: "budget_exceeded" as const };
				},
			},
		};
		const res = await postJson(officerApp(d), "/api/policy/ask", {
			question: "What DSCR must an SME term loan meet?",
			product: "sme_term_loan",
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as { status: string }).status).toBe("budget_exceeded");
		expect(stats.queries).toBe(1);
		expect(stats.embeds).toBe(0);
		expect(stats.answers).toBe(0);
	});

	it("returns budget_exceeded for a case when the reserve fails", async () => {
		const { deps: inner } = baseDeps();
		const d: PolicyDeps = {
			...inner,
			store: fakePolicyStore({
				async reserveBudget() {
					return { error: "budget_exceeded" as const };
				},
			}),
		};
		const context = baseContext();
		const res = await postJson(serviceApp(d), "/internal/policy/explain-case", {
			caseContext: context,
			caseToken: caseTokenFor(d, context),
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as { status: string }).status).toBe("budget_exceeded");
	});

	it("rejects a replayed case token", async () => {
		const { deps: inner } = baseDeps();
		const d: PolicyDeps = {
			...inner,
			store: fakePolicyStore({
				async consumeCaseToken() {
					return false;
				},
			}),
		};
		const context = baseContext();
		const res = await postJson(serviceApp(d), "/internal/policy/explain-case", {
			caseContext: context,
			caseToken: caseTokenFor(d, context),
		});
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			"CASE_TOKEN_REPLAY",
		);
	});

	it("serves a drawer section with a valid token and rejects a tampered one", async () => {
		const { deps: inner } = baseDeps();
		const section = {
			policyId,
			policyKey: "POL-CR-001",
			title: "Credit Underwriting Policy",
			policyVersionId: versionId,
			version: "v1",
			status: "approved",
			effectiveFrom: "2026-01-01",
			effectiveTo: null,
			sectionId: "4.2",
			heading: "4.2 Affordability",
			body: "DSCR must be at least 1.25x for SME term loans.",
			neighbours: [],
		};
		const d: PolicyDeps = {
			...inner,
			store: fakePolicyStore({
				async getSection() {
					return section;
				},
			}),
		};
		const token = createDrawerToken(d.env.citationSecret, {
			versionId,
			sectionId: "4.2",
			asOf: "2026-06-30",
			queryId: "test-query",
		});
		const ok = await officerApp(d).request(
			`/api/policy/sections/${versionId}/4.2?token=${encodeURIComponent(token)}`,
		);
		expect(ok.status).toBe(200);
		expect(((await ok.json()) as { sectionId: string }).sectionId).toBe("4.2");
		const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
		const bad = await officerApp(d).request(
			`/api/policy/sections/${versionId}/4.2?token=${encodeURIComponent(tampered)}`,
		);
		expect(bad.status).toBe(404);
	});

	it("rejects a drawer read when the ACL denies it", async () => {
		const { deps: inner } = baseDeps();
		const section = {
			policyId,
			policyKey: "POL-CR-001",
			title: "Credit Underwriting Policy",
			policyVersionId: versionId,
			version: "v1",
			status: "approved",
			effectiveFrom: "2026-01-01",
			effectiveTo: null,
			sectionId: "4.2",
			heading: "4.2 Affordability",
			body: "DSCR must be at least 1.25x for SME term loans.",
			neighbours: [],
		};
		const d: PolicyDeps = {
			...inner,
			store: fakePolicyStore({
				async getSection() {
					return section;
				},
				async loadAcls() {
					return [];
				},
			}),
		};
		const token = createDrawerToken(d.env.citationSecret, {
			versionId,
			sectionId: "4.2",
			asOf: "2026-06-30",
			queryId: "test-query",
		});
		const res = await officerApp(d).request(
			`/api/policy/sections/${versionId}/4.2?token=${encodeURIComponent(token)}`,
		);
		expect(res.status).toBe(404);
	});
});
