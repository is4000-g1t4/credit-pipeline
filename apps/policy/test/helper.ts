import { Hono } from "hono";
import { HttpError, type ServiceVariables } from "@credit/service-kit";
import type { RetrievedSection } from "../src/answer.js";
import { signalRef, type PolicyCaseContext } from "../src/case-context.js";
import { createPolicyRoutes } from "../src/routes.js";
import type { PolicyChunk, PolicyDeps } from "../src/store.js";

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
