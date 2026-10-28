// Service-only assistant context (assessment snapshot): latest score /
// policy evaluation, the unique decision, and live document metadata —
// no PII, no document text, no filenames/hashes/storage keys. Drafts,
// unknown, and non-service callers stay out.
import { randomUUID } from "node:crypto";
import {
	applications,
	caseAccessGrants,
	decisions,
	documentFiles,
	policyEvaluations,
	scores,
} from "@credit/db/applications";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createUser,
	setupApp,
	signed,
	teardown,
	type TestContext,
	type TestUser,
} from "../helper.js";

let ctx: TestContext;

beforeAll(() => {
	ctx = setupApp();
});

afterAll(async () => {
	await teardown(ctx);
});

async function seedSubmitted(
	over: Partial<typeof applications.$inferSelect> = {},
): Promise<string> {
	const [row] = await ctx.db
		.insert(applications)
		.values({
			reference: `AC-${randomUUID()}`,
			applicantUserId: randomUUID(),
			type: "individual",
			product: "personal_loan",
			status: "pending_review",
			amountCents: 1_200_000,
			termMonths: 48,
			purpose: "assistant context seed",
			identity: { fullName: "Ctx Seed" },
			consents: [true, true, true],
			submittedAt: new Date("2026-01-15T00:00:00Z"),
			...over,
		})
		.returning({ id: applications.id });
	return row.id;
}

async function serviceGet(path: string): Promise<Response> {
	const svc = await createUser(ctx, "service");
	return ctx.app.request(path, { headers: signed(ctx, svc, "GET", path) });
}

async function seedDoc(
	appId: string,
	over: Partial<typeof documentFiles.$inferSelect> = {},
): Promise<string> {
	const [row] = await ctx.db
		.insert(documentFiles)
		.values({
			applicationId: appId,
			kind: "bank_statement",
			status: "ready",
			ocrStatus: "ready",
			mimeType: "application/pdf",
			sizeBytes: 64,
			sha256: `ac-${randomUUID()}`,
			keyId: "v1",
			cryptoVersion: "v1",
			uploadedBy: randomUUID(),
			retentionUntil: new Date("2027-01-01T00:00:00Z"),
			...over,
		})
		.returning({ id: documentFiles.id });
	return row.id;
}

describe("GET /internal/applications/:id/assistant-context", () => {
	it("returns the assessment snapshot with live document metadata only", async () => {
		const appId = await seedSubmitted();
		await ctx.db.insert(scores).values([
			{
				applicationId: appId,
				modelVersion: "scorecard-v1",
				score: 600,
				grade: "C",
				factors: [{ code: "OLD", points: 1 }],
				affordability: { old: true },
				createdAt: new Date("2026-01-10T00:00:00Z"),
			},
			{
				applicationId: appId,
				modelVersion: "scorecard-v2",
				score: 800,
				grade: "A",
				factors: [{ code: "NEW", points: 2 }],
				affordability: { fresh: true },
				createdAt: new Date("2026-01-20T00:00:00Z"),
			},
		]);
		// Newer-created row with a stale evaluation loses to the older
		// row carrying the newer evaluatedAt.
		await ctx.db.insert(policyEvaluations).values([
			{
				applicationId: appId,
				policyVersion: "policy-v0",
				outcome: "pass",
				reasons: [],
				maxAmountCents: 1_000_000,
				inputs: {},
				inputHash: "old",
				evaluatedAt: new Date("2026-01-25T00:00:00Z"),
				createdAt: new Date("2026-01-10T00:00:00Z"),
			},
			{
				applicationId: appId,
				policyVersion: "policy-v1",
				outcome: "refer",
				reasons: [{ code: "STALE", text: "stale" }],
				maxAmountCents: 500_000,
				inputs: {},
				inputHash: "new",
				evaluatedAt: new Date("2026-01-12T00:00:00Z"),
				createdAt: new Date("2026-01-20T00:00:00Z"),
			},
		]);
		await ctx.db.insert(decisions).values({
			applicationId: appId,
			outcome: "approved",
			decidedBy: "officer",
			officerUserId: randomUUID(),
			approvedAmountCents: 900_000,
			termMonths: 36,
			rateBps: 500,
			reasons: [{ code: "OFFICER_JUDGEMENT", text: "ok" }],
			snapshot: {},
			decidedAt: new Date("2026-02-01T00:00:00Z"),
		});
		const older = await seedDoc(appId, {
			documentDate: "2025-12-01",
			periodEnd: "2025-12-31",
			uploadedAt: new Date("2026-01-16T00:00:00Z"),
		});
		const newer = await seedDoc(appId, {
			kind: "payslip",
			pageCount: 3,
			uploadedAt: new Date("2026-01-17T00:00:00Z"),
		});
		// Deleted rows are not live: same bytes+kind would collide with
		// the `older` row, so they carry a distinct kind.
		await seedDoc(appId, {
			kind: "other",
			status: "deleted",
			uploadedAt: new Date("2026-01-18T00:00:00Z"),
		});

		const res = await serviceGet(`/internal/applications/${appId}/assistant-context`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual(
			[
				"applicationId",
				"decidedAt",
				"decision",
				"documents",
				"policyEvaluation",
				"score",
				"status",
				"submittedAt",
			].sort(),
		);
		expect(body["applicationId"]).toBe(appId);
		expect(body["status"]).toBe("pending_review");
		expect(body["submittedAt"]).toBe("2026-01-15T00:00:00.000Z");
		expect(body["decidedAt"]).toBeNull();

		expect(body["score"]).toEqual({
			score: 800,
			grade: "A",
			modelVersion: "scorecard-v2",
			factors: [{ code: "NEW", points: 2 }],
			affordability: { fresh: true },
		});
		expect(body["policyEvaluation"]).toEqual({
			policyVersion: "policy-v0",
			outcome: "pass",
			reasons: [],
			maxAmountCents: 1_000_000,
			evaluatedAt: "2026-01-25T00:00:00.000Z",
		});
		expect(body["decision"]).toEqual({
			outcome: "approved",
			decidedBy: "officer",
			approvedAmountCents: 900_000,
			termMonths: 36,
			rateBps: 500,
			reasons: [{ code: "OFFICER_JUDGEMENT", text: "ok" }],
			decidedAt: "2026-02-01T00:00:00.000Z",
		});

		const docs = body["documents"] as Array<Record<string, unknown>>;
		expect(docs.map((d) => d["id"]).sort()).toEqual([newer, older].sort());
		// Newest upload first.
		expect(docs.map((d) => d["id"])).toEqual([newer, older]);
		for (const d of docs) {
			expect(Object.keys(d).sort()).toEqual(
				[
					"documentDate",
					"id",
					"kind",
					"ocrStatus",
					"pageCount",
					"periodEnd",
					"status",
					"uploadedAt",
				].sort(),
			);
		}
		expect(docs.find((d) => d["id"] === older)).toMatchObject({
			kind: "bank_statement",
			status: "ready",
			ocrStatus: "ready",
			documentDate: "2025-12-01",
			periodEnd: "2025-12-31",
			uploadedAt: "2026-01-16T00:00:00.000Z",
		});
		// No PII, no document text, no filenames/hashes/storage keys.
		const raw = JSON.stringify(body);
		for (const banned of [
			"Ctx Seed",
			"originalFilename",
			"sha256",
			"storageKey",
			"encryptionNonce",
			"nationalId",
		]) {
			expect(raw).not.toContain(banned);
		}
	});

	it("nulls missing snapshots and caps documents at 50, newest first", async () => {
		const appId = await seedSubmitted();
		for (let i = 0; i < 51; i++) {
			await seedDoc(appId, {
				sha256: `cap-${appId}-${i}`,
				uploadedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
			});
		}
		const res = await serviceGet(`/internal/applications/${appId}/assistant-context`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			score: unknown;
			policyEvaluation: unknown;
			decision: unknown;
			documents: Array<{ uploadedAt: string }>;
		};
		expect(body.score).toBeNull();
		expect(body.policyEvaluation).toBeNull();
		expect(body.decision).toBeNull();
		expect(body.documents).toHaveLength(50);
		const times = body.documents.map((d) => d.uploadedAt);
		expect(times).toEqual([...times].sort().reverse());
		// The single oldest upload falls off the cap.
		expect(times).not.toContain(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString());
	});

	it("404s drafts, unknown ids, and malformed ids; 403s non-service roles", async () => {
		const draftId = await seedSubmitted({ status: "draft", submittedAt: null });
		expect((await serviceGet(`/internal/applications/${draftId}/assistant-context`)).status).toBe(
			404,
		);
		expect(
			(await serviceGet(`/internal/applications/${randomUUID()}/assistant-context`)).status,
		).toBe(404);
		expect((await serviceGet("/internal/applications/not-a-uuid/assistant-context")).status).toBe(
			404,
		);

		const appId = await seedSubmitted();
		const path = `/internal/applications/${appId}/assistant-context`;
		const officer = await createUser(ctx, "officer");
		const asOfficer = await ctx.app.request(path, {
			headers: signed(ctx, officer, "GET", path),
		});
		expect(asOfficer.status).toBe(403);
		const anon = await ctx.app.request(path);
		expect(anon.status).toBe(401);
	});
});

describe("GET /internal/applications/:id/assistant-access", () => {
	async function asOfficer(path: string, user: TestUser) {
		return ctx.app.request(path, { headers: signed(ctx, user, "GET", path) });
	}

	it("allows any officer on an unassigned non-draft case", async () => {
		const appId = await seedSubmitted();
		const officer = await createUser(ctx, "officer");
		const res = await asOfficer(`/internal/applications/${appId}/assistant-access`, officer);
		expect(res.status).toBe(200);
	});

	it("404s another officer's active assignment and a revoked officer", async () => {
		const appId = await seedSubmitted();
		const owner = await createUser(ctx, "officer");
		const other = await createUser(ctx, "officer");
		await ctx.db.insert(caseAccessGrants).values({
			applicationId: appId,
			userId: owner.id,
			accessRole: "assigned_officer",
		});
		const path = `/internal/applications/${appId}/assistant-access`;
		expect((await asOfficer(path, other)).status).toBe(404);
		expect((await asOfficer(path, owner)).status).toBe(200);

		await ctx.db
			.update(caseAccessGrants)
			.set({ revokedAt: new Date() })
			.where(eq(caseAccessGrants.applicationId, appId));
		expect((await asOfficer(path, owner)).status).toBe(404);
	});

	it("404s drafts and unknown ids; 403s service callers", async () => {
		const draftId = await seedSubmitted({ status: "draft", submittedAt: null });
		const officer = await createUser(ctx, "officer");
		expect(
			(await asOfficer(`/internal/applications/${draftId}/assistant-access`, officer)).status,
		).toBe(404);
		expect(
			(await asOfficer(`/internal/applications/${randomUUID()}/assistant-access`, officer)).status,
		).toBe(404);
		const appId = await seedSubmitted();
		const svc = await createUser(ctx, "service");
		expect((await asOfficer(`/internal/applications/${appId}/assistant-access`, svc)).status).toBe(
			403,
		);
	});
});
