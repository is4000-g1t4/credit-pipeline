// T17 customer evidence service (SPEC-t17-t18 §2.2): the trusted loader
// (tests + future `demo:seed`; no client upload route in D1) and owner-only
// copy-on-attach reuse into application `document_files`.
//
// Loader writes through the customer crypto/root only: encrypted bytes under
// CUSTOMER_STORAGE_DIR with customer AAD, `scan_status=clean` for checked-in
// synthetic fixtures, server-derived dates with future/inconsistent dates
// rejected. Reuse copies bytes into a NEW app-scoped blob (app AAD/root,
// fresh retention) with provenance (`source=customer_reuse`,
// `reused_from_customer_document_id`); the source row is never mutated.
import { randomUUID } from "node:crypto";
import {
	applicationProfileConfirmations,
	applications,
	customerDocumentPages,
	customerDocuments,
	customerProfiles,
	documentFiles,
	documentPages,
	withTx,
	type Db,
	type Tx,
} from "@credit/db/applications";
import { HttpError, writeAudit } from "@credit/service-kit";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
	CRYPTO_VERSION,
	customerStorageKeyFor,
	decryptCustomerDocument,
	encryptCustomerDocument,
	parseEncryptionKey,
	parsePreviousKeys,
	sha256Hex,
} from "./crypto.js";
import { lockApplication } from "../documents/access.js";
import { isUuid } from "../ids.js";
import { encryptDocument } from "../documents/crypto.js";
import { parseKind, type DocumentKind } from "../documents/pipeline.js";
import {
	deleteBlob,
	ensureStorageDir,
	readEncryptedFile,
	storageKeyFor,
	writeEncryptedFile,
} from "../documents/storage.js";
import { classifyCustomerDoc, statementFreshness } from "./requirements.js";

export interface CustomerConfig {
	storageDir: string;
	encryptionKey: string | undefined;
	keyId: string;
	previousKeys: string | undefined;
	retentionDays: number;
	lockTimeoutMs: number;
}

export type CustomerDocumentRow = typeof customerDocuments.$inferSelect;
export type CustomerProfileRow = typeof customerProfiles.$inferSelect;

function customerKeys(config: CustomerConfig): Map<string, Buffer> {
	let active: Buffer;
	try {
		active = parseEncryptionKey(config.encryptionKey);
	} catch {
		throw new HttpError(503, "ENCRYPTION_UNAVAILABLE", "customer encryption is unavailable");
	}
	let previous: Map<string, Buffer>;
	try {
		previous = parsePreviousKeys(config.previousKeys);
	} catch {
		throw new HttpError(503, "ENCRYPTION_UNAVAILABLE", "customer encryption is unavailable");
	}
	previous.set(config.keyId, active);
	return previous;
}

function lockCustomer(tx: Tx, customerId: string, lockTimeoutMs: number): Promise<void> {
	return lockApplication(tx, `customer:${customerId}`, lockTimeoutMs);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface CustomerEvidenceInput {
	customerId: string;
	kind: string;
	bytes: Buffer;
	mimeType?: string;
	originalFilename?: string | null;
	documentDate?: string | null;
	periodEnd?: string | null;
	pages?: Array<{ text: string; source: "pdf_text" | "ocr"; confidence: number }>;
	source?: "demo_seed" | "customer_master";
	fixtureKey?: string | null;
	/** Clock the dates are validated against (fixture loader passes asOf). */
	asOf?: Date;
	retentionDays?: number;
}

/** Trusted loader: encrypt + store + persist one customer evidence row with
 * pages. Future dates and document_date-before-period_end are rejected; a
 * null date stays unknown (never fresh) for the requirements engine. */
export async function createCustomerDocument(
	db: Db,
	config: CustomerConfig,
	input: CustomerEvidenceInput,
): Promise<CustomerDocumentRow> {
	const kind = parseKind(input.kind);
	if (input.bytes.length === 0) throw new HttpError(400, "EMPTY_FILE", "file must not be empty");
	const asOf = input.asOf ?? new Date();
	for (const [name, value] of [
		["documentDate", input.documentDate],
		["periodEnd", input.periodEnd],
	] as const) {
		if (value === undefined || value === null) continue;
		if (!DATE_RE.test(value))
			throw new HttpError(422, "INVALID_DATE", `${name} must be YYYY-MM-DD`);
		if (new Date(`${value}T00:00:00Z`).getTime() > asOf.getTime()) {
			throw new HttpError(422, "FUTURE_DATE", `${name} must not be after as-of`);
		}
	}
	if (input.documentDate && input.periodEnd && input.documentDate < input.periodEnd) {
		throw new HttpError(422, "INCONSISTENT_DATES", "document_date must not precede period_end");
	}
	const keys = customerKeys(config);
	const active = keys.get(config.keyId);
	if (!active)
		throw new HttpError(503, "ENCRYPTION_UNAVAILABLE", "customer encryption is unavailable");

	const sha256 = sha256Hex(input.bytes);
	const documentId = randomUUID();
	const storageKey = customerStorageKeyFor(input.customerId, documentId);
	const encrypted = encryptCustomerDocument({
		plaintext: input.bytes,
		customerDocumentId: documentId,
		customerId: input.customerId,
		key: active,
		keyId: config.keyId,
	});
	try {
		await ensureStorageDir(config.storageDir);
		await writeEncryptedFile(config.storageDir, storageKey, encrypted.ciphertext);
	} catch {
		throw new HttpError(500, "STORAGE_FAILED", "customer storage failed");
	}
	const now = new Date();
	const retentionDays = input.retentionDays ?? config.retentionDays;
	const pages = input.pages ?? [];
	try {
		return await withTx(db, async (tx) => {
			const [row] = await tx
				.insert(customerDocuments)
				.values({
					id: documentId,
					customerId: input.customerId,
					fixtureKey: input.fixtureKey ?? null,
					kind,
					status: "ready",
					scanStatus: "clean",
					scannedAt: now,
					originalFilename: input.originalFilename ?? null,
					mimeType: input.mimeType ?? "application/pdf",
					sizeBytes: input.bytes.length,
					sha256,
					storageKey,
					encryptionNonce: encrypted.nonceB64,
					encryptionTag: encrypted.tagB64,
					keyId: config.keyId,
					cryptoVersion: CRYPTO_VERSION,
					pageCount: pages.length,
					ocrStatus: pages.length > 0 ? "ready" : "not_applicable",
					ocrConfidence:
						pages.length === 0 ? null : pages.reduce((a, p) => a + p.confidence, 0) / pages.length,
					textLayerRisk: false,
					documentDate: input.documentDate ?? null,
					periodEnd: input.periodEnd ?? null,
					uploadedAt: now,
					retentionUntil: new Date(now.getTime() + retentionDays * 86_400_000),
					source: input.source ?? "customer_master",
				})
				.returning();
			if (pages.length > 0) {
				await tx.insert(customerDocumentPages).values(
					pages.map((p, i) => ({
						customerDocumentId: row.id,
						pageNumber: i + 1,
						text: p.text,
						textSource: p.source,
						confidence: p.confidence,
						textSha256: sha256Hex(Buffer.from(p.text, "utf8")),
					})),
				);
			}
			return row;
		});
	} catch (err) {
		await deleteBlob(config.storageDir, storageKey);
		throw err;
	}
}

/** Read helper for tests/future seed: decrypt (customer AAD) + hash-verify,
 * fail closed on any mismatch. */
export async function openCustomerDocument(
	config: CustomerConfig,
	doc: CustomerDocumentRow,
): Promise<Buffer> {
	if (!doc.storageKey || !doc.encryptionNonce || !doc.encryptionTag) {
		throw new HttpError(404, "NOT_FOUND", "not found");
	}
	try {
		const ciphertext = await readEncryptedFile(config.storageDir, doc.storageKey);
		const plaintext = decryptCustomerDocument({
			ciphertext,
			nonceB64: doc.encryptionNonce,
			tagB64: doc.encryptionTag,
			customerDocumentId: doc.id,
			customerId: doc.customerId,
			cryptoVersion: doc.cryptoVersion,
			keyId: doc.keyId,
			keys: customerKeys(config),
		});
		if (sha256Hex(plaintext) !== doc.sha256) throw new Error("hash mismatch");
		return plaintext;
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw new HttpError(500, "STORAGE_FAILED", "customer storage failed");
	}
}

/**
 * Convergence repair for fixture-owned rows whose ciphertext is gone
 * (wiped storage root): when the blob no longer opens, rewrite it in place
 * — same ids/AAD, fresh nonce under the active key. Returns true when it
 * restored. Throws when the row has no storage key or the key is
 * unavailable. References never break (no row is recreated).
 */
export async function restoreCustomerBlob(
	db: Db,
	config: CustomerConfig,
	doc: CustomerDocumentRow,
	plaintext: Buffer,
): Promise<boolean> {
	try {
		await openCustomerDocument(config, doc);
		return false;
	} catch {
		// Fall through to the in-place restore below.
	}
	if (!doc.storageKey) {
		throw new HttpError(500, "STORAGE_FAILED", "customer evidence has no storage key");
	}
	const keys = customerKeys(config);
	const active = keys.get(config.keyId);
	if (!active) {
		throw new HttpError(503, "ENCRYPTION_UNAVAILABLE", "customer encryption is unavailable");
	}
	const encrypted = encryptCustomerDocument({
		plaintext,
		customerDocumentId: doc.id,
		customerId: doc.customerId,
		key: active,
		keyId: config.keyId,
	});
	try {
		await ensureStorageDir(config.storageDir);
		await writeEncryptedFile(config.storageDir, doc.storageKey, encrypted.ciphertext);
	} catch {
		throw new HttpError(500, "STORAGE_FAILED", "customer storage failed");
	}
	await db
		.update(customerDocuments)
		.set({
			encryptionNonce: encrypted.nonceB64,
			encryptionTag: encrypted.tagB64,
			keyId: config.keyId,
			cryptoVersion: encrypted.cryptoVersion,
		})
		.where(eq(customerDocuments.id, doc.id));
	return true;
}

export async function getCustomerProfile(
	db: Db,
	userId: string,
): Promise<CustomerProfileRow | null> {
	const rows = await db.select().from(customerProfiles).where(eq(customerProfiles.userId, userId));
	return rows[0] ?? null;
}

/** Metadata only — never storage keys, nonces, tags, or page text. */
export function presentCustomerDocument(
	doc: CustomerDocumentRow,
	asOf: Date,
): Record<string, unknown> {
	const eligibility = classifyCustomerDoc(
		{
			id: doc.id,
			kind: doc.kind,
			status: doc.status,
			scanStatus: doc.scanStatus,
			retentionUntil: doc.retentionUntil,
			blobPurgedAt: doc.blobPurgedAt,
			periodEnd: doc.periodEnd,
			documentDate: doc.documentDate,
		},
		asOf,
	);
	return {
		id: doc.id,
		kind: doc.kind,
		status: doc.status,
		scanStatus: doc.scanStatus,
		mimeType: doc.mimeType,
		sizeBytes: doc.sizeBytes,
		sha256: doc.sha256,
		pageCount: doc.pageCount,
		ocrStatus: doc.ocrStatus,
		ocrConfidence: doc.ocrConfidence,
		documentDate: doc.documentDate,
		periodEnd: doc.periodEnd,
		freshness: statementFreshness(doc.kind, doc.periodEnd, asOf),
		reusable: eligibility.eligible,
		reuseReason: eligibility.eligible ? null : (eligibility.reason ?? "ineligible"),
		retentionUntil: doc.retentionUntil.toISOString(),
		uploadedAt: doc.uploadedAt.toISOString(),
	};
}

// --- Copy-on-attach reuse (SPEC §2.3). Bounded: max 10 documents / 25 MB
// per request, one transaction. Per-doc outcome: an existing ready app row
// with the same (application, kind, sha256) replays; an existing rejected
// row 422s (reuse never resurrects it). ---

export const REUSE_MAX_DOCS = 10;
export const REUSE_MAX_BYTES = 25 * 1024 * 1024;

export interface ReuseInput {
	applicationId: string;
	userId: string;
	customerDocumentIds: string[];
	kindFilter?: DocumentKind;
	asOf: Date;
	appRetentionDays: number;
}

export interface ReuseOutcome {
	files: Array<Record<string, unknown>>;
	created: boolean;
}

function presentAppFile(row: typeof documentFiles.$inferSelect): Record<string, unknown> {
	return {
		id: row.id,
		applicationId: row.applicationId,
		kind: row.kind,
		status: row.status,
		ocrStatus: row.ocrStatus,
		mimeType: row.mimeType,
		sizeBytes: row.sizeBytes,
		sha256: row.sha256,
		pageCount: row.pageCount,
		ocrConfidence: row.ocrConfidence,
		source: row.source,
		reusedFromCustomerDocumentId: row.reusedFromCustomerDocumentId,
		documentDate: row.documentDate,
		periodEnd: row.periodEnd,
		uploadedAt: row.uploadedAt.toISOString(),
		retentionUntil: row.retentionUntil.toISOString(),
	};
}

function reuseError(docId: string, reason: string): HttpError {
	switch (reason) {
		case "rejected":
			return new HttpError(422, "REJECTED_EVIDENCE", `customer evidence ${docId} is rejected`);
		case "stale":
			return new HttpError(409, "STALE_EVIDENCE", `customer evidence ${docId} is stale`);
		case "expired":
			return new HttpError(409, "EXPIRED_EVIDENCE", `customer evidence ${docId} is expired`);
		default:
			return new HttpError(
				409,
				"UNKNOWN_EVIDENCE_DATE",
				`customer evidence ${docId} has no usable date`,
			);
	}
}

export async function reuseCustomerDocuments(
	db: Db,
	appConfig: {
		storageDir: string;
		encryptionKey: string | undefined;
		keyId: string;
		previousKeys: string | undefined;
		lockTimeoutMs: number;
	},
	customerConfig: CustomerConfig,
	input: ReuseInput,
): Promise<ReuseOutcome> {
	const ids = [...new Set(input.customerDocumentIds)];
	if (ids.length === 0 || ids.length > REUSE_MAX_DOCS) {
		throw new HttpError(400, "INVALID_REUSE", `select 1–${REUSE_MAX_DOCS} customer documents`);
	}
	for (const id of ids) {
		if (!isUuid(id)) throw new HttpError(404, "NOT_FOUND", "not found");
	}

	const appRows = await db
		.select()
		.from(applications)
		.where(eq(applications.id, input.applicationId));
	const app = appRows[0];
	if (!app || app.applicantUserId !== input.userId) {
		throw new HttpError(404, "NOT_FOUND", "not found");
	}
	if (!app.documentProcessingConsent) {
		throw new HttpError(403, "CONSENT_REQUIRED", "document processing consent is required");
	}
	const profile = await getCustomerProfile(db, input.userId);
	if (!profile) throw new HttpError(404, "NOT_FOUND", "not found");
	const sourceRows = await db
		.select()
		.from(customerDocuments)
		.where(inArray(customerDocuments.id, ids));
	if (sourceRows.length !== ids.length) throw new HttpError(404, "NOT_FOUND", "not found");
	for (const doc of sourceRows) {
		if (doc.customerId !== profile.id) throw new HttpError(404, "NOT_FOUND", "not found");
		if (input.kindFilter && doc.kind !== input.kindFilter) {
			throw new HttpError(422, "KIND_MISMATCH", "selected evidence must match the kind filter");
		}
		const eligibility = classifyCustomerDoc(
			{
				id: doc.id,
				kind: doc.kind,
				status: doc.status,
				scanStatus: doc.scanStatus,
				retentionUntil: doc.retentionUntil,
				blobPurgedAt: doc.blobPurgedAt,
				periodEnd: doc.periodEnd,
				documentDate: doc.documentDate,
			},
			input.asOf,
		);
		if (!eligibility.eligible) throw reuseError(doc.id, eligibility.reason ?? "ineligible");
	}
	const totalBytes = sourceRows.reduce((a, d) => a + d.sizeBytes, 0);
	if (totalBytes > REUSE_MAX_BYTES) {
		throw new HttpError(413, "REUSE_TOO_LARGE", "selected evidence exceeds the 25 MB reuse limit");
	}

	// Plaintext + app blobs are prepared before the transaction (same
	// ordering as T01 upload: crypto/IO first, one terminal tx last).
	let appKey: Buffer;
	try {
		appKey = parseEncryptionKey(appConfig.encryptionKey);
	} catch {
		throw new HttpError(503, "ENCRYPTION_UNAVAILABLE", "document encryption is unavailable");
	}
	const prepared: Array<{
		source: CustomerDocumentRow;
		plaintext: Buffer;
		fileId: string;
		storageKey: string;
		nonceB64: string;
		tagB64: string;
	}> = [];
	try {
		await ensureStorageDir(appConfig.storageDir);
		for (const doc of sourceRows) {
			const plaintext = await openCustomerDocument(customerConfig, doc);
			const fileId = randomUUID();
			const storageKey = storageKeyFor(input.applicationId, fileId);
			const encrypted = encryptDocument({
				plaintext,
				fileId,
				applicationId: input.applicationId,
				key: appKey,
				keyId: appConfig.keyId,
			});
			await writeEncryptedFile(appConfig.storageDir, storageKey, encrypted.ciphertext);
			prepared.push({
				source: doc,
				plaintext,
				fileId,
				storageKey,
				nonceB64: encrypted.nonceB64,
				tagB64: encrypted.tagB64,
			});
		}
	} catch (err) {
		for (const p of prepared) await deleteBlob(appConfig.storageDir, p.storageKey);
		throw err instanceof HttpError ? err : new HttpError(500, "STORAGE_FAILED", "reuse failed");
	}

	let files: Array<typeof documentFiles.$inferSelect> = [];
	let created = false;
	try {
		files = await withTx(db, async (tx) => {
			// Customer lock first, then the application lock (fixed order —
			// the only path taking both), so the D2 customer sweep can never
			// purge mid-copy. Eligibility + blob presence are rechecked here.
			await lockCustomer(tx, profile.id, customerConfig.lockTimeoutMs);
			await lockApplication(tx, input.applicationId, appConfig.lockTimeoutMs);
			// Authoritative application re-read under the lock: ownership,
			// document-processing consent, and draft/submitted status are
			// re-verified here, so a concurrent consent withdrawal (or a
			// decide racing reuse) between the pre-read above and this
			// transaction cannot slip a copy in.
			const lockedApps = await tx
				.select()
				.from(applications)
				.where(eq(applications.id, input.applicationId))
				.for("update");
			const locked = lockedApps[0];
			if (!locked || locked.applicantUserId !== input.userId) {
				throw new HttpError(404, "NOT_FOUND", "not found");
			}
			if (!locked.documentProcessingConsent) {
				throw new HttpError(403, "CONSENT_REQUIRED", "document processing consent is required");
			}
			if (locked.status !== "draft" && locked.status !== "submitted") {
				throw new HttpError(
					409,
					"APPLICATION_NOT_REUSABLE",
					"evidence can only be attached to a draft or submitted application",
				);
			}
			const fresh = await tx
				.select()
				.from(customerDocuments)
				.where(inArray(customerDocuments.id, ids));
			if (fresh.length !== ids.length) throw new HttpError(404, "NOT_FOUND", "not found");
			for (const doc of fresh) {
				if (doc.customerId !== profile.id) throw new HttpError(404, "NOT_FOUND", "not found");
				const eligibility = classifyCustomerDoc(
					{
						id: doc.id,
						kind: doc.kind,
						status: doc.status,
						scanStatus: doc.scanStatus,
						retentionUntil: doc.retentionUntil,
						blobPurgedAt: doc.blobPurgedAt,
						periodEnd: doc.periodEnd,
						documentDate: doc.documentDate,
					},
					input.asOf,
				);
				if (!eligibility.eligible) throw reuseError(doc.id, eligibility.reason ?? "ineligible");
			}
			const out: Array<typeof documentFiles.$inferSelect> = [];
			const now = new Date();
			for (const p of prepared) {
				const existing = await tx
					.select()
					.from(documentFiles)
					.where(
						and(
							eq(documentFiles.applicationId, input.applicationId),
							eq(documentFiles.kind, p.source.kind),
							eq(documentFiles.sha256, p.source.sha256),
							sql`${documentFiles.status} != 'deleted'`,
						),
					)
					.limit(1);
				const winner = existing[0];
				if (winner) {
					if (winner.status !== "ready") {
						throw new HttpError(
							422,
							winner.errorCode ?? "DOCUMENT_REJECTED",
							"this file was already rejected",
						);
					}
					out.push(winner);
					await deleteBlob(appConfig.storageDir, p.storageKey);
					continue;
				}
				const [inserted] = await tx
					.insert(documentFiles)
					.values({
						id: p.fileId,
						applicationId: input.applicationId,
						kind: p.source.kind,
						status: "ready",
						ocrStatus: p.source.ocrStatus,
						textLayerRisk: p.source.textLayerRisk,
						originalFilename: null,
						mimeType: p.source.mimeType,
						sizeBytes: p.source.sizeBytes,
						sha256: p.source.sha256,
						storageKey: p.storageKey,
						encryptionNonce: p.nonceB64,
						encryptionTag: p.tagB64,
						keyId: appConfig.keyId,
						cryptoVersion: CRYPTO_VERSION,
						pageCount: p.source.pageCount,
						ocrConfidence: p.source.ocrConfidence,
						uploadedBy: input.userId,
						uploadedAt: now,
						retentionUntil: new Date(now.getTime() + input.appRetentionDays * 86_400_000),
						source: "customer_reuse",
						reusedFromCustomerDocumentId: p.source.id,
						documentDate: p.source.documentDate,
						periodEnd: p.source.periodEnd,
						documentDateSource: "reused",
					})
					.returning();
				const sourcePages = await tx
					.select()
					.from(customerDocumentPages)
					.where(eq(customerDocumentPages.customerDocumentId, p.source.id));
				if (sourcePages.length > 0) {
					await tx.insert(documentPages).values(
						sourcePages.map((sp) => ({
							documentFileId: inserted.id,
							pageNumber: sp.pageNumber,
							text: sp.text,
							textSource: sp.textSource,
							confidence: sp.confidence,
							textSha256: sp.textSha256,
						})),
					);
				}
				await writeAudit(tx, {
					applicationId: input.applicationId,
					actor: input.userId,
					action: "document.reused",
					entity: "document_file",
					payload: {
						documentFileId: inserted.id,
						customerDocumentId: p.source.id,
						kind: p.source.kind,
					},
				});
				out.push(inserted);
				created = true;
			}
			return out;
		});
	} catch (err) {
		// The transaction rolled back as a unit: none of the prepared blobs
		// is referenced (replay winners were already unlinked in-loop, and a
		// second unlink is harmless best-effort).
		for (const p of prepared) await deleteBlob(appConfig.storageDir, p.storageKey);
		throw err;
	}
	return { files: files.map(presentAppFile), created };
}

export async function readConfirmations(db: Db, applicationId: string): Promise<string[]> {
	const rows = await db
		.select({ field: applicationProfileConfirmations.field })
		.from(applicationProfileConfirmations)
		.where(eq(applicationProfileConfirmations.applicationId, applicationId));
	return rows.map((r) => r.field);
}
