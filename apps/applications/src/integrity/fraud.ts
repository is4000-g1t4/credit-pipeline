// EN-05 fraud-review routing + US-INT-4/5 officer actions.
//
// A single row is both the case-level document-integrity flag and the review
// item. Creation takes the per-application advisory lock; the partial unique
// index keeps one active item. Resolution is by the assigned officer and never
// touches the application status, score, terms, or decision.

import {
	applications,
	caseAccessGrants,
	customerProfiles,
	documentDuplicateExplanations,
	documentFiles,
	documentIntegrityRuns,
	documentLegalHolds,
	fraudReviews,
	withTx,
	type Db,
} from "@credit/db/applications";
import { and, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { HttpError, writeAudit } from "@credit/service-kit";
import { lockApplication } from "../documents/access.js";
import { getBriefArtifact } from "./store.js";
import type { IntegrityConfig, IntegritySeverity, IntegritySignalCode } from "./types.js";

type FraudReviewRow = typeof fraudReviews.$inferSelect;

const STATUSES = ["open", "cleared", "confirmed", "needs_info"] as const;
const ACTIVE = ["open", "needs_info"] as const;
const SEVERITY_RANK: Record<IntegritySeverity, number> = { low: 1, medium: 2, high: 3 };

export interface FraudReviewActor {
	id: string;
	role: "officer" | "service";
}

export interface CreateFraudReviewInput {
	applicationId: string;
	reasonCode: string;
	note: string | null;
	severity: IntegritySeverity;
	signalCodes: string[];
	documentRefs: string[];
	sourceHash: string;
	createdBy: string;
	actorRole: string;
	retentionDays: number;
	customerProfileId?: string | null;
	now?: Date;
}

async function lockCustomer(
	tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
	customerId: string,
): Promise<void> {
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`customer:${customerId}`}))`);
}

export async function createFraudReview(
	db: Db,
	input: CreateFraudReviewInput,
): Promise<{ review: FraudReviewRow; created: boolean }> {
	const now = input.now ?? new Date();
	return withTx(db, async (tx) => {
		await lockApplication(tx, input.applicationId, 5_000);
		let customerId = input.customerProfileId ?? null;
		if (!customerId) {
			const [app] = await tx
				.select({ applicantUserId: applications.applicantUserId })
				.from(applications)
				.where(eq(applications.id, input.applicationId))
				.limit(1);
			if (app) {
				const [profile] = await tx
					.select({ id: customerProfiles.id })
					.from(customerProfiles)
					.where(eq(customerProfiles.userId, app.applicantUserId))
					.limit(1);
				customerId = profile?.id ?? null;
			}
		}
		if (customerId) await lockCustomer(tx, customerId);
		const [existing] = await tx
			.select()
			.from(fraudReviews)
			.where(
				and(
					eq(fraudReviews.applicationId, input.applicationId),
					eq(fraudReviews.reviewType, "document_integrity"),
					inArray(fraudReviews.status, [...ACTIVE]),
				),
			)
			.limit(1)
			.for("update");
		if (existing) {
			const codes = [...new Set([...existing.signalCodes, ...input.signalCodes])].slice(0, 100);
			const refs = [...new Set([...existing.documentRefs, ...input.documentRefs])].slice(0, 100);
			const severity =
				SEVERITY_RANK[input.severity] > SEVERITY_RANK[existing.severity]
					? input.severity
					: existing.severity;
			const [updated] = await tx
				.update(fraudReviews)
				.set({
					signalCodes: codes,
					documentRefs: refs,
					severity,
					sourceHash: input.sourceHash,
					updatedAt: now,
				})
				.where(eq(fraudReviews.id, existing.id))
				.returning();
			await writeAudit(tx, {
				applicationId: input.applicationId,
				actor: input.createdBy,
				action: "integrity.flag_updated",
				entity: "fraud_review",
				payload: {
					feature: "fraud_review",
					actorRole: input.actorRole,
					reviewId: updated.id,
					severity,
					signalCodes: codes,
					documentCount: refs.length,
				},
			});
			return { review: updated, created: false };
		}
		const [created] = await tx
			.insert(fraudReviews)
			.values({
				applicationId: input.applicationId,
				reviewType: "document_integrity",
				status: "open",
				reasonCode: input.reasonCode,
				severity: input.severity,
				note: input.note,
				signalCodes: [...new Set(input.signalCodes)].slice(0, 100),
				documentRefs: [...new Set(input.documentRefs)].slice(0, 100),
				sourceHash: input.sourceHash,
				createdBy: input.createdBy,
				createdAt: now,
				updatedAt: now,
				retentionUntil: new Date(now.getTime() + input.retentionDays * 86_400_000),
			})
			.returning();
		await writeAudit(tx, {
			applicationId: input.applicationId,
			actor: input.createdBy,
			action: "integrity.flag_opened",
			entity: "fraud_review",
			payload: {
				feature: "fraud_review",
				actorRole: input.actorRole,
				reviewId: created.id,
				severity: input.severity,
				reasonCode: input.reasonCode,
				signalCodes: created.signalCodes,
				documentCount: created.documentRefs.length,
			},
		});
		return { review: created, created: true };
	});
}

export async function getFraudReviewRow(db: Db, reviewId: string): Promise<FraudReviewRow | null> {
	const [row] = await db.select().from(fraudReviews).where(eq(fraudReviews.id, reviewId)).limit(1);
	return row ?? null;
}

export async function findActiveFraudReview(
	db: Db,
	applicationId: string,
): Promise<FraudReviewRow | null> {
	const [row] = await db
		.select()
		.from(fraudReviews)
		.where(
			and(eq(fraudReviews.applicationId, applicationId), inArray(fraudReviews.status, [...ACTIVE])),
		)
		.limit(1);
	return row ?? null;
}

export interface FraudQueueItem {
	id: string;
	applicationId: string;
	applicationReference: string;
	status: FraudReviewRow["status"];
	severity: IntegritySeverity;
	reasonCode: string;
	briefAvailable: boolean;
	briefStale: boolean;
	briefState: "ready" | "stale" | "pending" | "failed" | "missing";
	createdAt: string;
	updatedAt: string;
	version: number;
}

export async function listFraudQueue(
	db: Db,
	actor: FraudReviewActor,
	status: "active" | "all" = "active",
): Promise<FraudQueueItem[]> {
	const conditions = [
		sql`EXISTS (
			SELECT 1 FROM case_access_grants g
			WHERE g.application_id = ${fraudReviews.applicationId}
				AND g.user_id = ${actor.id}
				AND g.revoked_at IS NULL
		)`,
	];
	if (status === "active") conditions.push(inArray(fraudReviews.status, [...ACTIVE]));
	const rows = await db
		.select({
			id: fraudReviews.id,
			applicationId: fraudReviews.applicationId,
			applicationReference: applications.reference,
			status: fraudReviews.status,
			severity: fraudReviews.severity,
			reasonCode: fraudReviews.reasonCode,
			briefArtifactId: fraudReviews.briefArtifactId,
			briefStaleAt: fraudReviews.briefStaleAt,
			agentRunId: fraudReviews.agentRunId,
			createdAt: fraudReviews.createdAt,
			updatedAt: fraudReviews.updatedAt,
			version: fraudReviews.version,
		})
		.from(fraudReviews)
		.innerJoin(applications, eq(applications.id, fraudReviews.applicationId))
		.where(and(...conditions))
		.orderBy(desc(fraudReviews.createdAt))
		.limit(100);
	const runIds = rows.map((row) => row.agentRunId).filter((id): id is string => id !== null);
	const runs =
		runIds.length === 0
			? []
			: await db
					.select({
						id: documentIntegrityRuns.id,
						status: documentIntegrityRuns.status,
					})
					.from(documentIntegrityRuns)
					.where(inArray(documentIntegrityRuns.id, runIds));
	const runStatus = new Map(runs.map((run) => [run.id, run.status]));
	return rows.map((row) => {
		const status = row.agentRunId ? runStatus.get(row.agentRunId) : undefined;
		const briefState =
			row.briefStaleAt !== null
				? "stale"
				: row.briefArtifactId !== null
					? "ready"
					: status === "queued" || status === "running"
						? "pending"
						: status === "failed"
							? "failed"
							: "missing";
		return {
			id: row.id,
			applicationId: row.applicationId,
			applicationReference: row.applicationReference,
			status: row.status,
			severity: row.severity,
			reasonCode: row.reasonCode,
			briefAvailable: row.briefArtifactId !== null,
			briefStale: row.briefStaleAt !== null,
			briefState,
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString(),
			version: row.version,
		};
	});
}

export async function canViewFraudReview(
	db: Db,
	row: FraudReviewRow,
	actor: FraudReviewActor,
): Promise<{ assigned: true }> {
	const grants = await db
		.select({ id: caseAccessGrants.id })
		.from(caseAccessGrants)
		.where(
			and(
				eq(caseAccessGrants.applicationId, row.applicationId),
				eq(caseAccessGrants.userId, actor.id),
				isNull(caseAccessGrants.revokedAt),
			),
		)
		.limit(1);
	if (grants.length === 0) throw new HttpError(404, "NOT_FOUND", "not found");
	return { assigned: true };
}

export async function resolveFraudReview(
	db: Db,
	input: {
		reviewId: string;
		status: "cleared" | "confirmed" | "needs_info";
		note: string;
		actor: FraudReviewActor;
		expectedVersion: number;
		now?: Date;
	},
): Promise<FraudReviewRow> {
	const note = input.note.trim();
	if (note.length < 10 || note.length > 2_000) {
		throw new HttpError(400, "VALIDATION_ERROR", "resolution note must be 10-2000 characters");
	}
	const now = input.now ?? new Date();
	return withTx(db, async (tx) => {
		const [row] = await tx
			.select()
			.from(fraudReviews)
			.where(eq(fraudReviews.id, input.reviewId))
			.limit(1)
			.for("update");
		if (!row) throw new HttpError(404, "NOT_FOUND", "not found");
		if (!ACTIVE.includes(row.status as "open" | "needs_info")) {
			throw new HttpError(409, "REVIEW_NOT_ACTIVE", "review is already resolved");
		}
		if (row.version !== input.expectedVersion) {
			throw new HttpError(409, "VERSION_CONFLICT", "review changed; reload and retry");
		}
		const [updated] = await tx
			.update(fraudReviews)
			.set({
				status: input.status,
				resolvedBy: input.actor.id,
				resolvedAt: now,
				resolutionNote: note,
				version: row.version + 1,
				updatedAt: now,
			})
			.where(eq(fraudReviews.id, row.id))
			.returning();
		await writeAudit(tx, {
			applicationId: row.applicationId,
			actor: input.actor.id,
			action: "fraud_review.resolved",
			entity: "fraud_review",
			payload: {
				feature: "fraud_review",
				actorRole: input.actor.role,
				reviewId: row.id,
				status: input.status,
				severity: row.severity,
				signalCodes: row.signalCodes,
				runId: row.agentRunId,
				artifactId: row.briefArtifactId,
			},
		});
		return updated;
	});
}

export async function explainDuplicate(
	db: Db,
	input: {
		sha256: string;
		applicationId: string;
		note: string;
		actor: FraudReviewActor;
		retentionDays: number;
		now?: Date;
	},
): Promise<void> {
	const note = input.note.trim();
	if (note.length < 5 || note.length > 500) {
		throw new HttpError(400, "VALIDATION_ERROR", "note must be 5-500 characters");
	}
	const [file] = await db
		.select({ id: documentFiles.id })
		.from(documentFiles)
		.where(
			and(
				eq(documentFiles.applicationId, input.applicationId),
				eq(documentFiles.sha256, input.sha256),
				eq(documentFiles.status, "ready"),
				gt(documentFiles.retentionUntil, input.now ?? new Date()),
				isNull(documentFiles.blobPurgedAt),
			),
		)
		.limit(1);
	if (!file) throw new HttpError(404, "NOT_FOUND", "not found");
	const now = input.now ?? new Date();
	await withTx(db, async (tx) => {
		await tx
			.insert(documentDuplicateExplanations)
			.values({
				sha256: input.sha256,
				applicationId: input.applicationId,
				note,
				explainedBy: input.actor.id,
				retentionUntil: new Date(now.getTime() + input.retentionDays * 86_400_000),
			})
			.onConflictDoUpdate({
				target: [documentDuplicateExplanations.sha256, documentDuplicateExplanations.applicationId],
				set: {
					note,
					explainedBy: input.actor.id,
					redactedAt: null,
					createdAt: now,
					retentionUntil: new Date(now.getTime() + input.retentionDays * 86_400_000),
				},
			});
		await writeAudit(tx, {
			applicationId: input.applicationId,
			actor: input.actor.id,
			action: "fraud.duplicate_explained",
			entity: "document_duplicate_explanation",
			payload: {
				feature: "fraud_review",
				actorRole: input.actor.role,
				sha256Prefix: input.sha256.slice(0, 12),
			},
		});
	});
}

export async function buildResolutionDraft(
	db: Db,
	input: { reviewId: string; actor: FraudReviewActor },
): Promise<{ note: string; citations: Array<{ ref: string; quote: string }> }> {
	const row = await getFraudReviewRow(db, input.reviewId);
	if (!row) throw new HttpError(404, "NOT_FOUND", "not found");
	const [consentRow] = await db
		.select({ consent: applications.documentProcessingConsent })
		.from(applications)
		.where(eq(applications.id, row.applicationId))
		.limit(1);
	let summary = "";
	let citations: Array<{ ref: string; quote: string }> = [];
	if (consentRow?.consent === true && row.briefArtifactId && row.briefStaleAt === null) {
		const brief = await getBriefArtifact(db, row.briefArtifactId);
		if (brief && brief.status === "draft") {
			const content = brief.content as { summary?: { text?: string } };
			summary = typeof content.summary?.text === "string" ? content.summary.text : "";
			citations = Array.isArray(brief.citations)
				? (brief.citations as Array<{ ref: string; quote: string }>).slice(0, 5)
				: [];
		}
	}
	const signals = row.signalCodes.length > 0 ? row.signalCodes.join(", ") : "none";
	const note =
		`Document integrity review signals: ${signals}. ` +
		(summary ? `${summary} ` : "") +
		`This note is a draft for the reviewer; the reviewer edits it and chooses the resolution state.`;
	return { note: note.slice(0, 2_000), citations };
}

export async function runFraudReviewRetention(
	db: Db,
	input: { now?: Date; limit?: number } = {},
): Promise<{ reviewsRedacted: number; explanationsRedacted: number }> {
	const now = input.now ?? new Date();
	const limit = input.limit ?? 200;
	return withTx(db, async (tx) => {
		const expired = await tx
			.select({
				id: fraudReviews.id,
				applicationId: fraudReviews.applicationId,
			})
			.from(fraudReviews)
			.where(
				and(
					lte(fraudReviews.retentionUntil, now),
					inArray(fraudReviews.status, ["cleared", "confirmed"]),
					isNull(fraudReviews.redactedAt),
					sql`NOT EXISTS (
						SELECT 1 FROM document_legal_holds h
						WHERE h.application_id = ${fraudReviews.applicationId}
							AND h.released_at IS NULL
					)`,
				),
			)
			.limit(limit);
		for (const row of expired) {
			await tx
				.update(fraudReviews)
				.set({ note: null, resolutionNote: null, redactedAt: now })
				.where(eq(fraudReviews.id, row.id));
			await writeAudit(tx, {
				applicationId: row.applicationId,
				actor: "system:fraud-review-retention",
				action: "fraud_review.retention_applied",
				entity: "fraud_review",
				payload: { feature: "fraud_review", reviewId: row.id },
			});
		}
		const expiredExplanations = await tx
			.select({
				id: documentDuplicateExplanations.id,
				applicationId: documentDuplicateExplanations.applicationId,
			})
			.from(documentDuplicateExplanations)
			.where(
				and(
					lte(documentDuplicateExplanations.retentionUntil, now),
					isNull(documentDuplicateExplanations.redactedAt),
					sql`NOT EXISTS (
						SELECT 1 FROM document_legal_holds h
						WHERE h.application_id = ${documentDuplicateExplanations.applicationId}
							AND h.released_at IS NULL
					)`,
				),
			)
			.limit(limit);
		for (const row of expiredExplanations) {
			await tx
				.update(documentDuplicateExplanations)
				.set({ note: "redacted", redactedAt: now })
				.where(eq(documentDuplicateExplanations.id, row.id));
			await writeAudit(tx, {
				applicationId: row.applicationId,
				actor: "system:fraud-review-retention",
				action: "fraud.duplicate_explanation_retention",
				entity: "document_duplicate_explanation",
				payload: { feature: "fraud_review", explanationId: row.id },
			});
		}
		return {
			reviewsRedacted: expired.length,
			explanationsRedacted: expiredExplanations.length,
		};
	});
}

export function reviewRetentionDays(config: IntegrityConfig): number {
	return config.retentionDays;
}

export function activeReviewBlocksRetention(config: IntegrityConfig): boolean {
	return config.fraudReviewEnabled;
}

export async function hasActiveReviewForCustomer(db: Db, customerId: string): Promise<boolean> {
	const rows = await db
		.select({ id: fraudReviews.id })
		.from(fraudReviews)
		.innerJoin(applications, eq(applications.id, fraudReviews.applicationId))
		.innerJoin(customerProfiles, eq(customerProfiles.userId, applications.applicantUserId))
		.where(and(eq(customerProfiles.id, customerId), inArray(fraudReviews.status, [...ACTIVE])))
		.limit(1);
	return rows.length > 0;
}

export async function hasActiveReviewForApplication(
	db: Db,
	applicationId: string,
): Promise<boolean> {
	const rows = await db
		.select({ id: fraudReviews.id })
		.from(fraudReviews)
		.where(
			and(eq(fraudReviews.applicationId, applicationId), inArray(fraudReviews.status, [...ACTIVE])),
		)
		.limit(1);
	return rows.length > 0;
}

export async function activeDocumentHolds(db: Db, applicationId: string): Promise<boolean> {
	const rows = await db
		.select({ id: documentLegalHolds.id })
		.from(documentLegalHolds)
		.where(
			and(
				eq(documentLegalHolds.applicationId, applicationId),
				isNull(documentLegalHolds.releasedAt),
			),
		)
		.limit(1);
	return rows.length > 0;
}

/** Used by panic-free tests and callers that need the raw enum list. */
export const FRAUD_REVIEW_STATUSES = STATUSES;

export type { FraudReviewRow };
export type FraudSeverity = IntegritySeverity;
export type FraudSignalCode = IntegritySignalCode;
