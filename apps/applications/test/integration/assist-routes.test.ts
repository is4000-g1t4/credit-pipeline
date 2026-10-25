// EN-01/02/03 route integration (real Postgres, fake research upstream):
// evidence assembly + case access, deterministic memo draft, artifact
// versioning/approval/tombstone, validation fail-closed, retention/holds, and
// audit metadata.
import { randomUUID } from "node:crypto";
import { createDb } from "@credit/db";
import {
	applications,
	auditLog,
	caseAccessGrants,
	documentCrosschecks,
	documentFiles,
	documentFindings,
	documentLegalHolds,
	documentPages,
	generatedArtifacts,
	policyEvaluations,
	scores,
} from "@credit/db/applications";
import { createLogger } from "@credit/service-kit";
import { stubGateway } from "@credit/service-kit/test";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { loadEnv } from "../../src/env.js";
import { createUser, signed, type TestContext, type TestUser } from "../helper.js";

process.env.LOG_LEVEL ??= "silent";

const AS_OF = new Date("2026-06-30T00:00:00Z");
const NOW = new Date("2026-07-01T00:00:00Z");
const policyVersionId = randomUUID();
const externalEvidenceId = randomUUID();
const policyQuote = "DSCR must be at least 1.25x for SME term loans.";

let ctx: TestContext;
let officer: TestUser;
let otherOfficer: TestUser;
let revokedOfficer: TestUser;
let applicant: TestUser;
let service: TestUser;

let appId: string;
let otherAppId: string;
let documentFileId: string;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function researchPayload(): Record<string, unknown> {
	const evidence = {
		id: externalEvidenceId,
		url: "https://example.com/report",
		finalUrl: "https://example.com/report",
		title: "Restructuring report",
		publisher: "Example News",
		publishedAt: "2026-03-01",
		dateBasis: "published",
		retrievedAt: AS_OF.toISOString(),
		quote: "Cafe Aurora was named in a 2025 restructuring report.",
		quoteStart: 0,
		quoteEnd: 54,
		snapshotText: "Cafe Aurora was named in a 2025 restructuring report.",
		snapshotHash: "snap-hash",
		rawContentSha256: null,
		sourceTier: "reputable_news",
	};
	return {
		run: { id: randomUUID() },
		brief: null,
		validation: null,
		usage: null,
		evidence: [evidence],
		findings: [
			{
				id: randomUUID(),
				claim: "A restructuring report names the borrower.",
				category: "adverse_media",
				whyItMatters: "Officer review",
				allegationStatus: "alleged",
				support: "single_source",
				confidence: "medium",
				confidenceBasis: {},
				entityMatch: {},
				evidenceIds: [externalEvidenceId],
				evidence: [evidence],
				reviewStatus: "pending",
				reviewedAt: null,
			},
		],
		context: {
			status: "succeeded",
			stageVersion: 1,
			errorCode: null,
			model: "test-model",
			brief: {},
			validation: {},
			usage: {},
			startedAt: null,
			finishedAt: null,
			signals: [
				{
					id: randomUUID(),
					stageVersion: 1,
					accountScope: "aggregate",
					type: "negative_balance",
					periodStart: "2026-01-01",
					periodEnd: "2026-06-30",
					metric: "negative_eod_days",
					observed: 2,
					expected: 0,
					confidence: "high",
					status: "review",
					policyVersion: "context-metrics-v1",
					explanation: null,
					evidence: [],
					reviewStatus: "pending",
					reviewedAt: null,
				},
			],
		},
		policy: {
			status: "succeeded",
			errorCode: null,
			model: "test-model",
			promptVersion: "policy-prompt-v1",
			brief: {
				status: "succeeded",
				items: [
					{
						ref: "signal:negative_balance:negative_eod_days:2026-01-01:2026-06-30:aggregate",
						explanationSegments: [{ text: "Policy applies.", citationIndexes: [0] }],
						citations: [
							{
								policyKey: "POL-CR-002",
								policyVersionId,
								sectionId: "4.2",
								heading: "Affordability",
								version: "v1",
								effectiveFrom: "2026-01-01",
								effectiveTo: null,
								quote: policyQuote,
								drawerToken: "token",
							},
						],
						confidence: "high",
					},
				],
				limitations: [],
			},
			validation: {},
			usage: {},
			startedAt: null,
			finishedAt: null,
		},
		viewedAt: null,
	};
}

async function seedApp(over: Partial<typeof applications.$inferSelect> = {}): Promise<string> {
	const [row] = await ctx.db
		.insert(applications)
		.values({
			reference: `AST-${randomUUID().slice(0, 8)}`,
			applicantUserId: applicant.id,
			type: "sme",
			product: "sme_term_loan",
			status: "pending_review",
			amountCents: 6_000_000,
			termMonths: 60,
			purpose: "Cafe expansion",
			identity: {
				fullName: "Tomas Aurora",
				dob: "1985-03-20",
				nationalId: "TOMAS42X1",
				email: applicant.email,
				phone: "+1-555-0200",
				address: "2 Cafe Street",
				city: "Singapore",
			},
			business: {
				companyName: "Cafe Aurora",
				registrationNumber: "CAFEAUR1",
				industry: "hospitality",
				yearsTrading: 4,
				employees: 9,
				annualRevenueCents: 61_000_000,
				monthlyFcfCents: 380_000,
				existingDebtServiceCents: 30_000,
			},
			financial: null,
			consents: [true, true, true],
			contextAnalysisConsent: true,
			documentProcessingConsent: true,
			submittedAt: AS_OF,
			...over,
		})
		.returning({ id: applications.id });
	return row.id;
}

async function seedEvidenceRows(applicationId: string): Promise<void> {
	const [score] = await ctx.db
		.insert(scores)
		.values({
			applicationId,
			modelVersion: "scorecard-v1",
			score: 640,
			grade: "C",
			factors: [
				{ code: "SECTOR_RISK", label: "Sector risk", points: -40, impact: "negative" },
				{ code: "REVENUE_SCALE", label: "Revenue scale", points: 75, impact: "positive" },
			],
			affordability: {},
		})
		.returning({ id: scores.id });
	await ctx.db.insert(policyEvaluations).values({
		applicationId,
		policyVersion: "policy-v1.0",
		outcome: "refer",
		reasons: [
			{ code: "AMOUNT_ABOVE_AUTO_LIMIT", text: "Amount above the automatic-approval limit." },
			{ code: "SECTOR_REVIEW", text: "Sector carries elevated risk." },
		],
		maxAmountCents: 6_000_000,
		inputs: {},
		inputHash: "hash",
	});

	const [file] = await ctx.db
		.insert(documentFiles)
		.values({
			applicationId,
			kind: "bank_statement",
			status: "ready",
			ocrStatus: "ready",
			originalFilename: "statement.pdf",
			mimeType: "application/pdf",
			sizeBytes: 100,
			sha256: "a".repeat(64),
			storageKey: null,
			keyId: "v1",
			cryptoVersion: "v1",
			pageCount: 1,
			uploadedBy: applicant.id,
			retentionUntil: new Date("2027-01-01T00:00:00Z"),
		})
		.returning({ id: documentFiles.id });
	documentFileId = file.id;
	await ctx.db.insert(documentPages).values({
		documentFileId,
		pageNumber: 1,
		text: "Cafe Aurora Pte Ltd statement",
		textSource: "pdf_text",
		confidence: 0.99,
		textSha256: "b".repeat(64),
	});
	const [crosscheck] = await ctx.db
		.insert(documentCrosschecks)
		.values({
			applicationId,
			status: "succeeded",
			validatorVersion: "v1",
			documentsChecked: { files: 1 },
			findingCount: 1,
			requestedBy: officer.id,
			finishedAt: AS_OF,
		})
		.returning({ id: documentCrosschecks.id });
	await ctx.db.insert(documentFindings).values({
		crosscheckId: crosscheck.id,
		applicationId,
		documentFileId,
		field: "company_name",
		expected: "Cafe Aurora",
		observed: "Cafe Aurora Pte Ltd",
		pageNumber: 1,
		quote: "Cafe Aurora Pte Ltd",
		quoteStart: 0,
		quoteEnd: 18,
		quoteHash: "c".repeat(64),
		confidence: "high",
		status: "mismatch",
		reason: "registered name differs",
	});
	void score;
}

async function call(
	method: string,
	path: string,
	user: TestUser,
	body?: unknown,
): Promise<Response> {
	const raw = body === undefined ? undefined : JSON.stringify(body);
	const bare = path.split("?")[0] as string;
	return ctx.app.request(path, {
		method,
		headers: {
			...signed(ctx, user, method, bare, { "content-type": "application/json" }, raw),
		},
		body: raw,
	});
}

beforeAll(async () => {
	const env = loadEnv();
	const { db, sql } = createDb(env.databaseUrl);
	ctx = {
		app: createApp({
			db,
			sql,
			env,
			gateway: stubGateway(),
			logger: createLogger("assist-routes-test"),
			documents: { config: { featureEnabled: true } },
			assist: {
				config: {
					enabled: true,
					retentionDays: 90,
					researchUrl: "http://research.test",
					researchTimeoutMs: 2_000,
				},
				now: () => NOW,
				researchFetchImpl: (async () => jsonResponse(researchPayload())) as typeof fetch,
			},
		}),
		db,
		sql,
		gateway: stubGateway(),
		secret: env.internalSecret,
	};
	officer = await createUser(ctx, "officer");
	otherOfficer = await createUser(ctx, "officer");
	revokedOfficer = await createUser(ctx, "officer");
	applicant = await createUser(ctx, "applicant");
	service = await createUser(ctx, "service");

	appId = await seedApp();
	otherAppId = await seedApp({ reference: `AST-OTHER-${randomUUID().slice(0, 8)}` });
	await seedEvidenceRows(appId);
	await ctx.db.insert(caseAccessGrants).values({
		applicationId: appId,
		userId: officer.id,
		accessRole: "assigned_officer",
		grantedBy: service.id,
	});
	await ctx.db.insert(caseAccessGrants).values({
		applicationId: otherAppId,
		userId: revokedOfficer.id,
		accessRole: "assigned_officer",
		grantedBy: service.id,
		revokedAt: new Date("2026-06-01T00:00:00Z"),
	});
});

afterAll(async () => {
	// Accumulating rows is harmless in dev (other suites do the same). Close
	// the pool so the worker exits.
	await ctx.sql.end();
});

describe("EN-01 evidence bundle route", () => {
	it("returns all contract source types for the assigned officer", async () => {
		const res = await call("GET", `/api/assist/cases/${appId}/evidence`, officer);
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		const body = (await res.json()) as {
			bundle: { items: Array<{ sourceType: string; ref: string }>; unavailable: unknown[] };
			assignedToMe: boolean;
		};
		expect(body.assignedToMe).toBe(true);
		const types = new Set(body.bundle.items.map((item) => item.sourceType));
		for (const type of [
			"document",
			"context_signal",
			"external_evidence",
			"policy_section",
			"score_reason",
			"case_fact",
		]) {
			expect(types.has(type)).toBe(true);
		}
		const firstRefs = body.bundle.items.map((item) => item.ref);
		const again = await call("GET", `/api/assist/cases/${appId}/evidence`, officer);
		const secondRefs = ((await again.json()) as typeof body).bundle.items.map((item) => item.ref);
		expect(secondRefs).toEqual(firstRefs);
	});

	it("denies applicants 403 and another officer's assigned case 404", async () => {
		const applicantRes = await call("GET", `/api/assist/cases/${appId}/evidence`, applicant);
		expect(applicantRes.status).toBe(403);
		const otherRes = await call("GET", `/api/assist/cases/${appId}/evidence`, otherOfficer);
		expect(otherRes.status).toBe(404);
		const otherAppRes = await call("GET", `/api/assist/cases/${otherAppId}/evidence`, otherOfficer);
		expect(otherAppRes.status).toBe(200);
		const revokedRes = await call(
			"GET",
			`/api/assist/cases/${otherAppId}/evidence`,
			revokedOfficer,
		);
		expect(revokedRes.status).toBe(404);
	});

	it("returns 404 for every assist route when the flag is off", async () => {
		const env = loadEnv();
		const { db, sql } = createDb(env.databaseUrl);
		const off = createApp({
			db,
			sql,
			env,
			gateway: stubGateway(),
			logger: createLogger("assist-off-test"),
			assist: { config: { enabled: false } },
		});
		const fakeArtifact = randomUUID();
		const routes: Array<{ method: string; path: string }> = [
			{ method: "GET", path: `/api/assist/cases/${appId}/evidence` },
			{ method: "GET", path: `/api/assist/cases/${appId}/artifacts` },
			{ method: "POST", path: `/api/assist/cases/${appId}/memos` },
			{ method: "POST", path: `/api/assist/cases/${appId}/artifacts` },
			{ method: "GET", path: `/api/assist/artifacts/${fakeArtifact}` },
			{ method: "PATCH", path: `/api/assist/artifacts/${fakeArtifact}` },
			{ method: "POST", path: `/api/assist/artifacts/${fakeArtifact}/approve` },
			{ method: "POST", path: `/api/assist/artifacts/${fakeArtifact}/tombstone` },
		];
		for (const route of routes) {
			const res = await off.request(route.path, {
				method: route.method,
				headers: signed({ ...ctx, app: off }, officer, route.method, route.path),
			});
			expect(res.status, `${route.method} ${route.path}`).toBe(404);
		}
		const applicantOff = await off.request(`/api/assist/cases/${appId}/evidence`, {
			headers: signed(
				{ ...ctx, app: off },
				applicant,
				"GET",
				`/api/assist/cases/${appId}/evidence`,
			),
		});
		expect(applicantOff.status).toBe(403);
		// The gate is scoped: unrelated applications routes still work.
		const existing = await off.request("/api/applications", {
			headers: signed({ ...ctx, app: off }, applicant, "GET", "/api/applications"),
		});
		expect(existing.status).toBe(200);
		await sql.end();
	});
});

describe("EN-02/03 artifact routes", () => {
	let memoId = "";
	let memoRevision = 1;

	it("drafts a validated memo end-to-end", async () => {
		const res = await call("POST", `/api/assist/cases/${appId}/memos`, officer);
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			artifact: {
				id: string;
				status: string;
				version: number;
				revision: number;
				citations: unknown[];
			};
		};
		expect(body.artifact.status).toBe("draft");
		expect(body.artifact.version).toBe(1);
		expect(body.artifact.citations.length).toBeGreaterThan(0);
		memoId = body.artifact.id;
		memoRevision = body.artifact.revision;
	});

	it("edits a draft with optimistic concurrency", async () => {
		const artifact = await ctx.db
			.select()
			.from(generatedArtifacts)
			.where(eq(generatedArtifacts.id, memoId));
		const content = artifact[0]?.content as Record<string, unknown>;
		const stale = await call("PATCH", `/api/assist/artifacts/${memoId}`, officer, {
			expectedRevision: memoRevision + 9,
			content,
		});
		expect(stale.status).toBe(409);
		const edit = await call("PATCH", `/api/assist/artifacts/${memoId}`, officer, {
			expectedRevision: memoRevision,
			content,
		});
		expect(edit.status).toBe(200);
		const body = (await edit.json()) as { artifact: { revision: number; version: number } };
		expect(body.artifact.revision).toBe(memoRevision + 1);
		expect(body.artifact.version).toBe(1);
		memoRevision = body.artifact.revision;
	});

	it("approves, then a further edit creates v2 and supersedes v1", async () => {
		const approve = await call("POST", `/api/assist/artifacts/${memoId}/approve`, officer, {
			expectedRevision: memoRevision,
			confirm: true,
		});
		expect(approve.status).toBe(200);
		const approved = (await approve.json()) as { artifact: { status: string; version: number } };
		expect(approved.artifact.status).toBe("approved");

		const artifact = await ctx.db
			.select()
			.from(generatedArtifacts)
			.where(eq(generatedArtifacts.id, memoId));
		const edit = await call("PATCH", `/api/assist/artifacts/${memoId}`, officer, {
			expectedRevision: memoRevision,
			content: artifact[0]?.content,
		});
		expect(edit.status).toBe(200);
		const v2 = (await edit.json()) as {
			artifact: { id: string; status: string; version: number; revision: number };
			createdVersion: boolean;
		};
		expect(v2.createdVersion).toBe(true);
		expect(v2.artifact.status).toBe("draft");
		expect(v2.artifact.version).toBe(2);

		const approveV2 = await call(
			"POST",
			`/api/assist/artifacts/${v2.artifact.id}/approve`,
			officer,
			{
				expectedRevision: v2.artifact.revision,
				confirm: true,
			},
		);
		expect(approveV2.status).toBe(200);
		const rows = await ctx.db
			.select()
			.from(generatedArtifacts)
			.where(
				and(
					eq(generatedArtifacts.applicationId, appId),
					eq(generatedArtifacts.type, "credit_memo"),
				),
			);
		const byVersion = new Map(rows.map((row) => [row.version, row.status]));
		expect(byVersion.get(1)).toBe("superseded");
		expect(byVersion.get(2)).toBe("approved");

		const tombstone = await call(
			"POST",
			`/api/assist/artifacts/${v2.artifact.id}/tombstone`,
			officer,
			{
				expectedRevision: v2.artifact.revision,
				reason: "officer discarded",
			},
		);
		expect(tombstone.status).toBe(200);
		const after = await ctx.db
			.select()
			.from(generatedArtifacts)
			.where(eq(generatedArtifacts.id, v2.artifact.id));
		expect(after[0]?.status).toBe("deleted");
	});

	it("fails closed on invalid generated text and persists nothing", async () => {
		const before = await ctx.db
			.select()
			.from(generatedArtifacts)
			.where(eq(generatedArtifacts.applicationId, appId));
		const res = await call("POST", `/api/assist/cases/${appId}/artifacts`, officer, {
			type: "credit_memo",
			content: {
				title: "The application is approved.",
				sections: [],
				openItems: [],
				officerQuestions: [],
			},
		});
		expect(res.status).toBe(422);
		const body = (await res.json()) as {
			error: { code: string; issues: Array<{ code: string }> };
		};
		expect(body.error.code).toBe("GENERATED_TEXT_INVALID");
		expect(body.error.issues.length).toBeGreaterThan(0);
		const after = await ctx.db
			.select()
			.from(generatedArtifacts)
			.where(eq(generatedArtifacts.applicationId, appId));
		expect(after).toHaveLength(before.length);
	});

	it("blocks retention while a legal hold is active, then tombstones", async () => {
		const memoRow = await ctx.db
			.select()
			.from(generatedArtifacts)
			.where(eq(generatedArtifacts.id, memoId));
		const created = await call("POST", `/api/assist/cases/${appId}/artifacts`, officer, {
			type: "credit_memo",
			content: memoRow[0]?.content,
		});
		expect(created.status).toBe(201);
		const artifactRow = ((await created.json()) as { artifact: { id: string; revision: number } })
			.artifact;
		const artifactId = artifactRow.id;
		await ctx.db
			.update(generatedArtifacts)
			.set({ retentionUntil: new Date("2026-01-01T00:00:00Z") })
			.where(eq(generatedArtifacts.id, artifactId));
		const hold = await call("POST", `/internal/assist/artifacts/${artifactId}/holds`, service, {
			reason: "litigation",
		});
		expect(hold.status).toBe(201);
		const holdId = ((await hold.json()) as { holdId: string }).holdId;

		const tombstoneBlocked = await call(
			"POST",
			`/api/assist/artifacts/${artifactId}/tombstone`,
			officer,
			{ expectedRevision: artifactRow.revision, reason: "officer cleanup" },
		);
		expect(tombstoneBlocked.status).toBe(409);
		expect(((await tombstoneBlocked.json()) as { error: { code: string } }).error.code).toBe(
			"LEGAL_HOLD",
		);

		const blocked = await call("POST", "/internal/assist/retention/run", service, {});
		expect(blocked.status).toBe(200);
		const blockedBody = (await blocked.json()) as { skippedHolds: number };
		expect(blockedBody.skippedHolds).toBeGreaterThanOrEqual(1);
		const afterBlocked = await ctx.db
			.select()
			.from(generatedArtifacts)
			.where(eq(generatedArtifacts.id, artifactId));
		expect(afterBlocked[0]?.status).toBe("draft");
		expect(afterBlocked[0]?.content).not.toEqual({});

		const release = await call(
			"POST",
			`/internal/assist/artifacts/${artifactId}/holds/${holdId}/release`,
			service,
			{},
		);
		expect(release.status).toBe(200);

		// A file-level document hold on a cited document also protects the memo.
		const [fileHold] = await ctx.db
			.insert(documentLegalHolds)
			.values({
				applicationId: appId,
				documentFileId,
				reason: "document litigation",
				createdBy: service.id,
			})
			.returning({ id: documentLegalHolds.id });
		const fileHeld = await call("POST", "/internal/assist/retention/run", service, {});
		expect(
			((await fileHeld.json()) as { skippedHolds: number }).skippedHolds,
		).toBeGreaterThanOrEqual(1);
		await ctx.db
			.update(documentLegalHolds)
			.set({ releasedAt: new Date("2026-07-02T12:00:00Z") })
			.where(eq(documentLegalHolds.id, fileHold.id));

		// A case-wide document hold also protects generated artifacts.
		const [caseHold] = await ctx.db
			.insert(documentLegalHolds)
			.values({
				applicationId: appId,
				documentFileId: null,
				reason: "case litigation",
				createdBy: service.id,
			})
			.returning({ id: documentLegalHolds.id });
		const stillHeld = await call("POST", "/internal/assist/retention/run", service, {});
		const stillHeldBody = (await stillHeld.json()) as { skippedHolds: number };
		expect(stillHeldBody.skippedHolds).toBeGreaterThanOrEqual(1);
		await ctx.db
			.update(documentLegalHolds)
			.set({ releasedAt: new Date("2026-07-03T00:00:00Z") })
			.where(eq(documentLegalHolds.id, caseHold.id));

		const swept = await call("POST", "/internal/assist/retention/run", service, {});
		const sweptBody = (await swept.json()) as { deleted: number };
		expect(sweptBody.deleted).toBeGreaterThanOrEqual(1);
		const row = await ctx.db
			.select()
			.from(generatedArtifacts)
			.where(eq(generatedArtifacts.id, artifactId));
		expect(row[0]?.status).toBe("deleted");
		expect(row[0]?.content).toEqual({});
		expect(row[0]?.citations).toEqual([]);
		const lateHold = await call("POST", `/internal/assist/artifacts/${artifactId}/holds`, service, {
			reason: "late hold",
		});
		expect(lateHold.status).toBe(409);
		expect(((await lateHold.json()) as { error: { code: string } }).error.code).toBe(
			"ARTIFACT_DELETED",
		);
	});

	it("rejects officer/applicant callers on service-only hold routes", async () => {
		for (const user of [officer, applicant]) {
			const res = await call("POST", `/internal/assist/artifacts/${memoId}/holds`, user, {
				reason: "not allowed",
			});
			expect(res.status).toBe(403);
		}
	});

	it("hides document-citing artifacts from unassigned officers", async () => {
		await ctx.db
			.update(caseAccessGrants)
			.set({ revokedAt: new Date("2026-07-02T00:00:00Z") })
			.where(
				and(eq(caseAccessGrants.applicationId, appId), eq(caseAccessGrants.userId, officer.id)),
			);
		const otherGet = await call("GET", `/api/assist/artifacts/${memoId}`, otherOfficer);
		expect(otherGet.status).toBe(404);
		const list = await call("GET", `/api/assist/cases/${appId}/artifacts`, otherOfficer);
		expect(list.status).toBe(200);
		const items = ((await list.json()) as { items: Array<{ id: string }> }).items;
		expect(items.some((item) => item.id === memoId)).toBe(false);
		const patch = await call("PATCH", `/api/assist/artifacts/${memoId}`, otherOfficer, {
			expectedRevision: 1,
			content: {},
		});
		expect(patch.status).toBe(404);
		const approve = await call("POST", `/api/assist/artifacts/${memoId}/approve`, otherOfficer, {
			expectedRevision: 1,
			confirm: true,
		});
		expect(approve.status).toBe(404);
		const tombstone = await call(
			"POST",
			`/api/assist/artifacts/${memoId}/tombstone`,
			otherOfficer,
			{
				expectedRevision: 1,
				reason: "test",
			},
		);
		expect(tombstone.status).toBe(404);
	});

	it("writes audit rows without content text", async () => {
		const rows = await ctx.db.select().from(auditLog).where(eq(auditLog.applicationId, appId));
		const actions = new Set(rows.map((row) => row.action));
		for (const action of [
			"artifact.created",
			"artifact.edited",
			"artifact.version_created",
			"artifact.approved",
			"artifact.tombstoned",
		]) {
			expect(actions.has(action)).toBe(true);
		}
		for (const row of rows.filter((r) => r.action.startsWith("artifact."))) {
			expect(JSON.stringify(row.payload)).not.toContain("Cafe Aurora");
		}
		const created = rows.find((row) => row.action === "artifact.created");
		expect(created?.payload).toMatchObject({ feature: "assist", actorRole: "officer" });
		const target = rows.find((row) => row.action === "artifact.created");
		expect(target).toBeDefined();
		await expect(
			ctx.db
				.update(auditLog)
				.set({ action: "tampered" })
				.where(eq(auditLog.id, target?.id ?? "")),
		).rejects.toThrow();
		await expect(
			ctx.db.delete(generatedArtifacts).where(eq(generatedArtifacts.id, memoId)),
		).rejects.toThrow();
		await expect(
			ctx.db
				.update(generatedArtifacts)
				.set({ approvedBy: randomUUID() })
				.where(eq(generatedArtifacts.id, memoId)),
		).rejects.toThrow();
		await expect(
			ctx.db
				.update(generatedArtifacts)
				.set({ status: "draft" })
				.where(eq(generatedArtifacts.id, memoId)),
		).rejects.toThrow();
	});
});
