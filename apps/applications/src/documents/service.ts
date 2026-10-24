// T01 document service (SPEC-t01-t02 §6): synchronous upload orchestration
// (validate → dedupe → scan → extract → encrypt → transactional persist),
// retry-ocr, metadata/pages/download readers, and the boot/interval orphan
// sweep (exposed for D1b to call; retention/legal-hold sweeps are D1b).
//
// Ordering invariants: scan precedes extraction and encryption; encryption
// precedes the blob write; the terminal row + pages + audit persist in ONE
// transaction AFTER extraction, under the per-application advisory lock,
// which re-reads document-processing consent. No row exists on storage or
// DB finalization failure; OCR failure is `ready` + `ocr_status=failed`.
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
	applications,
	chaseRequestFindings,
	chaseRequests,
	documentCrosschecks,
	documentFiles,
	documentFindings,
	documentPages,
	withTx,
	type Db,
	type Tx,
} from "@credit/db/applications";
import { HttpError, writeAudit } from "@credit/service-kit";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
	CRYPTO_VERSION,
	encryptDocument,
	parseEncryptionKey,
	parsePreviousKeys,
	sha256Hex,
} from "./crypto.js";
import {
	assertDetectedType,
	assertSize,
	extractStatementDates,
	isUniqueViolation,
	LockTimeout,
	mapUploadError,
	mimeForType,
	OcrSemaphore,
	parseKind,
	UploadRateLimiter,
	UploadTimeout,
	type DetectedType,
	type DocumentKind,
} from "./pipeline.js";
import { createOcrAdapter, OcrFailed, type OcrAdapter } from "./ocr.js";
import { resolveScanner, ScannerUnavailable, type ScannerAdapter } from "./scanner.js";
import { lockApplication } from "./access.js";
import {
	deleteBlob,
	ensureStorageDir,
	openAndVerifyBlob,
	storageKeyFor,
	writeEncryptedFile,
} from "./storage.js";

export interface DocumentsConfig {
	featureEnabled: boolean;
	storageDir: string;
	encryptionKey: string | undefined;
	keyId: string;
	previousKeys: string | undefined;
	maxBytes: number;
	maxPages: number;
	maxPageTextBytes: number;
	maxTotalTextBytes: number;
	maxPixels: number;
	uploadDeadlineMs: number;
	lockTimeoutMs: number;
	scanTimeoutMs: number;
	ocrTimeoutMs: number;
	ocrConcurrency: number;
	uploadRatePerMin: number;
	ocrDataDir: string | undefined;
	retentionDays: number;
	scanner: string;
	clamavHost: string;
	clamavPort: number;
	minConfidence: number;
}

export interface DocumentAdapters {
	scanner?: ScannerAdapter;
	ocr?: OcrAdapter;
	/** Full config override (tests); defaults to the service env. */
	config?: Partial<DocumentsConfig>;
}

export type DocumentFileRow = typeof documentFiles.$inferSelect;
export type DocumentPageRow = typeof documentPages.$inferSelect;

export function configFromEnv(env: {
	documentUploadMaxBytes?: number;
	documents: {
		featureEnabled: boolean;
		storageDir: string;
		encryptionKey: string | undefined;
		keyId: string;
		previousKeys: string | undefined;
		maxBytes: number;
		maxPages: number;
		maxPageTextBytes: number;
		maxTotalTextBytes: number;
		maxPixels: number;
		uploadDeadlineMs: number;
		lockTimeoutMs: number;
		scanTimeoutMs: number;
		ocrTimeoutMs: number;
		ocrConcurrency: number;
		uploadRatePerMin: number;
		ocrDataDir: string | undefined;
		retentionDays: number;
		scanner: string;
		clamavHost: string;
		clamavPort: number;
		crosscheckMinConfidence: number;
	};
}): DocumentsConfig {
	const d = env.documents;
	return {
		featureEnabled: d.featureEnabled,
		storageDir: d.storageDir,
		encryptionKey: d.encryptionKey,
		keyId: d.keyId,
		previousKeys: d.previousKeys,
		maxBytes: d.maxBytes,
		maxPages: d.maxPages,
		maxPageTextBytes: d.maxPageTextBytes,
		maxTotalTextBytes: d.maxTotalTextBytes,
		maxPixels: d.maxPixels,
		uploadDeadlineMs: d.uploadDeadlineMs,
		lockTimeoutMs: d.lockTimeoutMs,
		scanTimeoutMs: d.scanTimeoutMs,
		ocrTimeoutMs: d.ocrTimeoutMs,
		ocrConcurrency: d.ocrConcurrency,
		uploadRatePerMin: d.uploadRatePerMin,
		ocrDataDir: d.ocrDataDir,
		retentionDays: d.retentionDays,
		scanner: d.scanner,
		clamavHost: d.clamavHost,
		clamavPort: d.clamavPort,
		minConfidence: d.crosscheckMinConfidence,
	};
}

export interface DocumentServiceDeps {
	db: Db;
	config: DocumentsConfig;
	scanner: ScannerAdapter;
	ocr: OcrAdapter;
	rateLimiter?: UploadRateLimiter;
	ocrSemaphore?: OcrSemaphore;
}

export interface UploadInput {
	applicationId: string;
	userId: string;
	kind: string;
	originalFilename: string | null;
	bytes: Buffer;
}

interface PendingExtraction {
	status: "ready" | "low_confidence" | "unsupported" | "failed";
	pages: Array<{
		text: string;
		source: "pdf_text" | "ocr";
		confidence: number;
		pageNumber?: number;
	}>;
	textLayerRisk: boolean;
	pageCount?: number;
}

export interface UploadOutcome {
	file: DocumentFileRow;
	/** True when an identical (application, kind, sha256) row already won. */
	replayed: boolean;
	/** 200 for a ready replay, 201 for a fresh store. */
	httpStatus: 200 | 201;
}

export class DocumentService {
	readonly retryLocks = new Set<string>();
	private readonly rateLimiter: UploadRateLimiter;
	private readonly ocrSemaphore: OcrSemaphore;
	constructor(private readonly deps: DocumentServiceDeps) {
		this.rateLimiter = deps.rateLimiter ?? new UploadRateLimiter(deps.config.uploadRatePerMin);
		this.ocrSemaphore = deps.ocrSemaphore ?? new OcrSemaphore(deps.config.ocrConcurrency);
	}

	private keys(): Map<string, Buffer> {
		let active: Buffer;
		try {
			active = parseEncryptionKey(this.deps.config.encryptionKey);
		} catch {
			throw new HttpError(503, "ENCRYPTION_UNAVAILABLE", "document encryption is unavailable");
		}
		let previous: Map<string, Buffer>;
		try {
			previous = parsePreviousKeys(this.deps.config.previousKeys);
		} catch {
			throw new HttpError(503, "ENCRYPTION_UNAVAILABLE", "document encryption is unavailable");
		}
		previous.set(this.deps.config.keyId, active);
		return previous;
	}

	private ocrLimits() {
		const c = this.deps.config;
		return {
			maxPages: c.maxPages,
			maxPageTextBytes: c.maxPageTextBytes,
			maxTotalTextBytes: c.maxTotalTextBytes,
			maxPixels: c.maxPixels,
			minConfidence: c.minConfidence,
			timeoutMs: c.ocrTimeoutMs,
		};
	}

	private async findDuplicate(
		db: Db | Tx,
		applicationId: string,
		kind: DocumentKind,
		sha256: string,
	): Promise<DocumentFileRow | null> {
		const rows = await db
			.select()
			.from(documentFiles)
			.where(
				and(
					eq(documentFiles.applicationId, applicationId),
					eq(documentFiles.kind, kind),
					eq(documentFiles.sha256, sha256),
					sql`${documentFiles.status} != 'deleted'`,
				),
			)
			.limit(1);
		return rows[0] ?? null;
	}

	private replayOf(winner: DocumentFileRow): UploadOutcome {
		if (winner.status === "ready") {
			return { file: winner, replayed: true, httpStatus: 200 };
		}
		throw new HttpError(
			422,
			winner.errorCode ?? "DOCUMENT_REJECTED",
			"this file was already rejected",
		);
	}

	/** Terminal persist: lock → consent recheck → row + pages + audit.
	 * A concurrent identical insert trips the unique constraint: the tx
	 * aborts, so the loser deletes its blob and replays the winner with a
	 * fresh read OUTSIDE the aborted tx. Any other DB failure deletes the
	 * blob and 500s (no row survives). */
	private async finalize(opts: {
		applicationId: string;
		userId: string;
		kind: DocumentKind;
		sha256: string;
		storageKey: string | null;
		build: (fileId: string, now: Date) => Omit<typeof documentFiles.$inferInsert, "id">;
		pages: Array<{
			pageNumber: number;
			text: string;
			source: "pdf_text" | "ocr";
			confidence: number;
		}>;
		auditAction: "document.uploaded" | "document.rejected";
		auditPayload: Record<string, unknown>;
	}): Promise<UploadOutcome> {
		const { db } = this.deps;
		const fileId = randomUUID();
		const dropBlob = async (): Promise<void> => {
			if (opts.storageKey) await deleteBlob(this.deps.config.storageDir, opts.storageKey);
		};
		let inserted: DocumentFileRow;
		try {
			inserted = await withTx(db, async (tx) => {
				await lockApplication(tx, opts.applicationId, this.deps.config.lockTimeoutMs);
				const apps = await tx
					.select()
					.from(applications)
					.where(eq(applications.id, opts.applicationId));
				if (!apps[0]?.documentProcessingConsent) {
					throw new HttpError(403, "CONSENT_REQUIRED", "document processing consent is required");
				}
				const [created] = await tx
					.insert(documentFiles)
					.values(opts.build(fileId, new Date()))
					.returning();
				if (opts.pages.length > 0) {
					await tx.insert(documentPages).values(
						opts.pages.map((p) => ({
							documentFileId: created.id,
							pageNumber: p.pageNumber,
							text: p.text,
							textSource: p.source,
							confidence: p.confidence,
							textSha256: sha256Hex(Buffer.from(p.text, "utf8")),
						})),
					);
				}
				await writeAudit(tx, {
					applicationId: opts.applicationId,
					actor: opts.userId,
					action: opts.auditAction,
					entity: "document_file",
					payload: { documentFileId: created.id, ...opts.auditPayload },
				});
				return created;
			});
		} catch (err) {
			if (err instanceof HttpError) {
				await dropBlob();
				throw err;
			}
			if (err instanceof LockTimeout) {
				await dropBlob();
				throw new HttpError(409, "LOCK_TIMEOUT", "the case is busy; retry the request");
			}
			if (isUniqueViolation(err)) {
				// Concurrent identical upload won the race.
				await dropBlob();
				const winner = await this.findDuplicate(db, opts.applicationId, opts.kind, opts.sha256);
				if (!winner) throw new HttpError(500, "INTERNAL_ERROR", "internal error");
				return this.replayOf(winner);
			}
			await dropBlob();
			throw new HttpError(500, "INTERNAL_ERROR", "internal error");
		}
		return { file: inserted, replayed: false, httpStatus: 201 };
	}

	private sanitizedFilename(raw: string | null): string | null {
		if (!raw) return null;
		const base = raw.split(/[\\/]/).pop() ?? "";
		const clean = [...base]
			.filter((ch) => {
				const code = ch.codePointAt(0) ?? 0;
				return code >= 0x20 && code !== 0x7f;
			})
			.join("")
			.trim()
			.slice(0, 255);
		return clean === "" ? null : clean;
	}

	async upload(input: UploadInput): Promise<UploadOutcome> {
		const config = this.deps.config;
		const keys = this.keys();
		const kind = parseKind(input.kind);
		const bytes = input.bytes;
		const sha256 = sha256Hex(bytes);

		// Identical replay first: no rescan, no second blob.
		const existing = await this.findDuplicate(this.deps.db, input.applicationId, kind, sha256);
		if (existing) return this.replayOf(existing);

		this.rateLimiter.check(input.applicationId);

		const failRow = async (errorCode: string, status: number): Promise<never> => {
			await this.finalize({
				applicationId: input.applicationId,
				userId: input.userId,
				kind,
				sha256,
				storageKey: null,
				build: (fileId, at) => ({
					id: fileId,
					applicationId: input.applicationId,
					kind,
					status: "rejected",
					ocrStatus: "failed",
					textLayerRisk: false,
					originalFilename: this.sanitizedFilename(input.originalFilename),
					mimeType: "application/octet-stream",
					sizeBytes: bytes.length,
					sha256,
					storageKey: null,
					encryptionNonce: null,
					encryptionTag: null,
					keyId: config.keyId,
					cryptoVersion: CRYPTO_VERSION,
					pageCount: 0,
					ocrConfidence: null,
					uploadedBy: input.userId,
					uploadedAt: at,
					retentionUntil: new Date(Date.now() + config.retentionDays * 86_400_000),
					errorCode,
					errorMessage: errorCode,
				}),
				pages: [],
				auditAction: "document.rejected",
				auditPayload: { kind, sizeBytes: bytes.length, errorCode },
			});
			throw new HttpError(status, errorCode, "document rejected");
		};

		try {
			assertSize(bytes, config.maxBytes);
		} catch (err) {
			const code = err instanceof HttpError ? err.code : "FILE_TOO_LARGE";
			const status = err instanceof HttpError ? err.status : 413;
			await failRow(code, status);
			throw new HttpError(500, "INTERNAL_ERROR", "internal error"); // unreachable
		}
		let detected: DetectedType;
		try {
			detected = assertDetectedType(bytes);
		} catch {
			await failRow("UNSUPPORTED_TYPE", 415);
			throw new HttpError(500, "INTERNAL_ERROR", "internal error"); // unreachable
		}

		// Scan + extraction share the single upload deadline (SPEC §6.3).
		let scanVerdict: "clean" | "infected";
		let extraction: PendingExtraction | null = null;
		try {
			const work = (async () => {
				const verdict = await this.deps.scanner.scan(bytes);
				// Infected files stop before extraction/encryption.
				if (verdict === "infected") return { verdict, extraction: null };
				if (kind === "id") return { verdict, extraction: null };
				if (!this.ocrSemaphore.tryAcquire()) {
					throw new HttpError(429, "OCR_BUSY", "text extraction is saturated; retry shortly");
				}
				try {
					const limits = this.ocrLimits();
					if (detected === "pdf") {
						const r = await this.deps.ocr.extractPdf(bytes, limits);
						return {
							verdict,
							extraction: {
								status: r.status,
								pages: r.pages.map((p) => ({
									...p,
									source: p.source as "pdf_text" | "ocr",
								})),
								textLayerRisk: r.textLayerRisk,
								pageCount: r.pageCount,
							},
						};
					}
					const r = await this.deps.ocr.extractImage(bytes, detected, limits);
					return {
						verdict,
						extraction: {
							status: r.status,
							pages: r.pages.map((p) => ({
								...p,
								source: p.source as "pdf_text" | "ocr",
							})),
							textLayerRisk: r.textLayerRisk,
							pageCount: r.pageCount,
						},
					};
				} catch (err) {
					if (err instanceof HttpError) throw err;
					if (err instanceof OcrFailed) {
						return {
							verdict,
							extraction: { status: "failed" as const, pages: [], textLayerRisk: false },
						};
					}
					throw err;
				} finally {
					this.ocrSemaphore.release();
				}
			})();
			let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
			const deadline = new Promise<never>((_, reject) => {
				deadlineTimer = setTimeout(() => reject(new UploadTimeout()), config.uploadDeadlineMs);
			});
			let done: { verdict: "clean" | "infected"; extraction: PendingExtraction | null };
			try {
				done = await Promise.race([work, deadline]);
			} finally {
				if (deadlineTimer) clearTimeout(deadlineTimer);
			}
			scanVerdict = done.verdict;
			extraction = done.extraction;
		} catch (err) {
			if (err instanceof ScannerUnavailable) throw mapUploadError(err);
			throw mapUploadError(err);
		}

		if (scanVerdict === "infected") {
			await this.finalize({
				applicationId: input.applicationId,
				userId: input.userId,
				kind,
				sha256,
				storageKey: null,
				build: (fileId, at) => ({
					id: fileId,
					applicationId: input.applicationId,
					kind,
					status: "rejected",
					ocrStatus: "failed",
					textLayerRisk: false,
					originalFilename: this.sanitizedFilename(input.originalFilename),
					mimeType: "application/octet-stream",
					sizeBytes: bytes.length,
					sha256,
					storageKey: null,
					encryptionNonce: null,
					encryptionTag: null,
					keyId: config.keyId,
					cryptoVersion: CRYPTO_VERSION,
					pageCount: 0,
					ocrConfidence: null,
					uploadedBy: input.userId,
					uploadedAt: at,
					retentionUntil: new Date(Date.now() + config.retentionDays * 86_400_000),
					errorCode: "MALWARE_DETECTED",
					errorMessage: "MALWARE_DETECTED",
				}),
				pages: [],
				auditAction: "document.rejected",
				auditPayload: { kind, sizeBytes: bytes.length, errorCode: "MALWARE_DETECTED" },
			});
			throw new HttpError(422, "MALWARE_DETECTED", "file failed the malware scan");
		}

		const ocrStatus =
			kind === "id"
				? ("not_applicable" as const)
				: extraction === null
					? ("unsupported" as const)
					: extraction.status;
		const pages =
			kind === "id"
				? []
				: (extraction?.pages ?? []).map((p, i) => ({ ...p, pageNumber: p.pageNumber ?? i + 1 }));
		const pageCount = kind === "id" ? 0 : (extraction?.pageCount ?? pages.length);
		const confidences = pages.map((p) => p.confidence);
		const ocrConfidence =
			pages.length === 0 ? null : confidences.reduce((a, b) => a + b, 0) / confidences.length;

		// Server-side statement dating from extracted page text (never
		// client-asserted): fresh/stale flows from periodEnd; unknown stays
		// a requirements blocker.
		const statementDates = extractStatementDates(
			kind,
			pages.map((p) => p.text),
		);

		// Encrypt after extraction; storage failure leaves no row.
		const fileId = randomUUID();
		const storageKey = storageKeyFor(input.applicationId, fileId);
		const activeKey = keys.get(config.keyId);
		if (!activeKey) {
			throw new HttpError(503, "ENCRYPTION_UNAVAILABLE", "document encryption is unavailable");
		}
		const encrypted = encryptDocument({
			plaintext: bytes,
			fileId,
			applicationId: input.applicationId,
			key: activeKey,
			keyId: config.keyId,
		});
		try {
			await ensureStorageDir(config.storageDir);
			await writeEncryptedFile(config.storageDir, storageKey, encrypted.ciphertext);
		} catch {
			throw new HttpError(500, "STORAGE_FAILED", "document storage failed");
		}

		return this.finalize({
			applicationId: input.applicationId,
			userId: input.userId,
			kind,
			sha256,
			storageKey,
			build: (_id, at) => ({
				id: fileId,
				applicationId: input.applicationId,
				kind,
				status: "ready",
				ocrStatus,
				textLayerRisk: extraction?.textLayerRisk ?? false,
				originalFilename: this.sanitizedFilename(input.originalFilename),
				mimeType: mimeForType(detected),
				sizeBytes: bytes.length,
				sha256,
				storageKey,
				encryptionNonce: encrypted.nonceB64,
				encryptionTag: encrypted.tagB64,
				keyId: config.keyId,
				cryptoVersion: CRYPTO_VERSION,
				pageCount,
				ocrConfidence,
				uploadedBy: input.userId,
				uploadedAt: at,
				retentionUntil: new Date(Date.now() + config.retentionDays * 86_400_000),
				errorCode: null,
				errorMessage: null,
				periodEnd: statementDates.periodEnd,
				documentDate: statementDates.documentDate,
				documentDateSource: statementDates.dateSource,
			}),
			pages,
			auditAction: "document.uploaded",
			auditPayload: {
				kind,
				sizeBytes: bytes.length,
				pageCount,
				ocrStatus,
			},
		});
	}

	// --- Readers (routes enforce access + audit) ---

	async listFiles(applicationId: string): Promise<DocumentFileRow[]> {
		return this.deps.db
			.select()
			.from(documentFiles)
			.where(
				and(
					eq(documentFiles.applicationId, applicationId),
					sql`${documentFiles.status} != 'deleted'`,
				),
			);
	}

	async getFile(applicationId: string, fileId: string): Promise<DocumentFileRow | null> {
		const rows = await this.deps.db
			.select()
			.from(documentFiles)
			.where(
				and(
					eq(documentFiles.id, fileId),
					eq(documentFiles.applicationId, applicationId),
					sql`${documentFiles.status} != 'deleted'`,
				),
			)
			.limit(1);
		return rows[0] ?? null;
	}

	async getPages(fileId: string): Promise<DocumentPageRow[]> {
		return this.deps.db
			.select()
			.from(documentPages)
			.where(eq(documentPages.documentFileId, fileId))
			.orderBy(documentPages.pageNumber);
	}

	/** Decrypt + hash-verify the stored blob (fail closed on any mismatch). */
	async openOriginal(file: DocumentFileRow): Promise<Buffer> {
		if (!file.storageKey || !file.encryptionNonce || !file.encryptionTag) {
			throw new HttpError(404, "NOT_FOUND", "not found");
		}
		try {
			return await openAndVerifyBlob({
				root: this.deps.config.storageDir,
				storageKey: file.storageKey,
				nonceB64: file.encryptionNonce,
				tagB64: file.encryptionTag,
				fileId: file.id,
				applicationId: file.applicationId,
				cryptoVersion: file.cryptoVersion,
				keyId: file.keyId,
				keys: this.keys(),
				expectedSha256: file.sha256,
			});
		} catch {
			throw new HttpError(500, "STORAGE_FAILED", "document storage failed");
		}
	}

	// --- Retry OCR (D1a): only ready + failed/unsupported, per-file lock ---

	async retryOcr(input: { applicationId: string; fileId: string; userId: string }): Promise<{
		file: DocumentFileRow;
	}> {
		const { db, config } = this.deps;
		const file = await this.getFile(input.applicationId, input.fileId);
		if (!file) throw new HttpError(404, "NOT_FOUND", "not found");
		if (
			file.status !== "ready" ||
			(file.ocrStatus !== "failed" && file.ocrStatus !== "unsupported")
		) {
			throw new HttpError(
				409,
				"OCR_NOT_RETRYABLE",
				"only failed or unsupported extractions can retry",
			);
		}
		if (this.retryLocks.has(file.id)) {
			throw new HttpError(429, "OCR_BUSY", "a retry is already running for this file");
		}
		this.keys(); // Fail closed before touching the blob.
		this.retryLocks.add(file.id);
		try {
			const plaintext = await this.openOriginal(file);
			const detected = assertDetectedType(plaintext);
			if (!this.ocrSemaphore.tryAcquire()) {
				throw new HttpError(429, "OCR_BUSY", "text extraction is saturated; retry shortly");
			}
			let extraction: PendingExtraction;
			try {
				const limits = this.ocrLimits();
				const work =
					detected === "pdf"
						? this.deps.ocr.extractPdf(plaintext, limits)
						: this.deps.ocr.extractImage(plaintext, detected, limits);
				let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
				const deadline = new Promise<never>((_, reject) => {
					deadlineTimer = setTimeout(() => reject(new UploadTimeout()), config.uploadDeadlineMs);
				});
				let r: Awaited<typeof work>;
				try {
					r = await Promise.race([work, deadline]);
				} finally {
					if (deadlineTimer) clearTimeout(deadlineTimer);
				}
				extraction = {
					status: r.status,
					pages: r.pages.map((p) => ({
						...p,
						source: p.source as "pdf_text" | "ocr",
					})),
					textLayerRisk: r.textLayerRisk,
					pageCount: r.pageCount,
				};
			} catch (err) {
				if (err instanceof HttpError) throw err;
				if (err instanceof OcrFailed || err instanceof UploadTimeout) {
					extraction = { status: "failed", pages: [], textLayerRisk: false };
				} else {
					throw err;
				}
			} finally {
				this.ocrSemaphore.release();
			}
			const pages = extraction.pages.map((p, i) => ({
				...p,
				pageNumber: p.pageNumber ?? i + 1,
			}));
			const pageCount = extraction.pageCount ?? pages.length;
			const updated = await withTx(db, async (tx) => {
				await lockApplication(tx, input.applicationId, this.deps.config.lockTimeoutMs);
				const apps = await tx
					.select()
					.from(applications)
					.where(eq(applications.id, input.applicationId));
				if (!apps[0]?.documentProcessingConsent) {
					throw new HttpError(403, "CONSENT_REQUIRED", "document processing consent is required");
				}
				// Re-read under the shared lock: retention may have tombstoned
				// the file while OCR was running outside the transaction.
				const locked = await tx
					.select()
					.from(documentFiles)
					.where(eq(documentFiles.id, file.id))
					.for("update");
				const fresh = locked[0];
				if (
					!fresh ||
					fresh.status !== "ready" ||
					(fresh.ocrStatus !== "failed" && fresh.ocrStatus !== "unsupported") ||
					fresh.blobPurgedAt !== null
				) {
					throw new HttpError(
						409,
						"OCR_NOT_RETRYABLE",
						"the document changed while text extraction was running",
					);
				}
				const confidences = pages.map((p) => p.confidence);
				const [row] = await tx
					.update(documentFiles)
					.set({
						ocrStatus: extraction.status,
						textLayerRisk: extraction.textLayerRisk,
						pageCount,
						ocrConfidence:
							pages.length === 0
								? null
								: confidences.reduce((a, b) => a + b, 0) / confidences.length,
						errorCode: null,
						errorMessage: null,
					})
					.where(eq(documentFiles.id, file.id))
					.returning();
				await tx.delete(documentPages).where(eq(documentPages.documentFileId, file.id));
				if (pages.length > 0) {
					await tx.insert(documentPages).values(
						pages.map((p) => ({
							documentFileId: file.id,
							pageNumber: p.pageNumber,
							text: p.text,
							textSource: p.source,
							confidence: p.confidence,
							textSha256: sha256Hex(Buffer.from(p.text, "utf8")),
						})),
					);
				}
				// A retry can change page text; old citations must not survive.
				const stale = await tx
					.select({ id: documentFindings.id, crosscheckId: documentFindings.crosscheckId })
					.from(documentFindings)
					.where(eq(documentFindings.documentFileId, file.id));
				if (stale.length > 0) {
					const staleIds = stale.map((s) => s.id);
					const links = await tx
						.select({ chaseRequestId: chaseRequestFindings.chaseRequestId })
						.from(chaseRequestFindings)
						.where(inArray(chaseRequestFindings.findingId, staleIds));
					const chaseIds = [...new Set(links.map((l) => l.chaseRequestId))];
					await tx
						.delete(chaseRequestFindings)
						.where(inArray(chaseRequestFindings.findingId, staleIds));
					if (chaseIds.length > 0) {
						await tx
							.update(chaseRequests)
							.set({ body: null, redactedAt: new Date() })
							.where(inArray(chaseRequests.id, chaseIds));
					}
					await tx.delete(documentFindings).where(eq(documentFindings.documentFileId, file.id));
					await tx
						.update(documentCrosschecks)
						.set({ status: "redacted", findingCount: 0 })
						.where(inArray(documentCrosschecks.id, [...new Set(stale.map((s) => s.crosscheckId))]));
				}
				await writeAudit(tx, {
					applicationId: input.applicationId,
					actor: input.userId,
					action: "document.retry_ocr",
					entity: "document_file",
					payload: {
						documentFileId: file.id,
						ocrStatus: extraction.status,
						pageCount,
					},
				});
				return row;
			});
			if (!updated) throw new HttpError(500, "INTERNAL_ERROR", "internal error");
			return { file: updated };
		} catch (err) {
			throw mapUploadError(err);
		} finally {
			this.retryLocks.delete(file.id);
		}
	}
}

// --- Orphan sweep (D1b seam): `.enc` files with no DB row older than
// deadline+10min, plus temp files older than 1h. Row rechecked under the
// per-application lock before unlinking. ---

export interface SweepResult {
	checked: number;
	removedBlobs: number;
	removedTemps: number;
}

export async function sweepDocumentOrphans(
	db: Db,
	root: string,
	opts: { deadlineMs: number; now?: number },
): Promise<SweepResult> {
	const now = opts.now ?? Date.now();
	const blobMinAge = opts.deadlineMs + 10 * 60_000;
	const tmpMinAge = 60 * 60_000;
	const result: SweepResult = { checked: 0, removedBlobs: 0, removedTemps: 0 };
	let entries: Array<{ name: string; mtime: number; isDir: boolean }>;
	try {
		const names = await fs.readdir(root);
		entries = [];
		for (const name of names) {
			const st = await fs.stat(path.join(root, name)).catch(() => null);
			if (!st) continue;
			entries.push({ name, mtime: st.mtimeMs, isDir: st.isDirectory() });
		}
	} catch {
		return result;
	}
	for (const entry of entries) {
		if (entry.isDir) {
			// `<applicationId>/` shard: scan one level deep.
			const shard = path.join(root, entry.name);
			let inner: string[];
			try {
				inner = await fs.readdir(shard);
			} catch {
				continue;
			}
			for (const name of inner) {
				result.checked++;
				const full = path.join(shard, name);
				const st = await fs.stat(full).catch(() => null);
				if (!st || st.isDirectory()) continue;
				if (name.includes(".tmp-")) {
					if (now - st.mtimeMs > tmpMinAge) {
						await fs.unlink(full).catch(() => {});
						result.removedTemps++;
					}
					continue;
				}
				if (!name.endsWith(".enc")) continue;
				if (now - st.mtimeMs <= blobMinAge) continue;
				const fileId = name.slice(0, -".enc".length);
				const rows = await db
					.select({ id: documentFiles.id })
					.from(documentFiles)
					.where(and(eq(documentFiles.applicationId, entry.name), eq(documentFiles.id, fileId)))
					.limit(1)
					.catch(() => []);
				if (rows.length === 0) {
					// Recheck under the application lock before unlinking.
					const stillOrphan = await withTx(db, async (tx) => {
						await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${entry.name}))`);
						const again = await tx
							.select({ id: documentFiles.id })
							.from(documentFiles)
							.where(and(eq(documentFiles.applicationId, entry.name), eq(documentFiles.id, fileId)))
							.limit(1);
						if (again.length > 0) return false;
						await fs.unlink(full).catch(() => {});
						return true;
					}).catch(() => false);
					if (stillOrphan) result.removedBlobs++;
				}
			}
			continue;
		}
		// Legacy flat temp files at the root.
		if (entry.name.includes(".tmp-") && now - entry.mtime > tmpMinAge) {
			await fs.unlink(path.join(root, entry.name)).catch(() => {});
			result.removedTemps++;
		}
	}
	return result;
}

/** Production factory: real ClamAV scanner + real OCR adapters. Scanner
 * misconfiguration never throws here (service boots; uploads fail closed). */
export function buildDocumentService(
	db: Db,
	config: DocumentsConfig,
	overrides: DocumentAdapters = {},
): DocumentService {
	let scanner: ScannerAdapter;
	try {
		scanner =
			overrides.scanner ??
			resolveScanner({
				mode: config.scanner,
				host: config.clamavHost,
				port: config.clamavPort,
				timeoutMs: config.scanTimeoutMs,
			});
	} catch (err) {
		const failure = err instanceof Error ? err : new ScannerUnavailable();
		scanner = {
			async scan(_bytes: Buffer) {
				throw failure;
			},
		};
	}
	const ocr =
		overrides.ocr ??
		createOcrAdapter({ dataDir: config.ocrDataDir, timeoutMs: config.ocrTimeoutMs });
	return new DocumentService({ db, config, scanner, ocr });
}
