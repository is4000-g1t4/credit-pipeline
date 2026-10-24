import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createPolicyRoutes } from "../src/routes.js";
import { signCaseToken } from "../src/case-token.js";
import type { PolicyDeps, PolicyStore } from "../src/store.js";
import { HttpError, type ServiceVariables } from "@credit/service-kit";

const versionId = "11111111-1111-4111-8111-111111111111";
const policyId = "22222222-2222-4222-8222-222222222222";
const chunk = {
	chunkId: "chunk-1",
	indexVersion: "idx-v1",
	policyId,
	policyKey: "POL-CR-001",
	title: "Credit Underwriting Policy",
	policyVersionId: versionId,
	version: "v1",
	effectiveFrom: "2026-01-01",
	effectiveTo: null,
	sectionId: "4.2",
	heading: "4.2 Affordability",
	body: "DSCR must be at least 1.25x for SME term loans.",
	policyFamily: "affordability",
	productScope: "all",
	jurisdiction: "SG",
	embedding: [1, ...Array(1023).fill(0)],
	embeddingModel: "voyageai/voyage-4-large",
	embeddingDimensions: 1024,
	chunkingVersion: "sections-v1",
};

function deps(overrides: Partial<PolicyDeps> = {}): {
	deps: PolicyDeps;
	stats: { queries: number; embeds: number; answers: number; citations: number };
} {
	const stats = { queries: 0, embeds: 0, answers: 0, citations: 0 };
	const store: PolicyStore = {
		async getActiveIndex() {
			return {
				indexVersion: "idx-v1",
				embeddingModel: "voyageai/voyage-4-large",
				embeddingDimensions: 1024,
				chunkingVersion: "sections-v1",
			};
		},
		async loadChunks() {
			return [chunk];
		},
		async loadAcls() {
			return [
				{
					policyId,
					principalType: "role" as const,
					principal: "officer",
					permission: "read" as const,
				},
				{
					policyId,
					principalType: "service" as const,
					principal: "case_explain",
					permission: "case_explain" as const,
				},
			];
		},
		async loadPolicyRoles() {
			return [];
		},
		async getSection() {
			return null;
		},
		async insertQuery() {
			stats.queries += 1;
		},
		async insertCitations() {
			stats.citations += 1;
		},
		async consumeCaseToken() {
			return true;
		},
		async getVersion() {
			return null;
		},
		async submitVersion() {},
		async approveVersion() {},
		async retireVersion() {},
		async reserveBudget() {
			return { reservationId: "33333333-3333-4333-8333-333333333333" };
		},
		async settleBudget() {},
	};
	const base: PolicyDeps = {
		store,
		embedder: {
			model: "voyageai/voyage-4-large",
			dimensions: 1024,
			async embed(inputs) {
				stats.embeds += inputs.length;
				return inputs.map(() => [1, ...Array(1023).fill(0)]);
			},
		},
		answerer: {
			async answerNavigator() {
				stats.answers += 1;
				return {
					output: {
						status: "succeeded",
						segments: [
							{ text: "SME term loans require a DSCR of at least 1.25x.", citationIndexes: [0] },
						],
						citations: [
							{
								policyKey: "POL-CR-001",
								sectionId: "4.2",
								version: "v1",
								quote: "DSCR must be at least 1.25x",
							},
						],
						limitations: [],
					},
					usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.001, model: "test" },
				};
			},
			async answerCase(input) {
				stats.answers += 1;
				return {
					output: {
						status: "succeeded",
						summary: "affordability",
						items: [
							{
								ref: input.context.signals[0]!.ref,
								explanationSegments: [
									{
										text: "SME term loans require a DSCR of at least 1.25x.",
										citationIndexes: [0],
									},
								],
								citations: [
									{
										policyKey: "POL-CR-001",
										sectionId: "4.2",
										version: "v1",
										quote: "DSCR must be at least 1.25x",
									},
								],
								confidence: "high",
							},
						],
						limitations: [],
					},
					usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.001, model: "test" },
				};
			},
		},
		env: {
			assistEnabled: true,
			citationSecret: "citation-secret",
			auditHashSecret: "audit-secret",
			jurisdiction: "SG",
			retrievalTopK: 8,
			agentTimeoutMs: 5_000,
			caseTimeoutMs: 5_000,
			agentMaxCostUsd: 0.1,
			caseMaxCostUsd: 0.2,
			navDailyBudgetUsd: 2,
			caseDailyBudgetUsd: 2,
			actorDailyBudgetUsd: 1,
			reservationTtlSeconds: 180,
			caseTokenSecret: "case-token-secret",
			embeddingModel: "voyageai/voyage-4-large",
			embeddingDimensions: 1024,
		},
		logger: { info() {}, warn() {}, error() {} },
	};
	return { deps: { ...base, ...overrides }, stats };
}

function officerApp(d: PolicyDeps): Hono<{ Variables: ServiceVariables }> {
	const app = new Hono<{ Variables: ServiceVariables }>();
	app.use("*", async (c, next) => {
		c.set("user", {
			id: "44444444-4444-4444-8444-444444444444",
			email: "officer@example.com",
			role: "officer",
		});
		c.set("requestId", "test");
		await next();
	});
	app.onError((err, c) =>
		err instanceof HttpError
			? c.json({ error: { code: err.code, message: err.message } }, err.status as 400)
			: c.json({ error: { code: "INTERNAL_ERROR", message: "internal error" } }, 500),
	);
	app.route("/", createPolicyRoutes(d));
	return app;
}

function serviceApp(d: PolicyDeps): Hono<{ Variables: ServiceVariables }> {
	const app = new Hono<{ Variables: ServiceVariables }>();
	app.use("*", async (c, next) => {
		c.set("user", {
			id: "00000000-0000-0000-0000-000000000000",
			email: "research@internal.local",
			role: "service",
		});
		c.set("requestId", "test");
		await next();
	});
	app.onError((err, c) =>
		err instanceof HttpError
			? c.json({ error: { code: err.code, message: err.message } }, err.status as 400)
			: c.json({ error: { code: "INTERNAL_ERROR", message: "internal error" } }, 500),
	);
	app.route("/", createPolicyRoutes(d));
	return app;
}

async function postJson(app: Hono<{ Variables: ServiceVariables }>, path: string, body: unknown) {
	return app.request(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("policy routes", () => {
	it("returns a validated navigator answer and logs the query", async () => {
		const { deps: d, stats } = deps();
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
		const { deps: d, stats } = deps();
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
		const { deps: d, stats } = deps();
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
		const { deps: d, stats } = deps();
		const context = {
			applicationId: "22222222-2222-4222-8222-222222222222",
			runId: "33333333-3333-4333-8333-333333333333",
			authorisingActorId: "44444444-4444-4444-8444-444444444444",
			authorisingActorRole: "service" as const,
			asOf: "2026-06-30",
			type: "sme" as const,
			product: "sme_term_loan" as const,
			amountBand: "50k_250k" as const,
			termBand: "12_36m" as const,
			signals: [
				{
					ref: "signal:negative_balance:negative_eod_days:2026-01-01:2026-06-30:account_1",
					type: "negative_balance" as const,
					metric: "negative_eod_days" as const,
					periodStart: "2026-01-01",
					periodEnd: "2026-06-30",
					accountScope: "account_1",
					status: "review" as const,
					confidence: "high" as const,
				},
			],
			documentFindings: [],
		};
		const token = signCaseToken(
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
		const { deps: d } = deps();
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
			caseContext: {
				applicationId: "22222222-2222-4222-8222-222222222222",
				runId: "33333333-3333-4333-8333-333333333333",
				authorisingActorId: "44444444-4444-4444-8444-444444444444",
				authorisingActorRole: "service",
				asOf: "2026-06-30",
				type: "sme",
				product: "sme_term_loan",
				amountBand: "50k_250k",
				termBand: "12_36m",
				signals: [],
				documentFindings: [],
			},
			caseToken: token,
		});
		expect(res.status).toBe(401);
	});
});
