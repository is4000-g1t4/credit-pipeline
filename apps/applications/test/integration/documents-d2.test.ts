// D2 crosscheck + chase integration (real Postgres, fake scanner/OCR):
// mismatch citations with page/quote, consecutive-run linkage, 409/403/404
// semantics, draft-chase gating on the original-open audit, no-send, and
// retention redaction through the real D2 seam.
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "@credit/db";
import {
	auditLog,
	chaseRequestFindings,
	chaseRequests,
	documentCrosschecks,
	documentFiles,
	documentFindings,
	documentPages,
} from "@credit/db/applications";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { configFromEnv } from "../../src/documents/service.js";
import { createLogger } from "@credit/service-kit";
import { stubGateway } from "@credit/service-kit/test";
import type { ExtractionResult, OcrAdapter } from "../../src/documents/ocr.js";
import type { ScannerAdapter } from "../../src/documents/scanner.js";
import { loadEnv } from "../../src/env.js";
import {
	createUser,
	grantOfficer,
	individualPayload,
	multipart,
	pdfBytes,
	postApplication,
	setupApp,
	signed,
	type TestContext,
	type TestUser,
} from "../helper.js";

process.env.LOG_LEVEL ??= "silent";

const ENCRYPTION_KEY = randomBytes(32).toString("base64");
const COMPANY = "Cafe Aurora Pte Ltd";
const REG = "201812345K";

const cleanScanner: ScannerAdapter = {
	async scan(_b: Buffer) {
		return "clean";
	},
};

function ocrWith(text: string): OcrAdapter {
	const result: ExtractionResult = {
		status: "ready",
		pages: [{ text, source: "ocr", confidence: 0.95 }],
		textLayerRisk: false,
	};
	return {
		async extractPdf() {
			return structuredClone(result);
		},
		async extractImage() {
			return structuredClone(result);
		},
	};
}

interface Ctx extends TestContext {
	storageDir: string;
}

let ctx: Ctx;

function setup(): Ctx {
	const ctx = setupApp({
		storageDir: (globalThis as { d2Dir?: string }).d2Dir ?? "",
		documents: {
			config: { featureEnabled: true, encryptionKey: ENCRYPTION_KEY, keyId: "v1" },
			scanner: cleanScanner,
			ocr: ocrWith("unused"),
		},
	});
	return { ...ctx, storageDir: "" };
}

function smePayload(email: string): Record<string, unknown> {
	return {
		type: "sme",
		product: "sme_term_loan",
		amountCents: 5000000,
		termMonths: 36,
		purpose: "d2 integration test",
		consents: [true, true, true],
		identity: {
			fullName: "Sme Owner",
			dob: "1985-03-10",
			nationalId: "SMETEST01",
			email,
			phone: "+1-555-0101",
			address: "2 Test Road",
			city: "Demo City",
		},
		sme: {
			companyName: COMPANY,
			registrationNumber: REG,
			industry: "hospitality",
			yearsTrading: 5,
			employees: 12,
			annualRevenueCents: 120000000,
			monthlyFcfCents: 5000000,
			existingDebtServiceCents: 0,
		},
	};
}

async function postApplicationId(user: TestUser, sme: boolean): Promise<string> {
	const res = await postApplication(
		ctx,
		user,
		"/api/applications",
		sme
			? { ...smePayload(user.email), documentProcessingConsent: true }
			: { ...individualPayload(user.email), documentProcessingConsent: true },
	);
	expect(res.status).toBe(201);
	return ((await res.json()) as { id: string }).id;
}

async function newCase(
	sme: boolean,
): Promise<{ appId: string; owner: TestUser; officer: TestUser }> {
	const owner = await createUser(ctx);
	const officer = await createUser(ctx, "officer");
	const appId = await postApplicationId(owner, sme);
	await grantOfficer(ctx.db, appId, officer);
	return { appId, owner, officer };
}

async function seedFile(
	appId: string,
	kind: "business_registration" | "bank_statement" | "id" | "other",
	pages: Array<{ text: string; confidence?: number }>,
	opts: {
		ocrStatus?: "ready" | "low_confidence" | "unsupported" | "failed";
		uploadedBy?: string;
		uploadedAt?: Date;
	} = {},
): Promise<string> {
	const [file] = await ctx.db
		.insert(documentFiles)
		.values({
			applicationId: appId,
			kind,
			status: "ready",
			ocrStatus: opts.ocrStatus ?? "ready",
			textLayerRisk: false,
			mimeType: "application/pdf",
			sizeBytes: 128,
			sha256: randomUUID(),
			storageKey: null,
			encryptionNonce: null,
			encryptionTag: null,
			keyId: "v1",
			cryptoVersion: "aes256gcm-v1",
			pageCount: pages.length,
			ocrConfidence: pages.length > 0 ? 0.95 : null,
			uploadedBy: opts.uploadedBy ?? randomUUID(),
			...(opts.uploadedAt ? { uploadedAt: opts.uploadedAt } : {}),
			retentionUntil: new Date(Date.now() + 86_400_000),
			errorCode: null,
			errorMessage: null,
		})
		.returning();
	if (pages.length > 0) {
		await ctx.db.insert(documentPages).values(
			pages.map((p, i) => ({
				documentFileId: file.id,
				pageNumber: i + 1,
				text: p.text,
				textSource: "pdf_text" as const,
				confidence: p.confidence ?? 1,
				textSha256: "seed",
			})),
		);
	}
	return file.id;
}

async function postCrosscheck(user: TestUser, appId: string): Promise<Response> {
	const path = `/api/applications/${appId}/documents/crosscheck`;
	return ctx.app.request(path, { method: "POST", headers: signed(ctx, user, "POST", path) });
}

async function getCrosscheck(user: TestUser, appId: string): Promise<Response> {
	const path = `/api/applications/${appId}/documents/crosscheck`;
	return ctx.app.request(path, { headers: signed(ctx, user, "GET", path) });
}

beforeAll(async () => {
	(globalThis as { d2Dir?: string }).d2Dir = await mkdtemp(join(tmpdir(), "docs-d2-"));
	ctx = setup();
	ctx.storageDir = (globalThis as { d2Dir?: string }).d2Dir ?? "";
});

afterAll(async () => {
	await ctx.sql.end();
	await rm(ctx.storageDir, { recursive: true, force: true });
});

describe("crosscheck runs", () => {
	it("cites mismatches with page/quote; consecutive runs link their own findings", async () => {
		const HOLDER_SENTINEL = `HOLDER-SENTINEL-${randomUUID().slice(0, 8)}`;
		const COMPANY_SENTINEL = `COMPANY-SENTINEL-${randomUUID().slice(0, 8)}`;
		const { appId, officer } = await newCase(true);
		const regId = await seedFile(appId, "business_registration", [
			{ text: `Company Name: ${COMPANY_SENTINEL} Inc\nRegistration No: 999999999Z` },
		]);
		const bankId = await seedFile(appId, "bank_statement", [
			{ text: `Account Holder: ${HOLDER_SENTINEL}` },
		]);

		const first = await postCrosscheck(officer, appId);
		expect(first.status).toBe(200);
		expect(first.headers.get("cache-control")).toBe("no-store");
		const body1 = (await first.json()) as {
			crosscheck: Record<string, any>;
			findings: Array<Record<string, any>>;
		};
		expect(body1.crosscheck.status).toBe("succeeded");
		expect(body1.crosscheck.validatorVersion).toBe("document-crosscheck-v1");
		expect(body1.crosscheck.findingCount).toBe(3);
		expect(new Set(body1.crosscheck.documentsChecked as string[])).toEqual(
			new Set([regId, bankId]),
		);
		expect(body1.findings).toHaveLength(3);
		for (const finding of body1.findings) {
			expect(finding.crosscheckId).toBe(body1.crosscheck.id);
			expect(finding.applicationId).toBe(appId);
			expect(finding.status).toBe("mismatch");
			expect(finding.pageNumber).toBe(1);
			expect(typeof finding.quote).toBe("string");
			const pageRows = await ctx.db
				.select()
				.from(documentPages)
				.where(
					and(
						eq(documentPages.documentFileId, finding.documentFileId),
						eq(documentPages.pageNumber, 1),
					),
				);
			const pageText = pageRows[0].text as string;
			expect([...pageText].slice(finding.quoteStart, finding.quoteEnd).join("")).toBe(
				finding.quote,
			);
			expect(createHash("sha256").update(finding.quote, "utf8").digest("hex")).toBe(
				finding.quoteHash,
			);
		}
		const companyFinding = body1.findings.find((f) => f.field === "company_name");
		expect(companyFinding?.quote).toBe(`Company Name: ${COMPANY_SENTINEL} Inc`);
		expect(companyFinding?.expected).toBe(COMPANY);
		expect(companyFinding?.confidence).toBe("high");

		const second = await postCrosscheck(officer, appId);
		expect(second.status).toBe(200);
		const body2 = (await second.json()) as typeof body1;
		expect(body2.crosscheck.id).not.toBe(body1.crosscheck.id);
		expect(body2.findings).toHaveLength(3);
		for (const finding of body2.findings) {
			expect(finding.crosscheckId).toBe(body2.crosscheck.id);
		}
		const all = await ctx.db
			.select()
			.from(documentFindings)
			.where(eq(documentFindings.applicationId, appId));
		expect(all).toHaveLength(6);

		const latest = await getCrosscheck(officer, appId);
		expect(latest.status).toBe(200);
		expect(latest.headers.get("cache-control")).toBe("no-store");
		const latestBody = (await latest.json()) as typeof body1;
		expect(latestBody.crosscheck.id).toBe(body2.crosscheck.id);
		expect(latestBody.findings).toHaveLength(3);

		// Audits carry ids/counts only — none of the cited text.
		const audits = await ctx.db.select().from(auditLog).where(eq(auditLog.applicationId, appId));
		const actions = audits.map((row) => row.action);
		expect(actions).toContain("document.crosscheck_started");
		expect(actions).toContain("document.crosscheck_completed");
		for (const row of audits) {
			const payload = JSON.stringify(row.payload);
			for (const sentinel of [HOLDER_SENTINEL, COMPANY_SENTINEL, COMPANY, "999999999Z"]) {
				expect(payload).not.toContain(sentinel);
			}
		}
	});

	it("checks only the latest ready file per kind", async () => {
		const { appId, officer } = await newCase(true);
		await seedFile(appId, "business_registration", [{ text: "Company Name: Stale Corp" }], {
			uploadedAt: new Date(Date.now() - 60_000),
		});
		const freshId = await seedFile(
			appId,
			"business_registration",
			[{ text: `Company Name: ${COMPANY}\nRegistration No: ${REG}` }],
			{ uploadedAt: new Date() },
		);
		const res = await postCrosscheck(officer, appId);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { crosscheck: Record<string, any>; findings: unknown[] };
		expect(body.crosscheck.documentsChecked).toEqual([freshId]);
		expect(body.findings).toEqual([]);
	});

	it("409s with no ready files; unsupported/low-confidence read as needs-chase", async () => {
		const empty = await newCase(false);
		const none = await postCrosscheck(empty.officer, empty.appId);
		expect(none.status).toBe(409);
		expect(((await none.json()) as any).error.code).toBe("DOCUMENTS_NOT_READY");
		expect((await getCrosscheck(empty.officer, empty.appId)).status).toBe(404);

		// Rejected-only (failed upload persists a rejected row) is also 409.
		const boundary = `----d2rej${randomUUID().replace(/-/g, "")}`;
		const garbage = Buffer.concat([Buffer.from("not a document"), randomBytes(32)]);
		const upPath = `/api/applications/${empty.appId}/documents`;
		const up = await ctx.app.request(upPath, {
			method: "POST",
			headers: {
				"content-type": `multipart/form-data; boundary=${boundary}`,
				...signed(
					ctx,
					empty.owner,
					"POST",
					upPath,
					{},
					multipart(boundary, [
						{ name: "kind", data: "other" },
						{ name: "file", filename: "evil.txt", data: garbage },
					]),
				),
			},
			body: multipart(boundary, [
				{ name: "kind", data: "other" },
				{ name: "file", filename: "evil.txt", data: garbage },
			]),
		});
		expect(up.status).toBe(415);
		const stillNone = await postCrosscheck(empty.officer, empty.appId);
		expect(stillNone.status).toBe(409);

		// Unsupported kinds + low confidence → 200 with uncited needs-chase.
		const { appId, officer } = await newCase(false);
		await seedFile(appId, "other", [{ text: "whatever" }]);
		await seedFile(appId, "id", []);
		await seedFile(appId, "bank_statement", [{ text: "Account Holder: X", confidence: 0.4 }], {
			ocrStatus: "low_confidence",
		});
		const res = await postCrosscheck(officer, appId);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { findings: Array<Record<string, any>> };
		expect(body.findings).toHaveLength(3);
		for (const finding of body.findings) {
			expect(finding.status).toBe("needs_chase");
			expect(finding.pageNumber).toBeNull();
			expect(finding.quote).toBeNull();
		}
	});
});

describe("crosscheck access", () => {
	it("applicant 403s; strangers and cross-officers 404; consent gates", async () => {
		const { appId, owner, officer } = await newCase(false);
		const stranger = await createUser(ctx);
		const officer2 = await createUser(ctx, "officer");

		expect((await postCrosscheck(owner, appId)).status).toBe(403);
		expect((await getCrosscheck(owner, appId)).status).toBe(403);
		expect((await postCrosscheck(stranger, appId)).status).toBe(404);
		expect((await postCrosscheck(officer2, appId)).status).toBe(404);
		expect((await getCrosscheck(officer2, appId)).status).toBe(404);
		expect((await postCrosscheck(officer, randomUUID())).status).toBe(404);

		const patchPath = `/api/applications/${appId}/document-consent`;
		const patchBody = JSON.stringify({ consent: false });
		const patch = await ctx.app.request(patchPath, {
			method: "PATCH",
			headers: {
				"content-type": "application/json",
				...signed(ctx, owner, "PATCH", patchPath, {}, patchBody),
			},
			body: patchBody,
		});
		expect(patch.status).toBe(200);
		const gated = await postCrosscheck(officer, appId);
		expect(gated.status).toBe(403);
		expect(((await gated.json()) as any).error.code).toBe("CONSENT_REQUIRED");
	});

	it("feature flag off 404s the crosscheck surface", async () => {
		const env = loadEnv();
		const { db, sql } = createDb(env.databaseUrl);
		try {
			const app = createApp({
				db,
				sql,
				env,
				gateway: stubGateway(),
				logger: createLogger("applications-d2-off"),
				documents: {
					config: {
						...configFromEnv(env),
						featureEnabled: false,
						storageDir: ctx.storageDir,
						encryptionKey: ENCRYPTION_KEY,
						keyId: "v1",
					},
					scanner: cleanScanner,
					ocr: ocrWith("unused"),
				},
			});
			const off = { app, db, sql, gateway: stubGateway(), secret: env.internalSecret };
			const officer = await createUser(off, "officer");
			const path = `/api/applications/${randomUUID()}/documents/crosscheck`;
			expect(
				(await app.request(path, { method: "POST", headers: signed(off, officer, "POST", path) }))
					.status,
			).toBe(404);
		} finally {
			await sql.end();
		}
	});
});

interface ChaseCase {
	appId: string;
	officer: TestUser;
	crosscheckId: string;
	findingIds: string[];
	citedText: string;
	fileId: string;
}

async function chaseCase(): Promise<ChaseCase> {
	const CITED = `CHASE-CITED-${randomUUID().slice(0, 8)}`;
	// The service OCR fake is fixed at setup, so seed pages directly, then
	// upload one real file (fake text is irrelevant) to get a decryptable
	// blob for the original-open audit.
	const { appId, officer } = await newCase(true);
	const seededId = await seedFile(appId, "business_registration", [
		{ text: `Company Name: ${CITED} Ltd\nRegistration No: 999999999Z` },
	]);
	const boundary = `----d2ch${randomUUID().replace(/-/g, "")}`;
	const bytes = pdfBytes("chase-blob");
	const upPath = `/api/applications/${appId}/documents`;
	const body = multipart(boundary, [
		{ name: "kind", data: "other" },
		{ name: "file", filename: "blob.pdf", contentType: "application/octet-stream", data: bytes },
	]);
	const up = await ctx.app.request(upPath, {
		method: "POST",
		headers: {
			"content-type": `multipart/form-data; boundary=${boundary}`,
			...signed(ctx, officer, "POST", upPath, {}, body),
		},
		body,
	});
	expect(up.status).toBe(201);
	const blobId = ((await up.json()) as { file: { id: string } }).file.id;

	const run = await postCrosscheck(officer, appId);
	expect(run.status).toBe(200);
	const runBody = (await run.json()) as {
		crosscheck: { id: string };
		findings: Array<{ id: string; documentFileId: string | null }>;
	};
	const cited = runBody.findings.filter((f) => f.documentFileId === seededId);
	expect(cited.length).toBeGreaterThan(0);
	return {
		appId,
		officer,
		crosscheckId: runBody.crosscheck.id,
		findingIds: cited.map((f) => f.id),
		citedText: CITED,
		fileId: blobId,
	};
}

async function postChase(
	user: TestUser,
	appId: string,
	crosscheckId: string,
	body: unknown,
): Promise<Response> {
	const path = `/api/applications/${appId}/documents/crosscheck/${crosscheckId}/chase`;
	const raw = JSON.stringify(body);
	return ctx.app.request(path, {
		method: "POST",
		headers: { "content-type": "application/json", ...signed(ctx, user, "POST", path, {}, raw) },
		body: raw,
	});
}

describe("draft chase", () => {
	it("409s until the officer opens the original, then drafts with links", async () => {
		const s = await chaseCase();
		const draft = { findingIds: s.findingIds, inspectedOriginal: true };

		const early = await postChase(s.officer, s.appId, s.crosscheckId, draft);
		expect(early.status).toBe(409);
		expect(((await early.json()) as any).error.code).toBe("ORIGINAL_NOT_OPENED");

		// Opening an unrelated blob does not satisfy the cited file.
		const filePath = `/api/applications/${s.appId}/documents/${s.fileId}/file`;
		const down = await ctx.app.request(filePath, {
			headers: signed(ctx, s.officer, "GET", filePath),
		});
		expect(down.status).toBe(200);
		const still = await postChase(s.officer, s.appId, s.crosscheckId, draft);
		expect(still.status).toBe(409);

		// Strict body validation.
		expect(
			(await postChase(s.officer, s.appId, s.crosscheckId, { findingIds: s.findingIds })).status,
		).toBe(400);
		expect(
			(
				await postChase(s.officer, s.appId, s.crosscheckId, {
					findingIds: [],
					inspectedOriginal: true,
				})
			).status,
		).toBe(400);
		expect(
			(
				await postChase(s.officer, s.appId, s.crosscheckId, {
					findingIds: ["nope"],
					inspectedOriginal: true,
				})
			).status,
		).toBe(400);
		expect((await postChase(s.officer, "not-a-uuid", s.crosscheckId, draft)).status).toBe(404);
		expect((await postChase(s.officer, s.appId, "not-a-uuid", draft)).status).toBe(404);
	});

	it("drafts through the real upload/open path with body text and null sent_at", async () => {
		// End-to-end through real routes: upload label text via a scoped app
		// whose OCR fake returns crosscheckable content.
		const CITED = `E2E-CITED-${randomUUID().slice(0, 8)}`;
		const env = loadEnv();
		const { db, sql } = createDb(env.databaseUrl);
		const gateway = stubGateway();
		const app = createApp({
			db,
			sql,
			env,
			gateway,
			logger: createLogger("applications-d2-e2e"),
			documents: {
				config: {
					...configFromEnv(env),
					featureEnabled: true,
					storageDir: ctx.storageDir,
					encryptionKey: ENCRYPTION_KEY,
					keyId: "v1",
				},
				scanner: cleanScanner,
				ocr: ocrWith(`Company Name: ${CITED} Ltd\nRegistration No: 999999999Z`),
			},
		});
		const scoped: Ctx = {
			app,
			db,
			sql,
			gateway,
			secret: env.internalSecret,
			storageDir: ctx.storageDir,
		};
		const prev = ctx;
		ctx = scoped;
		try {
			const owner = await createUser(ctx);
			const officer = await createUser(ctx, "officer");
			const appId = await postApplicationId(owner, true);
			await grantOfficer(ctx.db, appId, officer);

			const boundary = `----d2e2e${randomUUID().replace(/-/g, "")}`;
			const bytes = pdfBytes("e2e-chase");
			const upPath = `/api/applications/${appId}/documents`;
			const upBody = multipart(boundary, [
				{ name: "kind", data: "business_registration" },
				{ name: "file", filename: "reg.pdf", contentType: "application/octet-stream", data: bytes },
			]);
			const up = await ctx.app.request(upPath, {
				method: "POST",
				headers: {
					"content-type": `multipart/form-data; boundary=${boundary}`,
					...signed(ctx, officer, "POST", upPath, {}, upBody),
				},
				body: upBody,
			});
			expect(up.status).toBe(201);
			const fileId = ((await up.json()) as { file: { id: string } }).file.id;

			const run = await postCrosscheck(officer, appId);
			expect(run.status).toBe(200);
			const runBody = (await run.json()) as {
				crosscheck: { id: string };
				findings: Array<{ id: string }>;
			};
			expect(runBody.findings.length).toBeGreaterThan(0);

			// Open the original, then draft.
			const filePath = `/api/applications/${appId}/documents/${fileId}/file`;
			const down = await ctx.app.request(filePath, {
				headers: signed(ctx, officer, "GET", filePath),
			});
			expect(down.status).toBe(200);
			expect(Buffer.from(await down.arrayBuffer()).equals(bytes)).toBe(true);

			const chasePath = `/api/applications/${appId}/documents/crosscheck/${runBody.crosscheck.id}/chase`;
			const chaseRaw = JSON.stringify({
				findingIds: runBody.findings.map((f) => f.id),
				inspectedOriginal: true,
			});
			const chase = await ctx.app.request(chasePath, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...signed(ctx, officer, "POST", chasePath, {}, chaseRaw),
				},
				body: chaseRaw,
			});
			expect(chase.status).toBe(201);
			expect(chase.headers.get("cache-control")).toBe("no-store");
			const chaseBody = (await chase.json()) as {
				chase: Record<string, any>;
				findings: Array<Record<string, any>>;
			};
			expect(chaseBody.chase.status).toBe("draft");
			expect(chaseBody.chase.sentAt).toBeNull();
			expect(chaseBody.chase.body).toContain(CITED);
			expect(chaseBody.chase.body).toContain("999999999Z");
			expect(chaseBody.findings).toHaveLength(runBody.findings.length);

			const [row] = await ctx.db
				.select()
				.from(chaseRequests)
				.where(eq(chaseRequests.id, chaseBody.chase.id as string));
			expect(row.status).toBe("draft");
			expect(row.sentAt).toBeNull();
			expect(row.body).toContain(CITED);
			expect(row.inspectedOriginalAt).not.toBeNull();
			const links = await ctx.db
				.select()
				.from(chaseRequestFindings)
				.where(eq(chaseRequestFindings.chaseRequestId, row.id));
			expect(links).toHaveLength(runBody.findings.length);

			// No send path: draft only, applicant locked out.
			const owner2 = owner;
			expect(
				(
					await ctx.app.request(chasePath, {
						method: "POST",
						headers: signed(ctx, owner2, "POST", chasePath),
					})
				).status,
			).toBe(403);

			// Audit carries ids only — never the draft body text.
			const audits = await ctx.db.select().from(auditLog).where(eq(auditLog.applicationId, appId));
			expect(audits.map((r) => r.action)).toContain("document.chase_drafted");
			for (const rowA of audits) {
				expect(JSON.stringify(rowA.payload)).not.toContain(CITED);
			}

			// Cross-app finding ids 404 (cite this finding from another case).
			const other = await createUser(ctx);
			const otherApp = await postApplicationId(other, true);
			const otherOfficer = await createUser(ctx, "officer");
			await grantOfficer(ctx.db, otherApp, otherOfficer);
			await seedFile(otherApp, "other", [{ text: "x" }]);
			const otherRun = await postCrosscheck(otherOfficer, otherApp);
			const otherBody = (await otherRun.json()) as { crosscheck: { id: string } };
			const crossPath = `/api/applications/${otherApp}/documents/crosscheck/${otherBody.crosscheck.id}/chase`;
			const crossRaw = JSON.stringify({
				findingIds: runBody.findings.map((f) => f.id),
				inspectedOriginal: true,
			});
			const cross = await ctx.app.request(crossPath, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...signed(ctx, otherOfficer, "POST", crossPath, {}, crossRaw),
				},
				body: crossRaw,
			});
			expect(cross.status).toBe(404);
			// Cross-app crosscheck id 404s too.
			const wrongPath = `/api/applications/${otherApp}/documents/crosscheck/${runBody.crosscheck.id}/chase`;
			const wrong = await ctx.app.request(wrongPath, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...signed(ctx, otherOfficer, "POST", wrongPath, {}, crossRaw),
				},
				body: crossRaw,
			});
			expect(wrong.status).toBe(404);
		} finally {
			ctx = prev;
			await sql.end();
		}
	});
});

describe("retention through the D2 seam", () => {
	it("redacts real crosscheck findings and chase drafts without content in audit", async () => {
		const BODY_SENTINEL = `CHASE-BODY-${randomUUID().slice(0, 8)}`;
		const { appId, officer } = await newCase(true);
		const fileId = await seedFile(appId, "business_registration", [
			{ text: `Company Name: ${BODY_SENTINEL} Ltd\nRegistration No: 999999999Z` },
		]);
		const run = await postCrosscheck(officer, appId);
		expect(run.status).toBe(200);
		const runBody = (await run.json()) as {
			crosscheck: { id: string };
			findings: Array<{ id: string }>;
		};
		expect(runBody.findings.length).toBeGreaterThan(0);

		// Draft links need the open audit; record one directly — the gate
		// reads server-side audit rows, and this seeds exactly that shape.
		await ctx.db.insert(auditLog).values({
			applicationId: appId,
			actor: officer.id,
			action: "document.original_opened",
			entity: "document_file",
			payload: { documentFileId: fileId, sizeBytes: 1 },
		});
		const chasePath = `/api/applications/${appId}/documents/crosscheck/${runBody.crosscheck.id}/chase`;
		const chaseRaw = JSON.stringify({
			findingIds: runBody.findings.map((f) => f.id),
			inspectedOriginal: true,
		});
		const chase = await ctx.app.request(chasePath, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...signed(ctx, officer, "POST", chasePath, {}, chaseRaw),
			},
			body: chaseRaw,
		});
		expect(chase.status).toBe(201);

		await ctx.db
			.update(documentFiles)
			.set({ retentionUntil: new Date(Date.now() - 1000) })
			.where(eq(documentFiles.id, fileId));

		const svc = await createUser(ctx, "service");
		const runPath = `/internal/applications/${appId}/documents/retention/run`;
		const swept = await ctx.app.request(runPath, {
			method: "POST",
			headers: signed(ctx, svc, "POST", runPath),
		});
		expect(swept.status).toBe(200);
		expect(((await swept.json()) as Record<string, number>).deletedFiles).toBe(1);

		const [cross] = await ctx.db
			.select()
			.from(documentCrosschecks)
			.where(eq(documentCrosschecks.id, runBody.crosscheck.id));
		expect(cross.status).toBe("redacted");
		expect(cross.findingCount).toBe(0);
		expect(
			await ctx.db.select().from(documentFindings).where(eq(documentFindings.applicationId, appId)),
		).toEqual([]);
		const [draft] = await ctx.db
			.select()
			.from(chaseRequests)
			.where(eq(chaseRequests.applicationId, appId));
		expect(draft.body).toBeNull();
		expect(draft.redactedAt).not.toBeNull();
		const audits = await ctx.db.select().from(auditLog).where(eq(auditLog.applicationId, appId));
		for (const row of audits) {
			expect(JSON.stringify(row.payload)).not.toContain(BODY_SENTINEL);
		}
	});
});
