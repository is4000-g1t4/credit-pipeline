// T01 retention + legal hold (SPEC-t01-t02 §6/§8, D1b): daily/boot sweep
// that tombstones expired files transactionally under the per-application
// advisory lock, plus service-only hold create/release on the same lock.
//
// Per expired file the transaction rechecks holds, deletes pages + findings
// + chase links, nulls chase bodies (redacted_at), marks affected
// crosschecks `redacted` with finding_count=0 (crosscheck rows are NEVER
// deleted — chase_requests FKs them with RESTRICT), nulls filename/error
// fields, and sets status='deleted'. Blob bytes are purged AFTER commit;
// a failed purge leaves blob_purged_at NULL so the next sweep retries.
//
// D2 seam: crosscheck/chase tables already exist (D0 schema); when a file
// has no findings/links the sweep is a no-op for those tables.
import {
	applications,
	chaseRequestFindings,
	chaseRequests,
	documentConsistencyCandidates,
	documentCrosschecks,
	documentFieldCandidates,
	documentFiles,
	documentFindings,
	documentFingerprints,
	documentLegalHolds,
	documentPages,
	fraudReviews,
	generatedArtifacts,
	withTx,
	type Db,
} from "@credit/db/applications";
import { writeAudit, HttpError, type Logger } from "@credit/service-kit";
import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { lockApplication } from "./access.js";
import { sweepDocumentOrphans, type SweepResult } from "./service.js";
import { deleteBlob, purgeBlob } from "./storage.js";
import { runCustomerRetention, type CustomerRetentionResult } from "../customer/retention.js";
import { tombstoneDraftBrief } from "../integrity/store.js";

export interface RetentionResult {
	checked: number;
	deletedFiles: number;
	skippedHolds: number;
	blobsPurged: number;
	blobsPending: number;
}

export interface RetentionDeps {
	db: Db;
	lockTimeoutMs: number;
	storageDir: string;
	/** Override for tests (a throwing fake exercises the retry marker). */
	deleteBlobFn?: (root: string, key: string) => Promise<void>;
	now?: Date;
	/** Scopes the sweep to one application (internal retention/run route). */
	applicationId?: string;
	limit?: number;
	/** E2: while the fraud feature is on, an active review blocks document
	 * retention so the cited evidence survives the investigation. */
	fraudReviewEnabled?: boolean;
}

type FileRow = typeof documentFiles.$inferSelect;

/** Pure hold check (unit-tested): an active application-wide hold (file
 * null) blocks every file; a file-level hold blocks only its file. */
export function retentionBlockedBy(
	holds: Array<{ documentFileId: string | null }>,
	fileId: string,
): boolean {
	return holds.some((h) => h.documentFileId === null || h.documentFileId === fileId);
}

async function tombstoneFile(
	tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
	file: FileRow,
	now: Date,
): Promise<string | null> {
	const findings = await tx
		.select({ id: documentFindings.id, crosscheckId: documentFindings.crosscheckId })
		.from(documentFindings)
		.where(eq(documentFindings.documentFileId, file.id));
	const findingIds = findings.map((f) => f.id);
	let chaseIds: string[] = [];
	if (findingIds.length > 0) {
		const links = await tx
			.select({ chaseRequestId: chaseRequestFindings.chaseRequestId })
			.from(chaseRequestFindings)
			.where(inArray(chaseRequestFindings.findingId, findingIds));
		chaseIds = [...new Set(links.map((l) => l.chaseRequestId))];
		await tx
			.delete(chaseRequestFindings)
			.where(inArray(chaseRequestFindings.findingId, findingIds));
	}
	if (chaseIds.length > 0) {
		await tx
			.update(chaseRequests)
			.set({ body: null, redactedAt: now })
			.where(inArray(chaseRequests.id, chaseIds));
	}
	if (findingIds.length > 0) {
		await tx.delete(documentFindings).where(eq(documentFindings.documentFileId, file.id));
	}
	const crosscheckIds = [...new Set(findings.map((f) => f.crosscheckId))];
	if (crosscheckIds.length > 0) {
		await tx
			.update(documentCrosschecks)
			.set({ status: "redacted", findingCount: 0 })
			.where(inArray(documentCrosschecks.id, crosscheckIds));
	}
	await tx.delete(documentPages).where(eq(documentPages.documentFileId, file.id));
	// US-INT retention: AI candidate quotes, deterministic duplicate metadata,
	// and any draft brief that cited this file must not outlive the evidence.
	await tx
		.update(documentFieldCandidates)
		.set({ value: "", normalizedValue: "", quote: "", redactedAt: now })
		.where(eq(documentFieldCandidates.documentFileId, file.id));
	await tx
		.update(documentConsistencyCandidates)
		.set({
			leftValue: "redacted",
			leftQuote: "redacted",
			leftLabel: "redacted",
			rightValue: "redacted",
			rightQuote: "redacted",
			rightLabel: "redacted",
			explanation: null,
			explanationVerified: false,
			status: "rejected",
			kind: null,
			redactedAt: now,
		})
		.where(
			or(
				eq(documentConsistencyCandidates.leftDocumentFileId, file.id),
				eq(documentConsistencyCandidates.rightDocumentFileId, file.id),
			),
		);
	await tx
		.update(documentFingerprints)
		.set({
			producer: "unknown",
			creator: "unknown",
			metadataCreatedAt: null,
			metadataModifiedAt: null,
			metadataSource: "unknown",
			editCodes: [],
			redactedAt: now,
		})
		.where(eq(documentFingerprints.documentFileId, file.id));
	const draftBriefs = await tx
		.select({ id: generatedArtifacts.id, citations: generatedArtifacts.citations })
		.from(generatedArtifacts)
		.where(
			and(
				eq(generatedArtifacts.applicationId, file.applicationId),
				eq(generatedArtifacts.type, "document_integrity_brief"),
				eq(generatedArtifacts.status, "draft"),
			),
		);
	const refPrefix = `document:${file.id}:`;
	for (const brief of draftBriefs) {
		const citations = Array.isArray(brief.citations) ? brief.citations : [];
		if (
			citations.some(
				(citation) =>
					typeof citation === "object" &&
					citation !== null &&
					"ref" in citation &&
					typeof citation.ref === "string" &&
					citation.ref.startsWith(refPrefix),
			)
		) {
			await tombstoneDraftBrief(tx, brief.id, file.applicationId, "system:retention", now);
		}
	}
	await tx
		.update(fraudReviews)
		.set({ briefStaleAt: now, updatedAt: now })
		.where(
			and(
				eq(fraudReviews.applicationId, file.applicationId),
				inArray(fraudReviews.status, ["open", "needs_info"]),
			),
		);
	await tx
		.update(documentFiles)
		.set({
			status: "deleted",
			originalFilename: null,
			errorCode: null,
			errorMessage: null,
		})
		.where(eq(documentFiles.id, file.id));
	await writeAudit(tx, {
		applicationId: file.applicationId,
		actor: "system",
		action: "document.deleted",
		entity: "document_file",
		payload: { applicationId: file.applicationId, documentFileId: file.id },
	});
	return file.storageKey;
}

export async function runDocumentRetention(deps: RetentionDeps): Promise<RetentionResult> {
	const { db, lockTimeoutMs, storageDir } = deps;
	const del = deps.deleteBlobFn ?? deleteBlob;
	const now = deps.now ?? new Date();
	const limit = deps.limit ?? 500;
	const result: RetentionResult = {
		checked: 0,
		deletedFiles: 0,
		skippedHolds: 0,
		blobsPurged: 0,
		blobsPending: 0,
	};
	const scope = deps.applicationId ? [eq(documentFiles.applicationId, deps.applicationId)] : [];
	const reviewScope = deps.fraudReviewEnabled
		? [
				sql`NOT EXISTS (
					SELECT 1 FROM fraud_reviews fr
					WHERE fr.application_id = ${documentFiles.applicationId}
						AND fr.status IN ('open','needs_info')
				)`,
			]
		: [];
	const expired = await db
		.select()
		.from(documentFiles)
		.where(
			and(
				sql`${documentFiles.status} != 'deleted'`,
				lte(documentFiles.retentionUntil, now),
				...scope,
				...reviewScope,
			),
		)
		.orderBy(documentFiles.retentionUntil)
		.limit(limit);
	const retryBlobs = await db
		.select()
		.from(documentFiles)
		.where(
			and(
				eq(documentFiles.status, "deleted"),
				isNull(documentFiles.blobPurgedAt),
				isNotNull(documentFiles.storageKey),
				...scope,
			),
		)
		.limit(limit);

	const byApp = new Map<string, FileRow[]>();
	for (const file of expired) {
		const list = byApp.get(file.applicationId) ?? [];
		list.push(file);
		byApp.set(file.applicationId, list);
	}
	const pendingPurge: Array<{ id: string; key: string }> = [];

	for (const [applicationId, files] of byApp) {
		const purged = await withTx(db, async (tx) => {
			await lockApplication(tx, applicationId, lockTimeoutMs);
			const keys: Array<{ id: string; key: string }> = [];
			for (const file of files) {
				result.checked++;
				const rows = await tx
					.select()
					.from(documentFiles)
					.where(eq(documentFiles.id, file.id))
					.limit(1);
				const fresh = rows[0];
				if (!fresh || fresh.status === "deleted" || fresh.retentionUntil > now) continue;
				if (deps.fraudReviewEnabled) {
					const [activeReview] = await tx
						.select({ id: fraudReviews.id })
						.from(fraudReviews)
						.where(
							and(
								eq(fraudReviews.applicationId, applicationId),
								inArray(fraudReviews.status, ["open", "needs_info"]),
							),
						)
						.limit(1);
					if (activeReview) {
						result.skippedHolds++;
						continue;
					}
				}
				const holds = await tx
					.select({ documentFileId: documentLegalHolds.documentFileId })
					.from(documentLegalHolds)
					.where(
						and(
							eq(documentLegalHolds.applicationId, applicationId),
							isNull(documentLegalHolds.releasedAt),
						),
					);
				if (retentionBlockedBy(holds, file.id)) {
					result.skippedHolds++;
					continue;
				}
				const key = await tombstoneFile(tx, fresh, now);
				result.deletedFiles++;
				if (key) keys.push({ id: fresh.id, key });
			}
			return keys;
		});
		pendingPurge.push(...purged);
	}
	// Blob-retry rows are already tombstoned: purge without a hold check
	// (the hold guards content deletion, which already committed).
	for (const file of retryBlobs) {
		result.checked++;
		if (file.storageKey) pendingPurge.push({ id: file.id, key: file.storageKey });
	}

	for (const { id, key } of pendingPurge) {
		let ok = false;
		try {
			ok = await purgeBlob(storageDir, key, del);
		} catch {
			ok = false;
		}
		if (ok) {
			await db
				.update(documentFiles)
				.set({ blobPurgedAt: now })
				.where(and(eq(documentFiles.id, id), isNull(documentFiles.blobPurgedAt)));
			result.blobsPurged++;
		} else {
			result.blobsPending++;
		}
	}
	return result;
}

export interface LegalHold {
	id: string;
	applicationId: string;
	documentFileId: string | null;
	createdAt: Date;
	releasedAt: Date | null;
}

function presentHold(row: typeof documentLegalHolds.$inferSelect): LegalHold {
	return {
		id: row.id,
		applicationId: row.applicationId,
		documentFileId: row.documentFileId,
		createdAt: row.createdAt,
		releasedAt: row.releasedAt,
	};
}

/** Application-wide (fileId null) or file-level hold on the same
 * per-application lock as retention, so a concurrent sweep cannot slip
 * past. File holds validate the file belongs to the application. */
export async function createLegalHold(
	db: Db,
	input: {
		applicationId: string;
		documentFileId?: string | null;
		reason: string;
		createdBy: string;
		lockTimeoutMs: number;
	},
): Promise<LegalHold> {
	return withTx(db, async (tx) => {
		await lockApplication(tx, input.applicationId, input.lockTimeoutMs);
		const apps = await tx
			.select()
			.from(applications)
			.where(eq(applications.id, input.applicationId));
		if (!apps[0]) throw new HttpError(404, "NOT_FOUND", "not found");
		if (input.documentFileId) {
			const files = await tx
				.select({ id: documentFiles.id })
				.from(documentFiles)
				.where(
					and(
						eq(documentFiles.id, input.documentFileId),
						eq(documentFiles.applicationId, input.applicationId),
					),
				)
				.limit(1);
			if (!files[0]) throw new HttpError(404, "NOT_FOUND", "not found");
		}
		const [hold] = await tx
			.insert(documentLegalHolds)
			.values({
				applicationId: input.applicationId,
				documentFileId: input.documentFileId ?? null,
				reason: input.reason,
				createdBy: input.createdBy,
			})
			.returning();
		await writeAudit(tx, {
			applicationId: input.applicationId,
			actor: input.createdBy,
			action: "document.hold_created",
			entity: "document_legal_hold",
			payload: {
				applicationId: input.applicationId,
				holdId: hold.id,
				...(hold.documentFileId ? { documentFileId: hold.documentFileId } : {}),
			},
		});
		return presentHold(hold);
	});
}

/** Idempotent release (already-released returns the row). The hold must
 * belong to the application or it 404s (non-leaking). */
export async function releaseLegalHold(
	db: Db,
	input: { applicationId: string; holdId: string; actor: string; lockTimeoutMs: number },
): Promise<LegalHold> {
	return withTx(db, async (tx) => {
		await lockApplication(tx, input.applicationId, input.lockTimeoutMs);
		const rows = await tx
			.select()
			.from(documentLegalHolds)
			.where(
				and(
					eq(documentLegalHolds.id, input.holdId),
					eq(documentLegalHolds.applicationId, input.applicationId),
				),
			)
			.limit(1);
		const hold = rows[0];
		if (!hold) throw new HttpError(404, "NOT_FOUND", "not found");
		let released = hold;
		if (!hold.releasedAt) {
			[released] = await tx
				.update(documentLegalHolds)
				.set({ releasedAt: new Date() })
				.where(eq(documentLegalHolds.id, hold.id))
				.returning();
			await writeAudit(tx, {
				applicationId: input.applicationId,
				actor: input.actor,
				action: "document.hold_released",
				entity: "document_legal_hold",
				payload: { applicationId: input.applicationId, holdId: hold.id },
			});
		}
		return presentHold(released);
	});
}

// --- Boot/interval maintenance (wired in server.ts, never the app
// factory, so tests importing createApp get no timers). ---

export interface MaintenanceDeps {
	db: Db;
	lockTimeoutMs: number;
	storageDir: string;
	uploadDeadlineMs: number;
	/** Orphan sweep runs only when blob storage is configured (dir + key);
	 * retention always runs, even with the feature flag off. */
	storageConfigured: boolean;
	/** T17 customer evidence sweep (D2a): separate root + per-customer
	 * lock; omitted in tests that only cover the T01 app sweep. */
	customerStorageDir?: string;
	/** Fixture clock for fixture-owned customer rows (SPEC-t17-t18 §2.5):
	 * set from DEMO_AS_OF in demo mode, unset otherwise. */
	customerDemoAsOf?: Date;
	/** E2: skip customer evidence while a review is active. */
	fraudReviewEnabled?: boolean;
	logger?: Pick<Logger, "info" | "warn">;
	intervalMs?: number;
}

export interface MaintenanceResult {
	orphans: SweepResult | null;
	retention: RetentionResult;
	customer: CustomerRetentionResult | null;
}

export async function runDocumentMaintenanceOnce(
	deps: MaintenanceDeps,
): Promise<MaintenanceResult> {
	let orphans: SweepResult | null = null;
	if (deps.storageConfigured) {
		orphans = await sweepDocumentOrphans(deps.db, deps.storageDir, {
			deadlineMs: deps.uploadDeadlineMs,
		});
	}
	const retention = await runDocumentRetention({
		db: deps.db,
		lockTimeoutMs: deps.lockTimeoutMs,
		storageDir: deps.storageDir,
		fraudReviewEnabled: deps.fraudReviewEnabled,
	});
	// The customer sweep is independent (disjoint root, per-customer locks):
	// an app-sweep failure never blocks it and vice versa.
	let customer: CustomerRetentionResult | null = null;
	if (deps.customerStorageDir) {
		customer = await runCustomerRetention({
			db: deps.db,
			lockTimeoutMs: deps.lockTimeoutMs,
			storageDir: deps.customerStorageDir,
			demoAsOf: deps.customerDemoAsOf,
			fraudReviewEnabled: deps.fraudReviewEnabled,
		});
	}
	deps.logger?.info(
		{
			checked: retention.checked,
			deletedFiles: retention.deletedFiles,
			skippedHolds: retention.skippedHolds,
			blobsPurged: retention.blobsPurged,
			blobsPending: retention.blobsPending,
			removedBlobs: orphans?.removedBlobs ?? 0,
			removedTemps: orphans?.removedTemps ?? 0,
			customerChecked: customer?.checked ?? 0,
			customerDeleted: customer?.deletedDocuments ?? 0,
		},
		"document maintenance",
	);
	return { orphans, retention, customer };
}

/** Runs once at boot, then daily. The interval is unref'd and the
 * returned stop() clears it, so tests never hang on a timer. */
export function startDocumentMaintenance(deps: MaintenanceDeps): () => void {
	const run = async (): Promise<void> => {
		try {
			await runDocumentMaintenanceOnce(deps);
		} catch {
			deps.logger?.warn({ code: "MAINTENANCE_FAILED" }, "document maintenance failed");
		}
	};
	void run();
	const interval = setInterval(() => {
		void run();
	}, deps.intervalMs ?? 86_400_000);
	if (typeof (interval as unknown as { unref?: () => void }).unref === "function") {
		(interval as unknown as { unref: () => void }).unref();
	}
	return () => clearInterval(interval);
}
