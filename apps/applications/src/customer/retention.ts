// T17 customer evidence retention (SPEC-t17-t18 §2.2, D2a): sweep and
// legal holds mirroring the T01 application sweep, but over the disjoint
// CUSTOMER_STORAGE_DIR root and under the same per-customer advisory lock
// the reuse path takes (`customer:<id>`), so a purge can never race a copy.
// Expired rows are tombstoned, never hard-deleted: pages are removed,
// filename/PII nulled, the blob purged after commit, and the row kept with
// `status='deleted'` for audit — including rows referenced by reused app
// copies (the FK is RESTRICT; app copies carry their own blobs/retention).
import {
	applications,
	customerDocumentPages,
	customerDocuments,
	customerLegalHolds,
	customerProfiles,
	fraudReviews,
	generatedArtifacts,
	withTx,
	type Db,
} from "@credit/db/applications";
import { HttpError, writeAudit } from "@credit/service-kit";
import { and, eq, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { lockApplication } from "../documents/access.js";
import { deleteBlob, purgeBlob } from "../documents/storage.js";
import { tombstoneDraftBrief } from "../integrity/store.js";
import { hasActiveReviewForCustomer } from "../integrity/fraud.js";

export interface CustomerRetentionResult {
	checked: number;
	deletedDocuments: number;
	skippedHolds: number;
	blobsPurged: number;
	blobsPending: number;
}

export interface CustomerRetentionDeps {
	db: Db;
	lockTimeoutMs: number;
	storageDir: string;
	/** Override for tests (a throwing fake exercises the retry marker). */
	deleteBlobFn?: (root: string, key: string) => Promise<void>;
	now?: Date;
	/** Fixture clock (SPEC-t17-t18 §2.5): `demo_seed` rows expire against
	 * this, live rows against wall-clock `now` — a later wall date never
	 * sweeps fixture evidence the demo still owns. */
	demoAsOf?: Date;
	/** Scopes the sweep to one customer. */
	customerId?: string;
	limit?: number;
	/** E2: an active review for this customer's applications blocks evidence
	 * retention so the cited source survives the investigation. */
	fraudReviewEnabled?: boolean;
}

type CustomerDocRow = typeof customerDocuments.$inferSelect;

/** Pure hold check (unit-tested): a customer-wide hold (document null)
 * blocks every document; a document hold blocks only its document. */
export function customerRetentionBlockedBy(
	holds: Array<{ customerDocumentId: string | null }>,
	documentId: string,
): boolean {
	return holds.some((h) => h.customerDocumentId === null || h.customerDocumentId === documentId);
}

async function tombstoneCustomerDocument(
	tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
	doc: CustomerDocRow,
	now: Date,
): Promise<string | null> {
	await tx
		.delete(customerDocumentPages)
		.where(eq(customerDocumentPages.customerDocumentId, doc.id));
	await tx
		.update(customerDocuments)
		.set({ status: "deleted", originalFilename: null })
		.where(eq(customerDocuments.id, doc.id));
	// A brief that cited this customer page must not outlive the source.
	const [profile] = await tx
		.select({ userId: customerProfiles.userId })
		.from(customerProfiles)
		.where(eq(customerProfiles.id, doc.customerId))
		.limit(1);
	if (profile) {
		const apps = await tx
			.select({ id: applications.id })
			.from(applications)
			.where(eq(applications.applicantUserId, profile.userId));
		const appIds = apps.map((app) => app.id);
		if (appIds.length > 0) {
			const briefs = await tx
				.select({
					id: generatedArtifacts.id,
					applicationId: generatedArtifacts.applicationId,
					citations: generatedArtifacts.citations,
				})
				.from(generatedArtifacts)
				.where(
					and(
						eq(generatedArtifacts.type, "document_integrity_brief"),
						eq(generatedArtifacts.status, "draft"),
					),
				);
			const refPrefix = `context_signal:customer_document:${doc.id}:`;
			for (const brief of briefs) {
				if (!appIds.includes(brief.applicationId)) continue;
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
					await tombstoneDraftBrief(tx, brief.id, brief.applicationId, "system:retention", now);
				}
			}
			for (const appId of appIds) {
				await tx
					.update(fraudReviews)
					.set({ briefStaleAt: now, updatedAt: now })
					.where(
						and(
							eq(fraudReviews.applicationId, appId),
							sql`${fraudReviews.status} IN ('open','needs_info')`,
						),
					);
			}
		}
	}
	await writeAudit(tx, {
		actor: "system",
		action: "customer.document_deleted",
		entity: "customer_document",
		payload: { customerId: doc.customerId, customerDocumentId: doc.id },
	});
	return doc.storageKey;
}

export async function runCustomerRetention(
	deps: CustomerRetentionDeps,
): Promise<CustomerRetentionResult> {
	const { db, lockTimeoutMs, storageDir } = deps;
	const del = deps.deleteBlobFn ?? deleteBlob;
	const now = deps.now ?? new Date();
	const limit = deps.limit ?? 500;
	const result: CustomerRetentionResult = {
		checked: 0,
		deletedDocuments: 0,
		skippedHolds: 0,
		blobsPurged: 0,
		blobsPending: 0,
	};
	const scope = deps.customerId ? [eq(customerDocuments.customerId, deps.customerId)] : [];
	// Fixture-owned rows expire on the fixture clock; everything else on the
	// wall clock. Without `demoAsOf` every row uses `now` (legacy/tests).
	const demoAsOf = deps.demoAsOf;
	const expiry = demoAsOf
		? or(
				and(ne(customerDocuments.source, "demo_seed"), lte(customerDocuments.retentionUntil, now)),
				and(
					eq(customerDocuments.source, "demo_seed"),
					lte(customerDocuments.retentionUntil, demoAsOf),
				),
			)
		: lte(customerDocuments.retentionUntil, now);
	const expired = await db
		.select()
		.from(customerDocuments)
		.where(
			and(
				sql`${customerDocuments.status} != 'deleted'`,
				expiry,
				...scope,
				...(deps.fraudReviewEnabled
					? [
							sql`NOT EXISTS (
								SELECT 1 FROM fraud_reviews fr
								JOIN applications a ON a.id = fr.application_id
								JOIN customer_profiles cp ON cp.user_id = a.applicant_user_id
								WHERE cp.id = ${customerDocuments.customerId}
									AND fr.status IN ('open','needs_info')
							)`,
						]
					: []),
			),
		)
		.orderBy(customerDocuments.retentionUntil)
		.limit(limit);
	const retryBlobs = await db
		.select()
		.from(customerDocuments)
		.where(
			and(
				eq(customerDocuments.status, "deleted"),
				isNull(customerDocuments.blobPurgedAt),
				isNotNull(customerDocuments.storageKey),
				...scope,
			),
		)
		.limit(limit);

	const byCustomer = new Map<string, CustomerDocRow[]>();
	for (const doc of expired) {
		const list = byCustomer.get(doc.customerId) ?? [];
		list.push(doc);
		byCustomer.set(doc.customerId, list);
	}
	const pendingPurge: Array<{ id: string; key: string }> = [];

	for (const [customerId, docs] of byCustomer) {
		const purged = await withTx(db, async (tx) => {
			// Same lock the reuse path takes first — a purge can never slip
			// past an in-flight copy.
			await lockApplication(tx, `customer:${customerId}`, lockTimeoutMs);
			const keys: Array<{ id: string; key: string }> = [];
			for (const doc of docs) {
				result.checked++;
				const rows = await tx
					.select()
					.from(customerDocuments)
					.where(eq(customerDocuments.id, doc.id))
					.limit(1);
				const fresh = rows[0];
				if (!fresh || fresh.status === "deleted") continue;
				const clock = fresh.source === "demo_seed" && demoAsOf ? demoAsOf : now;
				if (fresh.retentionUntil > clock) continue;
				const holds = await tx
					.select({ customerDocumentId: customerLegalHolds.customerDocumentId })
					.from(customerLegalHolds)
					.where(
						and(
							eq(customerLegalHolds.customerId, customerId),
							isNull(customerLegalHolds.releasedAt),
						),
					);
				if (customerRetentionBlockedBy(holds, doc.id)) {
					result.skippedHolds++;
					continue;
				}
				if (deps.fraudReviewEnabled) {
					if (await hasActiveReviewForCustomer(tx, fresh.customerId)) {
						result.skippedHolds++;
						continue;
					}
				}
				const key = await tombstoneCustomerDocument(tx, fresh, now);
				result.deletedDocuments++;
				if (key) keys.push({ id: fresh.id, key });
			}
			return keys;
		});
		pendingPurge.push(...purged);
	}
	for (const doc of retryBlobs) {
		result.checked++;
		if (doc.storageKey) pendingPurge.push({ id: doc.id, key: doc.storageKey });
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
				.update(customerDocuments)
				.set({ blobPurgedAt: now })
				.where(and(eq(customerDocuments.id, id), isNull(customerDocuments.blobPurgedAt)));
			result.blobsPurged++;
		} else {
			result.blobsPending++;
		}
	}
	return result;
}

export interface CustomerLegalHold {
	id: string;
	customerId: string;
	customerDocumentId: string | null;
	createdAt: Date;
	releasedAt: Date | null;
}

function presentCustomerHold(row: typeof customerLegalHolds.$inferSelect): CustomerLegalHold {
	return {
		id: row.id,
		customerId: row.customerId,
		customerDocumentId: row.customerDocumentId,
		createdAt: row.createdAt,
		releasedAt: row.releasedAt,
	};
}

/** Customer-wide (documentId null) or document-level hold on the same
 * per-customer lock as the sweep and reuse. Document holds validate the
 * document belongs to the customer. */
export async function createCustomerLegalHold(
	db: Db,
	input: {
		customerId: string;
		customerDocumentId?: string | null;
		reason: string;
		createdBy: string;
		lockTimeoutMs: number;
	},
): Promise<CustomerLegalHold> {
	return withTx(db, async (tx) => {
		await lockApplication(tx, `customer:${input.customerId}`, input.lockTimeoutMs);
		const profiles = await tx
			.select()
			.from(customerProfiles)
			.where(eq(customerProfiles.id, input.customerId));
		if (!profiles[0]) throw new HttpError(404, "NOT_FOUND", "not found");
		if (input.customerDocumentId) {
			const docs = await tx
				.select({ id: customerDocuments.id })
				.from(customerDocuments)
				.where(
					and(
						eq(customerDocuments.id, input.customerDocumentId),
						eq(customerDocuments.customerId, input.customerId),
					),
				)
				.limit(1);
			if (!docs[0]) throw new HttpError(404, "NOT_FOUND", "not found");
		}
		const [hold] = await tx
			.insert(customerLegalHolds)
			.values({
				customerId: input.customerId,
				customerDocumentId: input.customerDocumentId ?? null,
				reason: input.reason,
				createdBy: input.createdBy,
			})
			.returning();
		await writeAudit(tx, {
			actor: input.createdBy,
			action: "customer.hold_created",
			entity: "customer_legal_hold",
			payload: {
				customerId: input.customerId,
				holdId: hold.id,
				...(hold.customerDocumentId ? { customerDocumentId: hold.customerDocumentId } : {}),
			},
		});
		return presentCustomerHold(hold);
	});
}

/** Idempotent release (already-released returns the row). The hold must
 * belong to the customer or it 404s (non-leaking). */
export async function releaseCustomerLegalHold(
	db: Db,
	input: { customerId: string; holdId: string; actor: string; lockTimeoutMs: number },
): Promise<CustomerLegalHold> {
	return withTx(db, async (tx) => {
		await lockApplication(tx, `customer:${input.customerId}`, input.lockTimeoutMs);
		const rows = await tx
			.select()
			.from(customerLegalHolds)
			.where(
				and(
					eq(customerLegalHolds.id, input.holdId),
					eq(customerLegalHolds.customerId, input.customerId),
				),
			)
			.limit(1);
		const hold = rows[0];
		if (!hold) throw new HttpError(404, "NOT_FOUND", "not found");
		let released = hold;
		if (!hold.releasedAt) {
			[released] = await tx
				.update(customerLegalHolds)
				.set({ releasedAt: new Date() })
				.where(eq(customerLegalHolds.id, hold.id))
				.returning();
			await writeAudit(tx, {
				actor: input.actor,
				action: "customer.hold_released",
				entity: "customer_legal_hold",
				payload: { customerId: input.customerId, holdId: hold.id },
			});
		}
		return presentCustomerHold(released);
	});
}
