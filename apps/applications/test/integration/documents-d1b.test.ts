// D1b assignment + retention integration (real Postgres, fake
// scanner/OCR, temp blob storage): claim idempotent/conflict/404s,
// revoked-cannot-reclaim, service grant/revoke, retention tombstones +
// blob purge + retry marker, legal-hold block/release, audit hygiene.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	auditLog,
	caseAccessGrants,
	chaseRequestFindings,
	chaseRequests,
	documentCrosschecks,
	documentFiles,
	documentFindings,
	documentPages,
} from "@credit/db/applications";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDocumentRetention } from "../../src/documents/retention.js";
import { configFromEnv } from "../../src/documents/service.js";
import type { ExtractionResult, OcrAdapter, OcrLimits } from "../../src/documents/ocr.js";
import type { ScannerAdapter } from "../../src/documents/scanner.js";
import { loadEnv } from "../../src/env.js";
import {
	createUser,
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

const OCR_TEXT = "SENSITIVE-TEXT-67890";
const ENCRYPTION_KEY = randomBytes(32).toString("base64");

const cleanScanner: ScannerAdapter = {
	async scan(_b: Buffer) {
		return "clean";
	},
};
const READY: ExtractionResult = {
	status: "ready",
	pages: [{ text: OCR_TEXT, source: "ocr", confidence: 0.95 }],
	textLayerRisk: false,
};
const readyOcr: OcrAdapter = {
	async extractPdf(_b: Buffer, _l: OcrLimits) {
		return structuredClone(READY);
	},
	async extractImage(_b: Buffer, _t: "png" | "jpeg", _l: OcrLimits) {
		return structuredClone(READY);
	},
};

interface Ctx extends TestContext {
	storageDir: string;
}

let ctx: Ctx;

function setup(): Ctx {
	const ctx = setupApp({
		storageDir: (globalThis as { d1bDir?: string }).d1bDir ?? "",
		documents: {
			config: { featureEnabled: true, encryptionKey: ENCRYPTION_KEY, keyId: "v1" },
			scanner: cleanScanner,
			ocr: readyOcr,
		},
	});
	return { ...ctx, storageDir: "" };
}

async function postApplicationId(user: TestUser): Promise<string> {
	const res = await postApplication(ctx, user, "/api/applications", {
		...individualPayload(user.email),
		documentProcessingConsent: true,
	});
	expect(res.status).toBe(201);
	return ((await res.json()) as { id: string }).id;
}

async function upload(
	user: TestUser,
	appId: string,
	kind: string,
	bytes: Buffer,
	filename: string,
): Promise<{ status: number; file: Record<string, any> }> {
	const boundary = `----d1b${randomUUID().replace(/-/g, "")}`;
	const body = multipart(boundary, [
		{ name: "kind", data: kind },
		{ name: "file", filename, contentType: "application/octet-stream", data: bytes },
	]);
	const path = `/api/applications/${appId}/documents`;
	const res = await ctx.app.request(path, {
		method: "POST",
		headers: {
			"content-type": `multipart/form-data; boundary=${boundary}`,
			...signed(ctx, user, "POST", path, {}, body),
		},
		body,
	});
	return { status: res.status, file: ((await res.json()) as any).file };
}

async function claim(user: TestUser, appId: string): Promise<Response> {
	const path = `/api/applications/${appId}/documents/claim`;
	return ctx.app.request(path, { method: "POST", headers: signed(ctx, user, "POST", path) });
}

function servicePost(path: string, body?: unknown): Promise<Response> {
	return (async () => {
		const svc = await createUser(ctx, "service");
		const raw = body === undefined ? undefined : JSON.stringify(body);
		return ctx.app.request(path, {
			method: "POST",
			headers: {
				...(raw === undefined ? {} : { "content-type": "application/json" }),
				...signed(ctx, svc, "POST", path, {}, raw as any),
			},
			body: raw as any,
		});
	})();
}

async function activeGrants(appId: string) {
	return ctx.db
		.select()
		.from(caseAccessGrants)
		.where(and(eq(caseAccessGrants.applicationId, appId), isNull(caseAccessGrants.revokedAt)));
}

beforeAll(async () => {
	(globalThis as { d1bDir?: string }).d1bDir = await mkdtemp(join(tmpdir(), "docs-d1b-"));
	ctx = setup();
	ctx.storageDir = (globalThis as { d1bDir?: string }).d1bDir ?? "";
});

afterAll(async () => {
	await ctx.sql.end();
	await rm(ctx.storageDir, { recursive: true, force: true });
});

describe("assignment lifecycle", () => {
	it("claims, stays idempotent for self, 404s conflicts and strangers", async () => {
		const owner = await createUser(ctx);
		const officer = await createUser(ctx, "officer");
		const officer2 = await createUser(ctx, "officer");
		const stranger = await createUser(ctx);
		const appId = await postApplicationId(owner);

		const first = await claim(officer, appId);
		expect(first.status).toBe(200);
		const c1 = (await first.json()) as any;
		expect(c1.assignment.userId).toBe(officer.id);
		expect(c1.assignment.accessRole).toBe("assigned_officer");
		expect(c1.idempotent).toBe(false);

		const again = await claim(officer, appId);
		expect(again.status).toBe(200);
		expect(((await again.json()) as any).idempotent).toBe(true);
		expect(await activeGrants(appId)).toHaveLength(1);

		expect((await claim(officer2, appId)).status).toBe(404);
		expect((await claim(stranger, appId)).status).toBe(404);
		expect((await claim(owner, appId)).status).toBe(404);
		expect(await activeGrants(appId)).toHaveLength(1);

		expect((await claim(officer, randomUUID())).status).toBe(404);

		// Officer can now use the document surface.
		const up = await upload(officer, appId, "other", pdfBytes("claimed"), "c.pdf");
		expect(up.status).toBe(201);

		const audits = await ctx.db.select().from(auditLog).where(eq(auditLog.applicationId, appId));
		expect(audits.map((row) => row.action)).toContain("access.claim");
	});

	it("service revoke blocks self-reclaim; service grant restores another officer", async () => {
		const owner = await createUser(ctx);
		const officer = await createUser(ctx, "officer");
		const officer2 = await createUser(ctx, "officer");
		const appId = await postApplicationId(owner);
		expect((await claim(officer, appId)).status).toBe(200);

		const revokePath = `/internal/applications/${appId}/document-access/revoke`;
		const revoked = await servicePost(revokePath, { userId: officer.id });
		expect(revoked.status).toBe(200);
		expect(await activeGrants(appId)).toHaveLength(0);

		// Revoked officer cannot self-reclaim (non-leaking 404).
		expect((await claim(officer, appId)).status).toBe(404);
		expect(await activeGrants(appId)).toHaveLength(0);

		// Service grant reassigns to someone else; old officer stays out.
		const grantPath = `/internal/applications/${appId}/document-access/grant`;
		const granted = await servicePost(grantPath, {
			userId: officer2.id,
			role: "assigned_officer",
		});
		expect(granted.status).toBe(200);
		const grants = await activeGrants(appId);
		expect(grants).toHaveLength(1);
		expect(grants[0].userId).toBe(officer2.id);

		expect((await claim(officer, appId)).status).toBe(404);
		const regrant = await servicePost(grantPath, {
			userId: officer2.id,
			role: "assigned_officer",
		});
		expect(regrant.status).toBe(200);
		expect(((await regrant.json()) as any).idempotent).toBe(true);

		const audits = await ctx.db.select().from(auditLog).where(eq(auditLog.applicationId, appId));
		const actions = audits.map((row) => row.action);
		expect(actions).toContain("access.revoke");
		expect(actions).toContain("access.grant");
	});

	it("internal grant/revoke are service-only and validated", async () => {
		const owner = await createUser(ctx);
		const officer = await createUser(ctx, "officer");
		const appId = await postApplicationId(owner);
		const grantPath = `/internal/applications/${appId}/document-access/grant`;
		const revokePath = `/internal/applications/${appId}/document-access/revoke`;

		const asOfficer = {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...signed(
					ctx,
					officer,
					"POST",
					grantPath,
					{},
					JSON.stringify({ userId: officer.id, role: "assigned_officer" }),
				),
			},
			body: JSON.stringify({ userId: officer.id, role: "assigned_officer" }),
		} as const;
		expect((await ctx.app.request(grantPath, asOfficer)).status).toBe(403);

		expect(
			(await servicePost(grantPath, { userId: "nope", role: "assigned_officer" })).status,
		).toBe(400);
		expect((await servicePost(grantPath, { userId: officer.id, role: "boss" })).status).toBe(400);
		expect(
			(
				await servicePost(`/internal/applications/${randomUUID()}/document-access/grant`, {
					userId: officer.id,
					role: "assigned_officer",
				})
			).status,
		).toBe(404);
		expect((await servicePost(revokePath, { userId: officer.id })).status).toBe(404);

		// Not exposed via the public document path shape.
		expect((await claim(officer, appId)).status).toBe(200);
	});
});

describe("retention", () => {
	const QUOTE = "QUOTE-SENTINEL-77881 Acme Pte Ltd";
	const EXPECTED = "EXPECTED-SENTINEL-99112";
	const OBSERVED = "OBSERVED-SENTINEL-99113";
	const BODY = "CHASE-BODY-SENTINEL-55441";
	const FILENAME = "SENSITIVE-FILENAME-33211.pdf";

	async function seededCase(): Promise<{
		appId: string;
		owner: TestUser;
		officer: TestUser;
		fileId: string;
		storageKey: string;
		crosscheckId: string;
		findingId: string;
		chaseId: string;
	}> {
		const owner = await createUser(ctx);
		const officer = await createUser(ctx, "officer");
		const appId = await postApplicationId(owner);
		expect((await claim(officer, appId)).status).toBe(200);
		const up = await upload(officer, appId, "business_registration", pdfBytes("retain"), FILENAME);
		expect(up.status).toBe(201);
		const fileId = up.file.id as string;
		const [file] = await ctx.db.select().from(documentFiles).where(eq(documentFiles.id, fileId));
		const [cross] = await ctx.db
			.insert(documentCrosschecks)
			.values({
				applicationId: appId,
				status: "succeeded",
				validatorVersion: "document-crosscheck-v1",
				documentsChecked: [fileId],
				findingCount: 1,
				requestedBy: officer.id,
			})
			.returning();
		const [finding] = await ctx.db
			.insert(documentFindings)
			.values({
				crosscheckId: cross.id,
				applicationId: appId,
				documentFileId: fileId,
				field: "company_name",
				expected: EXPECTED,
				observed: OBSERVED,
				pageNumber: 1,
				quote: QUOTE,
				quoteStart: 0,
				quoteEnd: [...QUOTE].length,
				quoteHash: "qh",
				confidence: "high",
				status: "mismatch",
				reason: "seeded",
			})
			.returning();
		const [chase] = await ctx.db
			.insert(chaseRequests)
			.values({
				applicationId: appId,
				crosscheckId: cross.id,
				body: BODY,
				createdBy: officer.id,
				inspectedOriginalAt: new Date(),
			})
			.returning();
		await ctx.db
			.insert(chaseRequestFindings)
			.values({ chaseRequestId: chase.id, findingId: finding.id });
		await ctx.db
			.update(documentFiles)
			.set({ retentionUntil: new Date(Date.now() - 1000) })
			.where(eq(documentFiles.id, fileId));
		return {
			appId,
			owner,
			officer,
			fileId,
			storageKey: file.storageKey as string,
			crosscheckId: cross.id,
			findingId: finding.id,
			chaseId: chase.id,
		};
	}

	it("tombstones the file, clears PII, redacts crosscheck/chase, purges the blob", async () => {
		const s = await seededCase();
		await expect(stat(join(ctx.storageDir, s.storageKey))).resolves.toBeDefined();

		const runPath = `/internal/applications/${s.appId}/documents/retention/run`;
		const res = await servicePost(runPath);
		expect(res.status).toBe(200);
		const counts = (await res.json()) as Record<string, number>;
		expect(counts.deletedFiles).toBe(1);
		expect(counts.blobsPurged).toBe(1);
		expect(counts.blobsPending).toBe(0);

		const [file] = await ctx.db.select().from(documentFiles).where(eq(documentFiles.id, s.fileId));
		expect(file.status).toBe("deleted");
		expect(file.originalFilename).toBeNull();
		expect(file.errorCode).toBeNull();
		expect(file.errorMessage).toBeNull();
		expect(file.blobPurgedAt).not.toBeNull();
		await expect(stat(join(ctx.storageDir, s.storageKey))).rejects.toThrow();

		expect(
			await ctx.db.select().from(documentPages).where(eq(documentPages.documentFileId, s.fileId)),
		).toEqual([]);
		expect(
			await ctx.db.select().from(documentFindings).where(eq(documentFindings.id, s.findingId)),
		).toEqual([]);
		expect(
			await ctx.db
				.select()
				.from(chaseRequestFindings)
				.where(eq(chaseRequestFindings.findingId, s.findingId)),
		).toEqual([]);

		const [chase] = await ctx.db
			.select()
			.from(chaseRequests)
			.where(eq(chaseRequests.id, s.chaseId));
		expect(chase.body).toBeNull();
		expect(chase.redactedAt).not.toBeNull();

		const [cross] = await ctx.db
			.select()
			.from(documentCrosschecks)
			.where(eq(documentCrosschecks.id, s.crosscheckId));
		expect(cross.status).toBe("redacted");
		expect(cross.findingCount).toBe(0);

		// Deleted files disappear from the API.
		const listPath = `/api/applications/${s.appId}/documents`;
		const list = await ctx.app.request(listPath, {
			headers: signed(ctx, s.officer, "GET", listPath),
		});
		expect(list.status).toBe(200);
		expect(((await list.json()) as { files: unknown[] }).files).toEqual([]);

		// Audit carries ids only — no quote/expected/observed/body/filename.
		const audits = await ctx.db.select().from(auditLog).where(eq(auditLog.applicationId, s.appId));
		expect(audits.map((row) => row.action)).toContain("document.deleted");
		for (const row of audits) {
			const payload = JSON.stringify(row.payload);
			for (const sentinel of [QUOTE, EXPECTED, OBSERVED, BODY, FILENAME, OCR_TEXT]) {
				expect(payload).not.toContain(sentinel);
			}
		}

		// Second run is a no-op.
		const again = (await (await servicePost(runPath)).json()) as Record<string, number>;
		expect(again.deletedFiles).toBe(0);
		expect(again.blobsPurged).toBe(0);
	});

	it("legal hold blocks deletion; release allows it (app and file scope)", async () => {
		const owner = await createUser(ctx);
		const officer = await createUser(ctx, "officer");
		const appId = await postApplicationId(owner);
		expect((await claim(officer, appId)).status).toBe(200);
		const a = await upload(officer, appId, "other", pdfBytes("hold-a"), "a.pdf");
		const b = await upload(officer, appId, "other", pdfBytes("hold-b"), "b.pdf");
		expect(a.status).toBe(201);
		expect(b.status).toBe(201);
		const past = new Date(Date.now() - 1000);
		for (const f of [a.file.id, b.file.id]) {
			await ctx.db
				.update(documentFiles)
				.set({ retentionUntil: past })
				.where(eq(documentFiles.id, f));
		}

		// File-level hold on A: B is still deleted, A is skipped.
		const fileHold = await servicePost(
			`/internal/applications/${appId}/documents/${a.file.id}/legal-hold`,
			{ reason: "dispute" },
		);
		expect(fileHold.status).toBe(201);
		const holdId = ((await fileHold.json()) as any).holdId as string;

		let counts = (await (
			await servicePost(`/internal/applications/${appId}/documents/retention/run`)
		).json()) as Record<string, number>;
		expect(counts.deletedFiles).toBe(1);
		expect(counts.skippedHolds).toBe(1);
		const [fa] = await ctx.db.select().from(documentFiles).where(eq(documentFiles.id, a.file.id));
		expect(fa.status).toBe("ready");

		// Cross-app file hold 404s; empty reason 400s.
		const other = await createUser(ctx);
		const otherApp = await postApplicationId(other);
		expect(
			(
				await servicePost(`/internal/applications/${otherApp}/documents/${a.file.id}/legal-hold`, {
					reason: "x",
				})
			).status,
		).toBe(404);
		expect(
			(
				await servicePost(`/internal/applications/${appId}/documents/${a.file.id}/legal-hold`, {
					reason: "",
				})
			).status,
		).toBe(400);

		// Application-wide hold now blocks A too.
		const appHold = await servicePost(`/internal/applications/${appId}/documents/legal-hold`, {
			reason: "litigation",
		});
		expect(appHold.status).toBe(201);
		counts = (await (
			await servicePost(`/internal/applications/${appId}/documents/retention/run`)
		).json()) as Record<string, number>;
		expect(counts.deletedFiles).toBe(0);
		expect(counts.skippedHolds).toBe(1);

		// Release both; the next run deletes A.
		expect(
			(await servicePost(`/internal/applications/${appId}/documents/legal-holds/${holdId}/release`))
				.status,
		).toBe(200);
		const appHoldId = ((await appHold.json()) as any).holdId as string;
		expect(
			(
				await servicePost(
					`/internal/applications/${appId}/documents/legal-holds/${appHoldId}/release`,
				)
			).status,
		).toBe(200);
		// Release is idempotent.
		expect(
			(
				await servicePost(
					`/internal/applications/${appId}/documents/legal-holds/${appHoldId}/release`,
				)
			).status,
		).toBe(200);

		counts = (await (
			await servicePost(`/internal/applications/${appId}/documents/retention/run`)
		).json()) as Record<string, number>;
		expect(counts.deletedFiles).toBe(1);
		const audits = await ctx.db.select().from(auditLog).where(eq(auditLog.applicationId, appId));
		const actions = audits.map((row) => row.action);
		expect(actions).toContain("document.hold_created");
		expect(actions).toContain("document.hold_released");
	});

	it("failed blob purge leaves a retry marker; the next sweep purges", async () => {
		const owner = await createUser(ctx);
		const officer = await createUser(ctx, "officer");
		const appId = await postApplicationId(owner);
		expect((await claim(officer, appId)).status).toBe(200);
		const up = await upload(officer, appId, "other", pdfBytes("retry-blob"), "r.pdf");
		expect(up.status).toBe(201);
		const [file] = await ctx.db
			.select()
			.from(documentFiles)
			.where(eq(documentFiles.id, up.file.id));
		await ctx.db
			.update(documentFiles)
			.set({ retentionUntil: new Date(Date.now() - 1000) })
			.where(eq(documentFiles.id, up.file.id));

		const failing = async (): Promise<void> => {
			throw new Error("storage down");
		};
		const env = loadEnv();
		const first = await runDocumentRetention({
			db: ctx.db,
			lockTimeoutMs: configFromEnv(env).lockTimeoutMs,
			storageDir: ctx.storageDir,
			deleteBlobFn: failing,
		});
		expect(first.deletedFiles).toBe(1);
		expect(first.blobsPurged).toBe(0);
		expect(first.blobsPending).toBe(1);

		const [tomb] = await ctx.db
			.select()
			.from(documentFiles)
			.where(eq(documentFiles.id, up.file.id));
		expect(tomb.status).toBe("deleted");
		expect(tomb.blobPurgedAt).toBeNull();
		expect(file.storageKey).not.toBeNull();
		await expect(stat(join(ctx.storageDir, file.storageKey as string))).resolves.toBeDefined();

		const second = await runDocumentRetention({
			db: ctx.db,
			lockTimeoutMs: configFromEnv(env).lockTimeoutMs,
			storageDir: ctx.storageDir,
		});
		expect(second.deletedFiles).toBe(0);
		expect(second.blobsPurged).toBe(1);
		const [done] = await ctx.db
			.select()
			.from(documentFiles)
			.where(eq(documentFiles.id, up.file.id));
		expect(done.blobPurgedAt).not.toBeNull();
		await expect(stat(join(ctx.storageDir, file.storageKey as string))).rejects.toThrow();
	});

	it("retention on an empty/held-free case is a quiet no-op", async () => {
		const owner = await createUser(ctx);
		const appId = await postApplicationId(owner);
		const counts = (await (
			await servicePost(`/internal/applications/${appId}/documents/retention/run`)
		).json()) as Record<string, number>;
		expect(counts.deletedFiles).toBe(0);
		expect(counts.checked).toBe(0);
		expect(
			(await servicePost(`/internal/applications/${randomUUID()}/documents/retention/run`)).status,
		).toBe(404);
	});
});
