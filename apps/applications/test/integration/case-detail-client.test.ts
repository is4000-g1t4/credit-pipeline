// Applicant-safe case detail (UBS §3): allowlisted projection, view gating,
// assignment-gated officer fraudReview, terminal failure mapping.
import { randomUUID } from "node:crypto";
import {
	applications,
	auditLog,
	caseAccessGrants,
	decisions,
	documents,
	externalReports,
	fraudReviews,
	kycChecks,
	policyEvaluations,
	scores,
} from "@credit/db/applications";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createUser,
	individualPayload,
	postApplication,
	setupApp,
	signed,
	teardown,
	type TestContext,
	type TestUser,
} from "../helper.js";

let ctx: TestContext;
let ctxOn: TestContext;

beforeAll(() => {
	ctx = setupApp();
	ctxOn = setupApp({ integrity: { config: { fraudReviewEnabled: true } } });
});

afterAll(async () => {
	await teardown(ctx);
	await teardown(ctxOn);
});

async function getDetail(
	context: TestContext,
	user: TestUser,
	id: string,
	query = "",
): Promise<Response> {
	const path = `/api/applications/${id}${query}`;
	// Signatures cover the path only (requireInternal uses c.req.path).
	return context.app.request(path, {
		headers: signed(context, user, "GET", `/api/applications/${id}`),
	});
}

async function newSubmittedCase(
	context: TestContext,
	owner?: TestUser,
): Promise<{ owner: TestUser; id: string }> {
	const user = owner ?? (await createUser(context));
	const res = await postApplication(
		context,
		user,
		"/api/applications",
		individualPayload(user.email),
	);
	expect(res.status).toBe(201);
	const { id } = (await res.json()) as { id: string };
	return { owner: user, id };
}

async function seedInternals(context: TestContext, applicationId: string, officer: TestUser) {
	await context.db.insert(kycChecks).values({
		applicationId,
		type: "identity",
		status: "passed",
		details: { secretDetail: true },
	});
	await context.db.insert(documents).values({
		applicationId,
		kind: "bank_statement",
		status: "verified",
		note: "visible note",
	});
	await context.db.insert(scores).values({
		applicationId,
		modelVersion: "scorecard-v1",
		score: 777,
		grade: "A",
		factors: [{ code: "DELINQUENCIES", label: "Delinquencies", points: -40, impact: "negative" }],
		affordability: {},
	});
	await context.db.insert(policyEvaluations).values({
		applicationId,
		policyVersion: "policy-v1",
		outcome: "refer",
		reasons: [{ code: "AMOUNT_ABOVE_AUTO_LIMIT", text: "above auto limit" }],
		maxAmountCents: 5_000_000,
		inputs: { secretInput: true },
		inputHash: "test",
	});
	await context.db.insert(externalReports).values({
		applicationId,
		provider: "mock-bureau-v1",
		kind: "bureau",
		version: "mock-bureau-v1",
		payload: { bureauScore: 700, secretSsn: "SECRET-SSN" },
	});
	await context.db.insert(decisions).values({
		applicationId,
		outcome: "approved",
		decidedBy: "officer",
		officerUserId: officer.id,
		approvedAmountCents: 1_000_000,
		termMonths: 36,
		reasons: ["AFFORDABILITY_OK"],
		notes: "SECRET-NOTE",
		snapshot: { secretSnapshot: true },
	});
	// Allowlisted action carrying a secret payload, plus a non-allowlisted one.
	await context.db.insert(auditLog).values([
		{
			applicationId,
			actor: officer.id,
			action: "decision.made",
			entity: "decision",
			payload: { secretPayload: true },
		},
		{
			applicationId,
			actor: officer.id,
			action: "document.uploaded",
			entity: "document",
			payload: { secretPayload: true },
		},
	]);
}

const APPLICANT_APP_KEYS = [
	"aiResearchConsent",
	"amountCents",
	"business",
	"consents",
	"contextAnalysisConsent",
	"contextConsentAt",
	"contextConsentVersion",
	"decidedAt",
	"documentConsentAt",
	"documentConsentVersion",
	"documentProcessingConsent",
	"documentsEnabled",
	"failedReason",
	"financial",
	"id",
	"identity",
	"product",
	"purpose",
	"reference",
	"status",
	"submittedAt",
	"termMonths",
	"type",
	"updatedAt",
	"workflowStartedAt",
].sort();

const APPLICANT_ACTIONS = new Set([
	"application.submitted",
	"decision.made",
	"application.booked",
	"application.failed",
	"review.expired",
]);

describe("applicant case detail projection", () => {
	it("returns exactly the allowlist and never internal fields", async () => {
		const officer = await createUser(ctx, "officer");
		const { owner, id } = await newSubmittedCase(ctx);
		await seedInternals(ctx, id, officer);

		const res = await getDetail(ctx, owner, id);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;

		expect(Object.keys(body).sort()).toEqual([
			"application",
			"checks",
			"decision",
			"documents",
			"failure",
			"timeline",
		]);
		expect(body).not.toHaveProperty("loan");
		for (const leaked of ["score", "policyEvaluation", "externalReports"]) {
			expect(body).not.toHaveProperty(leaked);
		}

		const app = body.application as Record<string, unknown>;
		expect(Object.keys(app).sort()).toEqual(APPLICANT_APP_KEYS);
		expect(app.failedReason).toBeNull();
		expect(app.workflowStartedAt).toBeNull();
		expect(typeof app.updatedAt).toBe("string");

		for (const check of body.checks as Array<Record<string, unknown>>) {
			expect(Object.keys(check).sort()).toEqual(["status", "type"]);
		}
		for (const doc of body.documents as Array<Record<string, unknown>>) {
			expect(Object.keys(doc).sort()).toEqual(["kind", "note", "status"]);
		}

		const decision = body.decision as Record<string, unknown>;
		expect(decision.outcome).toBe("approved");
		for (const leaked of ["notes", "snapshot", "officerUserId", "requestId"]) {
			expect(decision).not.toHaveProperty(leaked);
		}

		const timeline = body.timeline as Array<Record<string, unknown>>;
		expect(timeline.length).toBeGreaterThan(0);
		for (const entry of timeline) {
			expect(Object.keys(entry).sort()).toEqual(["action", "at"]);
			expect(APPLICANT_ACTIONS.has(entry.action as string)).toBe(true);
		}
		const ats = timeline.map((e) => e.at as string);
		expect(ats.slice().sort((a, b) => b.localeCompare(a))).toEqual(ats);
		expect(timeline.some((e) => e.action === "document.uploaded")).toBe(false);

		expect(body.failure).toBeNull();
		const serialized = JSON.stringify(body);
		for (const secret of [
			"SECRET-NOTE",
			"SECRET-SSN",
			"secretSnapshot",
			"secretPayload",
			"DELINQUENCIES",
		]) {
			expect(serialized).not.toContain(secret);
		}
	});

	it("view=client returns the safe shape; other view values are 400", async () => {
		const officer = await createUser(ctx, "officer");
		const { owner, id } = await newSubmittedCase(ctx);
		await seedInternals(ctx, id, officer);

		const client = await getDetail(ctx, owner, id, "?view=client");
		expect(client.status).toBe(200);
		const clientBody = (await client.json()) as Record<string, unknown>;
		expect(clientBody).not.toHaveProperty("score");
		expect(Object.keys(clientBody.application as Record<string, unknown>).sort()).toEqual(
			APPLICANT_APP_KEYS,
		);

		const bad = await getDetail(ctx, owner, id, "?view=foo");
		expect(bad.status).toBe(400);
		expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
	});

	it("officers ignore view and keep the full shape; strangers get 404", async () => {
		const officer = await createUser(ctx, "officer");
		const stranger = await createUser(ctx);
		const { id } = await newSubmittedCase(ctx);
		await seedInternals(ctx, id, officer);

		for (const query of ["", "?view=client", "?view=foo"]) {
			const res = await getDetail(ctx, officer, id, query);
			expect(res.status).toBe(200);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body).toHaveProperty("score");
			expect(body).toHaveProperty("policyEvaluation");
			expect(body).toHaveProperty("externalReports");
			const timeline = body.timeline as Array<Record<string, unknown>>;
			expect(timeline.some((e) => "actor" in e && "payload" in e)).toBe(true);
			const decision = body.decision as Record<string, unknown>;
			expect(decision).toHaveProperty("notes");
			expect(decision).toHaveProperty("snapshot");
		}

		const denied = await getDetail(ctx, stranger, id);
		expect(denied.status).toBe(404);

		const bogus = await getDetail(ctx, officer, "not-a-uuid");
		expect(bogus.status).toBe(404);
		const missing = await getDetail(ctx, officer, randomUUID());
		expect(missing.status).toBe(404);
	});

	it("officers get 404 on drafts", async () => {
		const owner = await createUser(ctx);
		const officer = await createUser(ctx, "officer");
		const [row] = await ctx.db
			.insert(applications)
			.values({
				reference: `DRAFT-${randomUUID().slice(0, 8)}`,
				applicantUserId: owner.id,
				type: "individual",
				product: "personal_loan",
				status: "draft",
				amountCents: 1200000,
				termMonths: 48,
				purpose: "draft case",
				identity: { fullName: "Draft Owner" },
				consents: [true, true, true],
				submittedAt: null,
			})
			.returning({ id: applications.id });
		expect((await getDetail(ctx, officer, row.id)).status).toBe(404);
		expect((await getDetail(ctx, owner, row.id)).status).toBe(200);
	});
});

async function openReview(
	context: TestContext,
	applicationId: string,
	overrides: { status?: "open" | "needs_info" | "cleared"; reviewType?: string } = {},
) {
	const [row] = await context.db
		.insert(fraudReviews)
		.values({
			applicationId,
			reviewType: overrides.reviewType ?? "document_integrity",
			status: overrides.status ?? "open",
			reasonCode: "document_integrity",
			severity: "high",
			note: "SECRET-REVIEW-NOTE",
			signalCodes: ["duplicate_hash_cross_application"],
			documentRefs: ["SECRET-DOC-REF"],
			sourceHash: `src-${randomUUID()}`,
			createdBy: randomUUID(),
			retentionUntil: new Date(Date.now() + 86_400_000),
		})
		.returning();
	return row;
}

describe("officer fraudReview gating", () => {
	it("is null without a grant, present with a grant + open review + flag on", async () => {
		const owner = await createUser(ctxOn);
		const officer = await createUser(ctxOn, "officer");
		const { id } = await newSubmittedCase(ctxOn, owner);

		const unassigned = await getDetail(ctxOn, officer, id);
		expect(unassigned.status).toBe(200);
		expect(((await unassigned.json()) as { fraudReview: unknown }).fraudReview).toBeNull();

		await ctxOn.db.insert(caseAccessGrants).values({
			applicationId: id,
			userId: officer.id,
			accessRole: "assigned_officer",
		});
		const review = await openReview(ctxOn, id);

		const assigned = await getDetail(ctxOn, officer, id);
		expect(assigned.status).toBe(200);
		const assignedBody = (await assigned.json()) as { fraudReview: Record<string, unknown> };
		expect(assignedBody.fraudReview).toEqual({
			id: review.id,
			status: "open",
			severity: "high",
			reasonCode: "document_integrity",
		});

		// Applicants never see it, even with a review present.
		const applicantView = await getDetail(ctxOn, owner, id);
		expect(applicantView.status).toBe(200);
		expect((await applicantView.json()) as Record<string, unknown>).not.toHaveProperty(
			"fraudReview",
		);
	});

	it("prefers the newest active review and resolves to null once cleared", async () => {
		const officer = await createUser(ctxOn, "officer");
		const { id } = await newSubmittedCase(ctxOn);
		await ctxOn.db.insert(caseAccessGrants).values({
			applicationId: id,
			userId: officer.id,
			accessRole: "assigned_officer",
		});
		await openReview(ctxOn, id, { status: "open" });
		const newer = await openReview(ctxOn, id, {
			status: "needs_info",
			reviewType: "manual_review",
		});

		const res = await getDetail(ctxOn, officer, id);
		expect(
			((await res.json()) as { fraudReview: { id: string; status: string } }).fraudReview,
		).toMatchObject({
			id: newer.id,
			status: "needs_info",
		});
	});

	it("is null for resolved-only reviews and when the flag is off", async () => {
		// Resolved-only (flag on).
		const officer = await createUser(ctxOn, "officer");
		const { id } = await newSubmittedCase(ctxOn);
		await ctxOn.db.insert(caseAccessGrants).values({
			applicationId: id,
			userId: officer.id,
			accessRole: "assigned_officer",
		});
		await openReview(ctxOn, id, { status: "cleared" });
		const resolved = await getDetail(ctxOn, officer, id);
		expect(((await resolved.json()) as { fraudReview: unknown }).fraudReview).toBeNull();

		// Flag off: grant + open review still reads null.
		const offOfficer = await createUser(ctx, "officer");
		const { id: offId } = await newSubmittedCase(ctx);
		await ctx.db.insert(caseAccessGrants).values({
			applicationId: offId,
			userId: offOfficer.id,
			accessRole: "assigned_officer",
		});
		await openReview(ctx, offId);
		const off = await getDetail(ctx, offOfficer, offId);
		expect(off.status).toBe(200);
		expect(((await off.json()) as { fraudReview: unknown }).fraudReview).toBeNull();
	});
});

describe("terminal failure mapping", () => {
	it.each([
		{
			status: "failed",
			code: "PROCESSING_FAILED",
			message: "We could not complete the checks. Please try again or contact us.",
		},
		{
			status: "expired",
			code: "REVIEW_EXPIRED",
			message:
				"The review window expired before a decision. Start a new application or contact us.",
		},
	] as const)(
		"maps status $status to $code with failedReason null",
		async ({ status, code, message }) => {
			const { owner, id } = await newSubmittedCase(ctx);
			await ctx.db
				.update(applications)
				.set({
					status: status as "failed" | "expired",
					failedReason: `INTERNAL_${status.toUpperCase()}`,
				})
				.where(eq(applications.id, id));
			const res = await getDetail(ctx, owner, id);
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				application: { failedReason: unknown; workflowStartedAt: unknown };
				failure: { code: string; message: string };
			};
			expect(body.failure).toEqual({ code, message });
			expect(body.application.failedReason).toBeNull();
			expect(body.application.workflowStartedAt).toBeNull();
		},
	);
});
