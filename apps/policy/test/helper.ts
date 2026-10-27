import { Hono } from "hono";
import { HttpError, type ServiceVariables } from "@credit/service-kit";
import type { RetrievedSection } from "../src/answer.js";
import { signalRef, type PolicyCaseContext } from "../src/case-context.js";
import { createPolicyRoutes } from "../src/routes.js";
import type { PolicyChunk, PolicyDeps, PolicyQueryRecord, PolicyStore } from "../src/store.js";

export const policyMarkdown = `---
policy_key: POL-CR-001
title: Credit Underwriting Policy
domain: credit
policy_family: underwriting
product_scope: all
jurisdiction: SG
version: v1
owner_email: policy.owner@example.com
effective_from: 2026-01-01
---

## 1 Purpose {#1}

This policy sets the credit underwriting requirements.

## 4.2 Affordability {#4.2}

DSCR must be at least 1.25x for SME term loans. Exceptions require documented approval by the credit committee.
`;

export const retrieved: RetrievedSection[] = [
	{
		policyId: "p1",
		policyVersionId: "11111111-1111-4111-8111-111111111111",
		policyKey: "POL-CR-001",
		title: "Credit Underwriting Policy",
		sectionId: "4.2",
		heading: "4.2 Affordability",
		version: "v1",
		effectiveFrom: "2026-01-01",
		effectiveTo: null,
		body: "DSCR must be at least 1.25x for SME term loans. Exceptions require documented approval by the credit committee.",
		policyFamily: "underwriting",
		productScope: "all",
		jurisdiction: "SG",
	},
];

export const testChunk: PolicyChunk = {
	chunkId: "chunk-1",
	indexVersion: "idx-v1",
	policyId: "22222222-2222-4222-8222-222222222222",
	policyKey: "POL-CR-001",
	title: "Credit Underwriting Policy",
	policyVersionId: "11111111-1111-4111-8111-111111111111",
	version: "v1",
	effectiveFrom: "2026-01-01",
	effectiveTo: null,
	sectionId: "4.2",
	heading: "4.2 Affordability",
	body: "DSCR must be at least 1.25x for SME term loans.",
	policyFamily: "affordability",
	productScope: "all",
	jurisdiction: "SG",
	contentHash: "chunk-content-hash",
	embedding: [1, ...Array(1023).fill(0)],
	embeddingModel: "voyageai/voyage-4-large",
	embeddingDimensions: 1024,
	chunkingVersion: "sections-v1",
};

export function baseContext(): PolicyCaseContext {
	return {
		applicationId: "22222222-2222-4222-8222-222222222222",
		runId: "33333333-3333-4333-8333-333333333333",
		authorisingActorId: "44444444-4444-4444-8444-444444444444",
		authorisingActorRole: "service",
		asOf: "2026-06-30",
		type: "sme",
		product: "sme_term_loan",
		amountBand: "50k_250k",
		termBand: "12_36m",
		signals: [
			{
				ref: signalRef({
					type: "negative_balance",
					metric: "negative_eod_days",
					periodStart: "2026-01-01",
					periodEnd: "2026-06-30",
					accountScope: "account_1",
				}),
				type: "negative_balance",
				metric: "negative_eod_days",
				periodStart: "2026-01-01",
				periodEnd: "2026-06-30",
				accountScope: "account_1",
				status: "review",
				confidence: "high",
			},
		],
		documentFindings: [
			{ field: "company_name", status: "mismatch", confidence: "medium", index: 0 },
		],
	};
}

export function appWithUser(
	d: PolicyDeps,
	user: { id: string; email: string; role: "officer" | "service" | "applicant" },
): Hono<{ Variables: ServiceVariables }> {
	const app = new Hono<{ Variables: ServiceVariables }>();
	app.use("*", async (c, next) => {
		c.set("user", user);
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

export interface FakeStats {
	queries: number;
	embeds: number;
	answers: number;
	citations: number;
}

export type QueryLog = Pick<
	PolicyQueryRecord,
	"status" | "errorCode" | "budgetClass" | "mode" | "questionHmac"
>;

/** Full fake PolicyStore shared by the route tests (officer + service ACLs). */
export function fakePolicyStore(overrides: Partial<PolicyStore> = {}): PolicyStore {
	return {
		async getActiveIndex() {
			return {
				indexVersion: "idx-v1",
				embeddingModel: "voyageai/voyage-4-large",
				embeddingDimensions: 1024,
				chunkingVersion: "sections-v1",
			};
		},
		async loadChunks() {
			return [testChunk];
		},
		async loadAcls(policyIds) {
			return policyIds.flatMap((policyId) => [
				{
					policyId,
					principalType: "role",
					principal: "officer",
					permission: "read",
				},
				{
					policyId,
					principalType: "service",
					principal: "case_explain",
					permission: "case_explain",
				},
			]);
		},
		async loadPolicyRoles() {
			return [];
		},
		async getSection() {
			return null;
		},
		async getSectionByRef() {
			return null;
		},
		async listVersionSectionIds() {
			return [];
		},
		async listVersionCorpusSections() {
			return [];
		},
		async listApprovedCorpusSections() {
			return [];
		},
		async hasVersionChunks() {
			return true;
		},
		async insertQuery() {},
		async insertCitations() {},
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
		...overrides,
	};
}

/** Counting deps (fake store + embedder/answerer) shared by the route tests. */
export function baseDeps(
	overrides: { store?: Partial<PolicyStore>; env?: Record<string, unknown> } = {},
): { deps: PolicyDeps; stats: FakeStats; queries: QueryLog[] } {
	const stats: FakeStats = { queries: 0, embeds: 0, answers: 0, citations: 0 };
	const queries: QueryLog[] = [];
	const inner = fakePolicyStore(overrides.store);
	const store: PolicyStore = {
		...inner,
		async insertQuery(record) {
			stats.queries += 1;
			queries.push({
				status: record.status,
				errorCode: record.errorCode,
				budgetClass: record.budgetClass,
				mode: record.mode,
				questionHmac: record.questionHmac,
			});
			await inner.insertQuery(record);
		},
		async insertCitations(queryId, rows) {
			stats.citations += 1;
			await inner.insertCitations(queryId, rows);
		},
	};
	const deps: PolicyDeps = {
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
			policyExceptionDailyBudgetUsd: 2,
			reservationTtlSeconds: 180,
			caseTokenSecret: "case-token-secret",
			embeddingModel: "voyageai/voyage-4-large",
			embeddingDimensions: 1024,
			...overrides.env,
		},
		logger: { info() {}, warn() {}, error() {} },
	};
	return { deps, stats, queries };
}
