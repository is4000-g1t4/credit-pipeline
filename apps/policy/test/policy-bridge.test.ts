import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ServiceVariables } from "@credit/service-kit";
import { hashQuote } from "@credit/core";
import type { PolicySectionRow } from "@credit/core";
import type { PolicyDeps, PolicyStore } from "../src/store.js";
import { appWithUser, baseDeps, fakePolicyStore, type QueryLog } from "./helper.js";

const service = {
	id: "00000000-0000-0000-0000-000000000000",
	email: "svc@internal.local",
	role: "service" as const,
};
const officer = {
	id: "44444444-4444-4444-8444-444444444444",
	email: "officer@example.com",
	role: "officer" as const,
};

const APP_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "44444444-4444-4444-8444-444444444444";

function rowFor(
	policyKey: string,
	sectionId: string,
	body: string,
	policyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
): PolicySectionRow {
	return {
		policyId,
		policyKey,
		title: `${policyKey} title`,
		policyVersionId: "11111111-1111-4111-8111-111111111111",
		version: "v1",
		status: "approved",
		effectiveFrom: "2026-01-01",
		effectiveTo: null,
		sectionId,
		heading: `${sectionId} heading`,
		body,
		contentHash: `hash-${sectionId}`,
		policyFamily: "underwriting",
		productScope: "all",
		jurisdiction: "SG",
		domain: "credit",
	};
}

function testDeps(
	storeOverrides: Partial<PolicyStore> = {},
	envOverrides: Record<string, unknown> = {},
): { deps: PolicyDeps; queries: QueryLog[] } {
	const store = fakePolicyStore(storeOverrides);
	const { deps, queries } = baseDeps({ store, env: envOverrides });
	// Bridge routes are deterministic retrieval/explain endpoints; calling an
	// LLM from them is a bug. Make that fail loudly instead of silently
	// succeeding through the generic fake.
	return {
		deps: {
			...deps,
			answerer: {
				async answerNavigator() {
					throw new Error("LLM answerer must not be called on bridge routes");
				},
				async answerCase() {
					throw new Error("LLM answerer must not be called on bridge routes");
				},
			},
		},
		queries,
	};
}

async function postJson(
	app: Hono<{ Variables: ServiceVariables }>,
	path: string,
	body: unknown,
): Promise<Response> {
	return app.request(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function resolveBody(
	refs: Array<{ policyKey: string; sectionId: string; versionId?: string }>,
): Record<string, unknown> {
	return {
		applicationId: APP_ID,
		actorId: ACTOR_ID,
		actorRole: "officer",
		policyAsOf: "2026-06-30",
		productScope: "sme",
		refs,
	};
}

describe("policy exception bridge", () => {
	it("resolve success logs succeeded and returns drawer tokens", async () => {
		const { deps, queries } = testDeps({
			async getSectionByRef({ sectionId }) {
				return rowFor("POL-CR-001", sectionId, "DSCR must be at least 1.25x for SME term loans.");
			},
		});
		const app = appWithUser(deps, service);
		const res = await postJson(
			app,
			"/internal/policy/sections/resolve",
			resolveBody([
				{ policyKey: "POL-CR-001", sectionId: "4.2" },
				{ policyKey: "POL-CR-002", sectionId: "2.1" },
			]),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			status: string;
			sections: Array<{
				policyKey: string;
				sectionId: string;
				body: string;
				truncated: boolean;
				quoteHash: string;
				drawerToken: string;
				contentHash: string;
			}>;
			missing: unknown[];
		};
		expect(body.status).toBe("ok");
		expect(body.sections).toHaveLength(2);
		expect(body.missing).toEqual([]);
		expect(body.sections[0]!.truncated).toBe(false);
		expect(body.sections[0]!.quoteHash).toBe(hashQuote(body.sections[0]!.body));
		expect(body.sections[0]!.drawerToken).toBeTruthy();
		expect(queries).toHaveLength(1);
		expect(queries[0]).toMatchObject({
			status: "succeeded",
			budgetClass: "policy_exception",
			mode: "case_explain",
			questionHmac: null,
		});
	});

	it("resolve partial maps absent refs to not_found", async () => {
		const { deps, queries } = testDeps({
			async getSectionByRef({ sectionId }) {
				if (sectionId === "9.9") return null;
				return rowFor("POL-CR-001", sectionId, "Some body text here.");
			},
		});
		const app = appWithUser(deps, service);
		const res = await postJson(
			app,
			"/internal/policy/sections/resolve",
			resolveBody([
				{ policyKey: "POL-CR-001", sectionId: "4.2" },
				{ policyKey: "POL-CR-001", sectionId: "9.9" },
			]),
		);
		const body = (await res.json()) as {
			status: string;
			sections: unknown[];
			missing: Array<{ reason: string }>;
		};
		expect(body.status).toBe("partial");
		expect(body.sections).toHaveLength(1);
		expect(body.missing).toHaveLength(1);
		expect(body.missing[0]!.reason).toBe("not_found");
		expect(queries[0]!.status).toBe("succeeded");
	});

	it("resolve maps ACL denials to forbidden", async () => {
		const { deps } = testDeps({
			async getSectionByRef({ policyKey, sectionId }) {
				return rowFor(
					policyKey,
					sectionId,
					"Body text.",
					sectionId === "4.2" ? "policy-allowed" : "policy-denied",
				);
			},
			async loadAcls(policyIds) {
				return policyIds
					.filter((id) => id === "policy-allowed")
					.map((policyId) => ({
						policyId,
						principalType: "service" as const,
						principal: "case_explain",
						permission: "case_explain" as const,
					}));
			},
		});
		const app = appWithUser(deps, service);
		const res = await postJson(
			app,
			"/internal/policy/sections/resolve",
			resolveBody([
				{ policyKey: "POL-CR-001", sectionId: "4.2" },
				{ policyKey: "POL-CR-001", sectionId: "2.2" },
			]),
		);
		const body = (await res.json()) as {
			status: string;
			sections: unknown[];
			missing: Array<{ reason: string }>;
		};
		expect(body.status).toBe("partial");
		expect(body.sections).toHaveLength(1);
		expect(body.missing[0]!.reason).toBe("forbidden");
	});

	it("resolve truncates bodies at 8k per section and 40k total", async () => {
		const big = "x".repeat(9000);
		const { deps } = testDeps({
			async getSectionByRef() {
				return rowFor("POL-CR-001", "4.2", big);
			},
		});
		const app = appWithUser(deps, service);
		const res = await postJson(
			app,
			"/internal/policy/sections/resolve",
			resolveBody([{ policyKey: "POL-CR-001", sectionId: "4.2" }]),
		);
		const body = (await res.json()) as { sections: Array<{ body: string; truncated: boolean }> };
		expect(body.sections[0]!.body.length).toBe(8000);
		expect(body.sections[0]!.truncated).toBe(true);

		// Total cap: 6 sections at the per-section cap exceed 40k.
		const { deps: deps2 } = testDeps({
			async getSectionByRef({ sectionId }) {
				return rowFor("POL-CR-001", sectionId, "y".repeat(8000));
			},
		});
		const app2 = appWithUser(deps2, service);
		const res2 = await postJson(
			app2,
			"/internal/policy/sections/resolve",
			resolveBody(
				["a", "b", "c", "d", "e", "f"].map((sectionId) => ({ policyKey: "POL-CR-001", sectionId })),
			),
		);
		const body2 = (await res2.json()) as {
			sections: Array<{ body: string; truncated: boolean }>;
			missing: Array<{ reason: string }>;
		};
		const total = body2.sections.reduce((n, s) => n + s.body.length, 0);
		expect(total).toBeLessThanOrEqual(40000);
		expect(body2.missing.some((m) => m.reason === "truncated")).toBe(true);
	});

	it("resolve rejects non-service callers and a disabled flag", async () => {
		const getSectionByRef = async () => rowFor("POL-CR-001", "4.2", "Body.");
		const { deps } = testDeps({ getSectionByRef });
		const officerApp = appWithUser(deps, officer);
		const denied = await postJson(
			officerApp,
			"/internal/policy/sections/resolve",
			resolveBody([{ policyKey: "POL-CR-001", sectionId: "4.2" }]),
		);
		expect(denied.status).toBe(403);

		const { deps: offDeps } = testDeps({ getSectionByRef }, { assistEnabled: false });
		const offApp = appWithUser(offDeps, service);
		const off = await postJson(
			offApp,
			"/internal/policy/sections/resolve",
			resolveBody([{ policyKey: "POL-CR-001", sectionId: "4.2" }]),
		);
		expect(off.status).toBe(503);
		expect(((await off.json()) as { error: { code: string } }).error.code).toBe("POLICY_DISABLED");
	});

	it("resolve maps store failures to 503 and logs failed", async () => {
		const { deps, queries } = testDeps({
			async getSectionByRef() {
				throw new Error("db down");
			},
		});
		const app = appWithUser(deps, service);
		const res = await postJson(
			app,
			"/internal/policy/sections/resolve",
			resolveBody([{ policyKey: "POL-CR-001", sectionId: "4.2" }]),
		);
		expect(res.status).toBe(503);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			"POLICY_SOURCE_UNAVAILABLE",
		);
		expect(queries[0]).toMatchObject({ status: "failed" });
	});

	it("search blocks out-of-scope and PII without embedding", async () => {
		const { deps, queries } = testDeps();
		let embeds = 0;
		deps.embedder.embed = async (inputs) => {
			embeds += inputs.length;
			return inputs.map(() => [1, ...Array(1023).fill(0)]);
		};
		const app = appWithUser(deps, service);
		const base = {
			applicationId: APP_ID,
			actorId: ACTOR_ID,
			actorRole: "officer",
			policyAsOf: "2026-06-30",
			productScope: "sme" as const,
		};
		const out = await postJson(app, "/internal/policy/search", {
			...base,
			query: "What is the AML training requirement for HR?",
		});
		expect(out.status).toBe(200);
		expect(((await out.json()) as { status: string }).status).toBe("out_of_scope");
		const pii = await postJson(app, "/internal/policy/search", {
			...base,
			query: "What is the TDSR for applicant S1234567D?",
		});
		expect(((await pii.json()) as { status: string }).status).toBe("identifier_blocked");
		expect(embeds).toBe(0);
		expect(queries.map((q) => q.status)).toEqual(["out_of_scope", "identifier_blocked"]);
	});

	it("search enforces the policy_exception budget with 429", async () => {
		const { deps, queries } = testDeps({
			async reserveBudget() {
				return { error: "budget_exceeded" as const };
			},
		});
		const app = appWithUser(deps, service);
		const res = await postJson(app, "/internal/policy/search", {
			applicationId: APP_ID,
			actorId: ACTOR_ID,
			actorRole: "officer",
			policyAsOf: "2026-06-30",
			productScope: "sme",
			query: "What DSCR must an SME loan meet?",
		});
		expect(res.status).toBe(429);
		expect(queries[0]).toMatchObject({ status: "budget_exceeded" });
	});

	it("search maps store failures to 503 and logs failed", async () => {
		const { deps, queries } = testDeps({
			async loadChunks() {
				throw new Error("db down");
			},
		});
		const app = appWithUser(deps, service);
		const res = await postJson(app, "/internal/policy/search", {
			applicationId: APP_ID,
			actorId: ACTOR_ID,
			actorRole: "officer",
			policyAsOf: "2026-06-30",
			productScope: "sme",
			query: "What DSCR must an SME loan meet for credit policy?",
		});
		expect(res.status).toBe(503);
		expect(queries[queries.length - 1]).toMatchObject({ status: "failed" });
	});
});
