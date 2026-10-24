// D1a document integration (real Postgres, fake scanner/OCR — ClamAV and
// tesseract are never touched): owner/assigned upload, list/pages/download
// byte-for-byte, ID 409, cross-app 404, consent 403, feature 404, retry,
// duplicate replay, audit without content, security headers.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLog, caseAccessGrants, documentFiles } from "@credit/db/applications";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	OcrFailed,
	type ExtractionResult,
	type OcrAdapter,
	type OcrLimits,
} from "../../src/documents/ocr.js";
import type { ScannerAdapter } from "../../src/documents/scanner.js";
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
const FILENAME = "SENSITIVE-NAME-12345.pdf";
const ENCRYPTION_KEY = randomBytes(32).toString("base64");

function mutableScanner() {
	const state = {
		verdict: "clean" as "clean" | "infected" | "unavailable",
		calls: 0,
	};
	const adapter: ScannerAdapter = {
		async scan(_bytes: Buffer) {
			state.calls++;
			if (state.verdict === "unavailable") {
				const { ScannerUnavailable } = await import("../../src/documents/scanner.js");
				throw new ScannerUnavailable();
			}
			return state.verdict;
		},
	};
	return { state, adapter };
}

function cloneResult(r: ExtractionResult): ExtractionResult {
	return structuredClone(r);
}

function mutableOcr(initial: ExtractionResult | "failed" | (() => Promise<ExtractionResult>)) {
	const state = { result: initial, calls: 0, entered: 0 };
	const run = async (): Promise<ExtractionResult> => {
		state.calls++;
		if (typeof state.result === "function") {
			state.entered++;
			return state.result();
		}
		if (state.result === "failed") throw new OcrFailed();
		return cloneResult(state.result);
	};
	const adapter: OcrAdapter = {
		async extractPdf(_bytes: Buffer, _limits: OcrLimits) {
			return run();
		},
		async extractImage(_bytes: Buffer, _imageType: "png" | "jpeg", _limits: OcrLimits) {
			return run();
		},
	};
	return { state, adapter };
}

const READY_TEXT: ExtractionResult = {
	status: "ready",
	pages: [{ text: OCR_TEXT, source: "ocr", confidence: 0.95 }],
	textLayerRisk: false,
};
const UNSUPPORTED: ExtractionResult = { status: "unsupported", pages: [], textLayerRisk: false };

/** OCR fake that blocks inside extraction until released (concurrency test). */
function gatedOcr() {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const state = { entered: 0 };
	const adapter: OcrAdapter = {
		async extractPdf(_bytes: Buffer, _limits: OcrLimits) {
			state.entered++;
			await gate;
			return structuredClone(READY_TEXT);
		},
		async extractImage(_bytes: Buffer, _imageType: "png" | "jpeg", _limits: OcrLimits) {
			state.entered++;
			await gate;
			return structuredClone(READY_TEXT);
		},
	};
	return { state, adapter, release: () => release() };
}

function pngBytes(tag: string): Buffer {
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		Buffer.from(tag),
		randomBytes(64),
	]);
}
function jpegBytes(tag: string): Buffer {
	return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag), randomBytes(64)]);
}

interface DocContext extends TestContext {
	scanner: ReturnType<typeof mutableScanner>;
	ocr: ReturnType<typeof mutableOcr>;
}

function setupDocs(
	overrides: Record<string, unknown> = {},
	adapters: { scanner?: ScannerAdapter; ocr?: OcrAdapter } = {},
): DocContext {
	const scanner = mutableScanner();
	const ocr = mutableOcr(READY_TEXT);
	const ctx = setupApp({
		storageDir: (globalThis as { docTestDir?: string }).docTestDir ?? "",
		documents: {
			config: {
				featureEnabled: true,
				encryptionKey: ENCRYPTION_KEY,
				keyId: "v1",
				...overrides,
			},
			scanner: adapters.scanner ?? scanner.adapter,
			ocr: adapters.ocr ?? ocr.adapter,
		},
	});
	return { ...ctx, scanner, ocr };
}

let ctx: DocContext;
let storageDir: string;

async function postApplicationId(user: TestUser, consent: boolean): Promise<string> {
	const res = await postApplication(ctx, user, "/api/applications", {
		...individualPayload(user.email),
		documentProcessingConsent: consent,
	});
	expect(res.status).toBe(201);
	return ((await res.json()) as { id: string }).id;
}

async function grantOfficer(applicationId: string, officer: TestUser): Promise<void> {
	await ctx.db.insert(caseAccessGrants).values({
		applicationId,
		userId: officer.id,
		accessRole: "assigned_officer",
	});
}

/** Fresh case: consenting owner + assigned officer. */
async function newCase(
	consent = true,
): Promise<{ appId: string; owner: TestUser; officer: TestUser }> {
	const owner = await createUser(ctx);
	const officer = await createUser(ctx, "officer");
	const appId = await postApplicationId(owner, consent);
	await grantOfficer(appId, officer);
	return { appId, owner, officer };
}

async function upload(
	user: TestUser,
	appId: string,
	kind: string,
	bytes: Buffer,
	filename = FILENAME,
): Promise<Response> {
	const boundary = `----testboundary${randomUUID().replace(/-/g, "")}`;
	const body = multipart(boundary, [
		{ name: "kind", data: kind },
		{ name: "file", filename, contentType: "application/octet-stream", data: bytes },
	]);
	const path = `/api/applications/${appId}/documents`;
	return ctx.app.request(path, {
		method: "POST",
		headers: {
			"content-type": `multipart/form-data; boundary=${boundary}`,
			...signed(ctx, user, "POST", path, {}, body),
		},
		body,
	});
}

async function errorCode(res: Response): Promise<string> {
	return ((await res.json()) as { error: { code: string } }).error.code;
}

beforeAll(async () => {
	storageDir = await mkdtemp(join(tmpdir(), "docs-int-"));
	(globalThis as { docTestDir?: string }).docTestDir = storageDir;
	ctx = setupDocs();
});

afterAll(async () => {
	await ctx.sql.end();
	await rm(storageDir, { recursive: true, force: true });
});

describe("owner upload + pages + download", () => {
	it("201s, extracts fake text, downloads byte-for-byte with safe headers", async () => {
		const { appId, owner } = await newCase();
		const bytes = pdfBytes("owner-case");
		const res = await upload(owner, appId, "other", bytes);
		expect(res.status).toBe(201);
		const { file } = (await res.json()) as { file: Record<string, unknown> };
		expect(file.status).toBe("ready");
		expect(file.ocrStatus).toBe("ready");
		expect(file.pageCount).toBe(1);

		const pagesPath = `/api/applications/${appId}/documents/${file.id}/pages`;
		const pages = await ctx.app.request(pagesPath, {
			headers: signed(ctx, owner, "GET", pagesPath),
		});
		expect(pages.status).toBe(200);
		expect(pages.headers.get("cache-control")).toBe("no-store");
		const { pages: items } = (await pages.json()) as {
			pages: Array<{ text: string; charCount: number }>;
		};
		expect(items).toHaveLength(1);
		expect(items[0].text).toBe(OCR_TEXT);
		expect(items[0].charCount).toBe([...OCR_TEXT].length);

		const filePath = `/api/applications/${appId}/documents/${file.id}/file`;
		const down = await ctx.app.request(filePath, { headers: signed(ctx, owner, "GET", filePath) });
		expect(down.status).toBe(200);
		expect(Buffer.from(await down.arrayBuffer()).equals(bytes)).toBe(true);
		expect(down.headers.get("content-disposition")).toMatch(
			/^attachment; filename="document-.*\.pdf"$/,
		);
		expect(down.headers.get("cache-control")).toBe("no-store");
		expect(down.headers.get("x-content-type-options")).toBe("nosniff");

		const listPath = `/api/applications/${appId}/documents`;
		const list = await ctx.app.request(listPath, { headers: signed(ctx, owner, "GET", listPath) });
		expect(list.status).toBe(200);
		expect(list.headers.get("cache-control")).toBe("no-store");
		const { files } = (await list.json()) as { files: Array<Record<string, unknown>> };
		expect(files).toHaveLength(1);
		expect(JSON.stringify(files)).not.toContain(OCR_TEXT);
	});
});

describe("officer access boundaries", () => {
	it("assigned officer uploads/lists; strangers and cross-app ids 404", async () => {
		const { appId, owner, officer } = await newCase();
		const other = await createUser(ctx);
		const officer2 = await createUser(ctx, "officer");
		const bytes = jpegBytes("officer-case");

		const up = await upload(officer, appId, "bank_statement", bytes, "statement.jpg");
		expect(up.status).toBe(201);

		const listPath = `/api/applications/${appId}/documents`;
		const list = await ctx.app.request(listPath, {
			headers: signed(ctx, officer, "GET", listPath),
		});
		expect(list.status).toBe(200);
		expect(((await list.json()) as { files: unknown[] }).files).toHaveLength(1);

		expect(
			(await ctx.app.request(listPath, { headers: signed(ctx, other, "GET", listPath) })).status,
		).toBe(404);
		expect(
			(await ctx.app.request(listPath, { headers: signed(ctx, officer2, "GET", listPath) })).status,
		).toBe(404);

		const { file } = (await up.json()) as { file: { id: string } };
		const { appId: appB, officer: officerB } = await newCase();
		await upload(owner, appB, "other", pdfBytes("unrelated"));
		const cross = await ctx.app.request(`/api/applications/${appB}/documents/${file.id}`, {
			headers: signed(ctx, officerB, "GET", `/api/applications/${appB}/documents/${file.id}`),
		});
		expect(cross.status).toBe(404);
	});
});

describe("id documents", () => {
	it("stores bytes with not_applicable OCR; pages 409s; download works", async () => {
		const { appId, owner } = await newCase();
		const bytes = pngBytes("id-case");
		const res = await upload(owner, appId, "id", bytes, "id.png");
		expect(res.status).toBe(201);
		const { file } = (await res.json()) as { file: Record<string, unknown> };
		expect(file.ocrStatus).toBe("not_applicable");
		expect(file.pageCount).toBe(0);

		const pagesPath = `/api/applications/${appId}/documents/${file.id}/pages`;
		const pages = await ctx.app.request(pagesPath, {
			headers: signed(ctx, owner, "GET", pagesPath),
		});
		expect(pages.status).toBe(409);
		expect(await errorCode(pages)).toBe("NO_TEXT");

		const filePath = `/api/applications/${appId}/documents/${file.id}/file`;
		const down = await ctx.app.request(filePath, { headers: signed(ctx, owner, "GET", filePath) });
		expect(down.status).toBe(200);
		expect(Buffer.from(await down.arrayBuffer()).equals(bytes)).toBe(true);
	});
});

describe("statement dating on upload", () => {
	const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	const dayFmt = (daysAgo: number): string => {
		const d = new Date(Date.now() - daysAgo * 86_400_000);
		return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
	};
	const dayIso = (daysAgo: number): string =>
		new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

	afterEach(() => {
		ctx.ocr.state.result = READY_TEXT;
	});

	const rowDates = async (
		appId: string,
	): Promise<{ periodEnd: string | null; documentDate: string | null; source: string | null }> => {
		const rows = await ctx.db
			.select({
				periodEnd: documentFiles.periodEnd,
				documentDate: documentFiles.documentDate,
				source: documentFiles.documentDateSource,
			})
			.from(documentFiles)
			.where(eq(documentFiles.applicationId, appId));
		expect(rows).toHaveLength(1);
		return rows[0];
	};

	it("persists the server-extracted periodEnd for a fresh statement", async () => {
		const { appId, owner } = await newCase();
		ctx.ocr.state.result = {
			status: "ready",
			pages: [
				{
					text: `Demo Bank\nStatement Period: ${dayFmt(40)} - ${dayFmt(10)}\nClosing 1,000`,
					source: "pdf_text",
					confidence: 0.99,
				},
			],
			textLayerRisk: false,
		};
		expect((await upload(owner, appId, "bank_statement", pdfBytes("fresh-stmt"))).status).toBe(201);
		expect(await rowDates(appId)).toEqual({
			periodEnd: dayIso(10),
			documentDate: dayIso(10),
			source: "server_ocr",
		});
	});

	it("persists a stale periodEnd from text (freshness stays the engine's job)", async () => {
		const { appId, owner } = await newCase();
		ctx.ocr.state.result = {
			status: "ready",
			pages: [
				{
					text: `Demo Bank\nStatement Period: ${dayFmt(200)} - ${dayFmt(120)}\nClosing 1,000`,
					source: "pdf_text",
					confidence: 0.99,
				},
			],
			textLayerRisk: false,
		};
		expect((await upload(owner, appId, "bank_statement", pdfBytes("stale-stmt"))).status).toBe(201);
		expect(await rowDates(appId)).toEqual({
			periodEnd: dayIso(120),
			documentDate: dayIso(120),
			source: "server_ocr",
		});
	});

	it("leaves dates unknown when the text carries no period", async () => {
		const { appId, owner } = await newCase();
		expect((await upload(owner, appId, "bank_statement", pdfBytes("dateless"))).status).toBe(201);
		expect(await rowDates(appId)).toEqual({ periodEnd: null, documentDate: null, source: null });
	});
});

describe("consent and feature gates", () => {
	it("missing consent 403s; withdrawal blocks uploads", async () => {
		const { appId, owner } = await newCase(false);
		const up = await upload(owner, appId, "other", pdfBytes("no-consent"));
		expect(up.status).toBe(403);
		expect(await errorCode(up)).toBe("CONSENT_REQUIRED");

		const { appId: appB, owner: ownerB } = await newCase(true);
		const patchPath = `/api/applications/${appB}/document-consent`;
		const patchBody = JSON.stringify({ consent: false });
		const patch = await ctx.app.request(patchPath, {
			method: "PATCH",
			headers: {
				"content-type": "application/json",
				...signed(ctx, ownerB, "PATCH", patchPath, {}, patchBody),
			},
			body: patchBody,
		});
		expect(patch.status).toBe(200);
		const blocked = await upload(ownerB, appB, "other", pdfBytes("withdrawn"));
		expect(blocked.status).toBe(403);
		expect(await errorCode(blocked)).toBe("CONSENT_REQUIRED");
	});

	it("feature flag off 404s every document route", async () => {
		const off = setupDocs({ featureEnabled: false });
		try {
			const owner = await createUser(off);
			const created = await postApplication(off, owner, "/api/applications", {
				...individualPayload(owner.email),
				documentProcessingConsent: true,
			});
			expect(created.status).toBe(201);
			const { id } = (await created.json()) as { id: string };
			const listPath = `/api/applications/${id}/documents`;
			expect(
				(await off.app.request(listPath, { headers: signed(off, owner, "GET", listPath) })).status,
			).toBe(404);
			const boundary = "----testboundaryoff";
			const upBody = multipart(boundary, [
				{ name: "kind", data: "other" },
				{ name: "file", filename: "x.pdf", data: pdfBytes("off") },
			]);
			const upPath = `/api/applications/${id}/documents`;
			const up = await off.app.request(upPath, {
				method: "POST",
				headers: {
					"content-type": `multipart/form-data; boundary=${boundary}`,
					...signed(off, owner, "POST", upPath, {}, upBody),
				},
				body: upBody,
			});
			expect(up.status).toBe(404);
		} finally {
			await off.sql.end();
		}
	});
});

describe("duplicate and rejected replay", () => {
	it("identical bytes+kind replay without rescanning (200, same id)", async () => {
		const { appId, owner } = await newCase();
		const bytes = pdfBytes("dupe-case");
		const before = ctx.scanner.state.calls;
		const first = await upload(owner, appId, "other", bytes);
		expect(first.status).toBe(201);
		const { file: f1 } = (await first.json()) as { file: { id: string } };
		const second = await upload(owner, appId, "other", bytes);
		expect(second.status).toBe(200);
		const { file: f2 } = (await second.json()) as { file: { id: string } };
		expect(f2.id).toBe(f1.id);
		expect(ctx.scanner.state.calls - before).toBe(1);
		// Same bytes, different kind: a new row.
		const third = await upload(owner, appId, "bank_statement", bytes);
		expect(third.status).toBe(201);
	});

	it("rejected rows replay their stored code (422) without rescanning", async () => {
		const { appId, owner } = await newCase();
		const garbage = Buffer.concat([Buffer.from("not a document"), randomBytes(32)]);
		const first = await upload(owner, appId, "other", garbage, "evil.txt");
		expect(first.status).toBe(415);
		expect(await errorCode(first)).toBe("UNSUPPORTED_TYPE");
		const before = ctx.scanner.state.calls;
		const second = await upload(owner, appId, "other", garbage, "evil.txt");
		expect(second.status).toBe(422);
		expect(await errorCode(second)).toBe("UNSUPPORTED_TYPE");
		expect(ctx.scanner.state.calls).toBe(before);
	});

	it("malware persists a rejected row and replays it", async () => {
		const { appId, owner } = await newCase();
		ctx.scanner.state.verdict = "infected";
		try {
			const bytes = pdfBytes("malware-case");
			const first = await upload(owner, appId, "other", bytes);
			expect(first.status).toBe(422);
			expect(await errorCode(first)).toBe("MALWARE_DETECTED");
			const before = ctx.scanner.state.calls;
			const second = await upload(owner, appId, "other", bytes);
			expect(second.status).toBe(422);
			expect(await errorCode(second)).toBe("MALWARE_DETECTED");
			expect(ctx.scanner.state.calls).toBe(before);
		} finally {
			ctx.scanner.state.verdict = "clean";
		}
	});
});

describe("failure semantics", () => {
	it("scanner outage 503s with no row", async () => {
		const { appId, owner } = await newCase();
		ctx.scanner.state.verdict = "unavailable";
		try {
			const res = await upload(owner, appId, "other", pdfBytes("outage"));
			expect(res.status).toBe(503);
			expect(await errorCode(res)).toBe("SCANNER_UNAVAILABLE");
			expect(
				await ctx.db.select().from(documentFiles).where(eq(documentFiles.applicationId, appId)),
			).toEqual([]);
		} finally {
			ctx.scanner.state.verdict = "clean";
		}
	});

	it("oversize files 413 with a rejected row", async () => {
		const { appId, owner } = await newCase();
		const big = Buffer.concat([Buffer.from("%PDF-"), randomBytes(10_485_760)]);
		const res = await upload(owner, appId, "other", big, "big.pdf");
		expect(res.status).toBe(413);
		expect(await errorCode(res)).toBe("FILE_TOO_LARGE");
		const rows = await ctx.db
			.select()
			.from(documentFiles)
			.where(eq(documentFiles.applicationId, appId));
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe("rejected");
		expect(rows[0].errorCode).toBe("FILE_TOO_LARGE");
	});

	it("5/min/app rate limit, then 429", async () => {
		const { appId, owner } = await newCase();
		for (let i = 0; i < 5; i++) {
			const res = await upload(owner, appId, "other", pdfBytes(`rate-${i}`), `r${i}.pdf`);
			expect(res.status).toBe(201);
		}
		const sixth = await upload(owner, appId, "other", pdfBytes("rate-5"), "r5.pdf");
		expect(sixth.status).toBe(429);
		expect(await errorCode(sixth)).toBe("RATE_LIMITED");
	});

	it("saturated OCR concurrency 429s without a row", async () => {
		const gate = gatedOcr();
		const ctx2 = setupDocs({ ocrConcurrency: 1, uploadDeadlineMs: 30_000 }, { ocr: gate.adapter });
		const prev = ctx;
		ctx = ctx2;
		try {
			const { appId, owner } = await newCase();
			const first = upload(owner, appId, "other", pdfBytes("busy-1"), "b1.pdf");
			const t0 = Date.now();
			while (gate.state.entered === 0 && Date.now() - t0 < 5000) {
				await new Promise((r) => setTimeout(r, 10));
			}
			expect(gate.state.entered).toBe(1);
			const second = await upload(owner, appId, "other", pdfBytes("busy-2"), "b2.pdf");
			expect(second.status).toBe(429);
			expect(await errorCode(second)).toBe("OCR_BUSY");
			// Neither upload persisted: the first is still gated, the second never wrote.
			expect(
				await ctx.db.select().from(documentFiles).where(eq(documentFiles.applicationId, appId)),
			).toEqual([]);
			gate.release();
			expect((await first).status).toBe(201);
		} finally {
			gate.release();
			ctx = prev;
			await ctx2.sql.end();
		}
	});
});

describe("retry-ocr", () => {
	it("retries unsupported → ready, then 409s; ready files 409 immediately", async () => {
		const { appId, owner } = await newCase();
		ctx.ocr.state.result = UNSUPPORTED;
		const bytes = pdfBytes("retry-case");
		const first = await upload(owner, appId, "other", bytes);
		expect(first.status).toBe(201);
		const { file } = (await first.json()) as { file: { id: string; ocrStatus: string } };
		expect(file.ocrStatus).toBe("unsupported");

		ctx.ocr.state.result = READY_TEXT;
		const retryPath = `/api/applications/${appId}/documents/${file.id}/retry-ocr`;
		const retry = await ctx.app.request(retryPath, {
			method: "POST",
			headers: signed(ctx, owner, "POST", retryPath),
		});
		expect(retry.status).toBe(200);
		expect(((await retry.json()) as { file: { ocrStatus: string } }).file.ocrStatus).toBe("ready");

		const again = await ctx.app.request(retryPath, {
			method: "POST",
			headers: signed(ctx, owner, "POST", retryPath),
		});
		expect(again.status).toBe(409);
		expect(await errorCode(again)).toBe("OCR_NOT_RETRYABLE");
	});

	it("a concurrent retry on the same file 429s (per-file lock)", async () => {
		const { appId, owner } = await newCase();
		ctx.ocr.state.result = UNSUPPORTED;
		const first = await upload(owner, appId, "other", pdfBytes("retry-lock"));
		const { file } = (await first.json()) as { file: { id: string } };
		let release!: () => void;
		const gate = new Promise<ExtractionResult>((resolve) => {
			release = () => resolve(structuredClone(READY_TEXT));
		});
		ctx.ocr.state.result = () => gate;
		const retryPath = `/api/applications/${appId}/documents/${file.id}/retry-ocr`;
		const running = ctx.app.request(retryPath, {
			method: "POST",
			headers: signed(ctx, owner, "POST", retryPath),
		});
		const base = ctx.ocr.state.entered;
		const t0 = Date.now();
		while (ctx.ocr.state.entered === base && Date.now() - t0 < 5000) {
			await new Promise((r) => setTimeout(r, 10));
		}
		expect(ctx.ocr.state.entered).toBe(base + 1);
		const clash = await ctx.app.request(retryPath, {
			method: "POST",
			headers: signed(ctx, owner, "POST", retryPath),
		});
		expect(clash.status).toBe(429);
		release();
		expect((await running).status).toBe(200);
		ctx.ocr.state.result = READY_TEXT;
	});
});

describe("low-confidence OCR", () => {
	it("persists low_confidence with pages and a 201", async () => {
		const { appId, owner } = await newCase();
		ctx.ocr.state.result = {
			status: "low_confidence",
			pages: [{ text: OCR_TEXT, source: "ocr", confidence: 0.4 }],
			textLayerRisk: false,
		};
		try {
			const res = await upload(owner, appId, "other", pdfBytes("lowconf"));
			expect(res.status).toBe(201);
			const { file } = (await res.json()) as {
				file: { ocrStatus: string; ocrConfidence: number; pageCount: number };
			};
			expect(file.ocrStatus).toBe("low_confidence");
			expect(file.pageCount).toBe(1);
			expect(file.ocrConfidence).toBeCloseTo(0.4);
		} finally {
			ctx.ocr.state.result = READY_TEXT;
		}
	});
});

describe("storage and sweep failures", () => {
	it("storage finalization failure leaves no row and 500s", async () => {
		const { writeFile } = await import("node:fs/promises");
		const notADir = join(storageDir, "not-a-dir");
		await writeFile(notADir, "x");
		const ctx3 = setupDocs({ storageDir: notADir });
		const prev = ctx;
		ctx = ctx3;
		try {
			const { appId, owner } = await newCase();
			const res = await upload(owner, appId, "other", pdfBytes("no-store"));
			expect(res.status).toBe(500);
			expect(
				await ctx.db.select().from(documentFiles).where(eq(documentFiles.applicationId, appId)),
			).toEqual([]);
		} finally {
			ctx = prev;
			await ctx3.sql.end();
		}
	});

	it("orphan sweep removes rowless old blobs and old temps, keeps live blobs", async () => {
		const { stat, utimes, writeFile, mkdir } = await import("node:fs/promises");
		const { sweepDocumentOrphans } = await import("../../src/documents/service.js");
		const { appId, owner } = await newCase();
		const up = await upload(owner, appId, "other", pdfBytes("sweep-live"));
		expect(up.status).toBe(201);
		const { file } = (await up.json()) as { file: { id: string } };
		const [row] = await ctx.db.select().from(documentFiles).where(eq(documentFiles.id, file.id));
		const livePath = join(storageDir, row.storageKey as string);
		const old = new Date(Date.now() - 3 * 3_600_000);

		const orphanShard = join(storageDir, "00000000-0000-0000-0000-000000000000");
		await mkdir(orphanShard, { recursive: true });
		const orphanPath = join(orphanShard, `${randomUUID()}.enc`);
		await writeFile(orphanPath, randomBytes(16));
		await utimes(orphanPath, old, old);
		const freshPath = join(orphanShard, `${randomUUID()}.enc`);
		await writeFile(freshPath, randomBytes(16));
		const tmpPath = join(orphanShard, `x.tmp-${Date.now()}`);
		await writeFile(tmpPath, randomBytes(16));
		await utimes(tmpPath, old, old);
		await utimes(livePath, old, old); // live blob, backdated: row still guards it

		const swept = await sweepDocumentOrphans(ctx.db, storageDir, { deadlineMs: 1000 });
		expect(swept.removedBlobs).toBe(1);
		expect(swept.removedTemps).toBe(1);
		await expect(stat(orphanPath)).rejects.toThrow();
		await expect(stat(tmpPath)).rejects.toThrow();
		await expect(stat(freshPath)).resolves.toBeDefined();
		await expect(stat(livePath)).resolves.toBeDefined();
	});
});

describe("audit and log hygiene", () => {
	it("no extracted text or filename in any audit payload", async () => {
		const { appId, owner } = await newCase();
		const bytes = pdfBytes("hygiene");
		const up = await upload(owner, appId, "other", bytes);
		expect(up.status).toBe(201);
		const { file } = (await up.json()) as { file: { id: string } };
		const filePath = `/api/applications/${appId}/documents/${file.id}/file`;
		await ctx.app.request(filePath, { headers: signed(ctx, owner, "GET", filePath) });
		const rows = await ctx.db.select().from(auditLog).where(eq(auditLog.applicationId, appId));
		expect(rows.length).toBeGreaterThan(0);
		const actions = rows.map((r) => r.action).sort();
		expect(actions).toContain("document.uploaded");
		expect(actions).toContain("document.original_opened");
		for (const row of rows) {
			const payload = JSON.stringify(row.payload);
			expect(payload).not.toContain(OCR_TEXT);
			expect(payload).not.toContain(FILENAME);
			expect(payload).not.toContain("text");
		}
	});
});
