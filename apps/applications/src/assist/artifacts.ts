// EN-02 generated artifact lifecycle (versions, revisions, approvals,
// tombstones, holds, retention). Content is validated by routes before
// calling here; audit payloads carry ids/codes only, never text.
import { createHash } from "node:crypto";
import {
	documentLegalHolds,
	generatedArtifactHolds,
	generatedArtifacts,
	withTx,
	type Db,
	type Tx,
} from "@credit/db/applications";
import { hashCanonical, type CitationRecord } from "@credit/core";
import { HttpError, writeAudit } from "@credit/service-kit";
import { and, desc, eq, isNull, lte, sql } from "drizzle-orm";
import { lockApplication } from "../documents/access.js";
import { LockTimeout } from "../documents/pipeline.js";
import type { ArtifactAuditMetadata, ArtifactDto, ArtifactStatus, ArtifactType } from "./types.js";

const ARTIFACT_LOCK_TIMEOUT_MS = 5_000;

export interface CreateArtifactInput {
	applicationId: string;
	type: ArtifactType;
	content: unknown;
	citations: CitationRecord[];
	documentDerived?: boolean;
	createdBy: string;
	actorRole?: string;
	model: string;
	promptVersion: string;
	retentionDays: number;
	auditMetadata?: ArtifactAuditMetadata;
	now?: Date;
}

export interface UpdateArtifactInput {
	id: string;
	actor: string;
	actorRole?: string;
	expectedRevision: number;
	content: unknown;
	citations: CitationRecord[];
	documentDerived?: boolean;
	model: string;
	promptVersion: string;
	retentionDays: number;
	auditMetadata?: ArtifactAuditMetadata;
	now?: Date;
}

type ArtifactRow = typeof generatedArtifacts.$inferSelect;

function toDto(row: ArtifactRow): ArtifactDto {
	const deleted = row.status === "deleted";
	return {
		id: row.id,
		applicationId: row.applicationId,
		type: row.type,
		version: row.version,
		revision: row.revision,
		status: row.status,
		documentDerived: row.documentDerived,
		// Defense in depth: never expose content for a tombstoned row even if
		// a direct DB path marked it deleted without purging.
		content: deleted ? {} : row.content,
		citations: deleted ? [] : (row.citations as CitationRecord[]),
		model: row.model,
		promptVersion: row.promptVersion,
		createdBy: row.createdBy,
		approvedBy: row.approvedBy,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		approvedAt: row.approvedAt?.toISOString() ?? null,
		deletedAt: row.deletedAt?.toISOString() ?? null,
		retentionUntil: row.retentionUntil.toISOString(),
	};
}

function addDays(now: Date, days: number): Date {
	return new Date(now.getTime() + days * 86_400_000);
}

/** Persistence errors from Drizzle can carry query params (artifact content,
 * citation quotes) in their message/fields. Never let them reach the service
 * error handler, which logs unknown errors. */
async function artifactTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
	try {
		return await withTx(db, fn);
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw new HttpError(500, "ARTIFACT_PERSIST_FAILED", "artifact persistence failed");
	}
}

/** Serialize with `createLegalHold` (same per-application advisory lock) so
 * a hold cannot commit between the hold check and the purge. */
async function lockArtifactCase(tx: Tx, applicationId: string): Promise<void> {
	try {
		await lockApplication(tx, applicationId, ARTIFACT_LOCK_TIMEOUT_MS);
	} catch (err) {
		if (err instanceof LockTimeout) {
			throw new HttpError(409, "LOCK_TIMEOUT", "the case is busy; retry the request");
		}
		throw err;
	}
}

/** An active per-artifact hold or any active document hold on the application
 * blocks deletion (a cited document may be file-held). */
async function hasActiveHold(tx: Tx, artifactId: string, applicationId: string): Promise<boolean> {
	const own = await tx
		.select({ id: generatedArtifactHolds.id })
		.from(generatedArtifactHolds)
		.where(
			and(
				eq(generatedArtifactHolds.artifactId, artifactId),
				isNull(generatedArtifactHolds.releasedAt),
			),
		)
		.limit(1);
	if (own.length > 0) return true;
	const caseWide = await tx
		.select({ id: documentLegalHolds.id })
		.from(documentLegalHolds)
		.where(
			and(
				eq(documentLegalHolds.applicationId, applicationId),
				isNull(documentLegalHolds.releasedAt),
			),
		)
		.limit(1);
	return caseWide.length > 0;
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
	// Drizzle wraps driver errors in DrizzleQueryError; the postgres code
	// and constraint name live on `cause`.
	const seen = new Set<unknown>();
	let current: unknown = err;
	while (typeof current === "object" && current !== null && !seen.has(current)) {
		seen.add(current);
		const rec = current as Record<string, unknown>;
		if (rec["code"] === "23505") {
			const name = rec["constraint_name"];
			if (typeof name === "string" && name === constraint) return true;
			const detail = rec["detail"];
			if (typeof detail === "string" && detail.includes(constraint)) return true;
		}
		if (typeof rec["message"] === "string" && (rec["message"] as string).includes(constraint)) {
			return true;
		}
		current = rec["cause"];
	}
	return false;
}

async function nextVersion(
	tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
	applicationId: string,
	type: ArtifactType,
): Promise<number> {
	const rows = await tx
		.select({ version: generatedArtifacts.version })
		.from(generatedArtifacts)
		.where(
			and(eq(generatedArtifacts.applicationId, applicationId), eq(generatedArtifacts.type, type)),
		)
		.orderBy(desc(generatedArtifacts.version))
		.limit(1);
	return (rows[0]?.version ?? 0) + 1;
}

export async function createArtifact(db: Db, input: CreateArtifactInput): Promise<ArtifactDto> {
	const now = input.now ?? new Date();
	return artifactTx(db, async (tx) => {
		const version = await nextVersion(tx, input.applicationId, input.type);
		let row: ArtifactRow;
		try {
			[row] = await tx
				.insert(generatedArtifacts)
				.values({
					applicationId: input.applicationId,
					type: input.type,
					version,
					revision: 1,
					status: "draft" as ArtifactStatus,
					documentDerived: input.documentDerived ?? false,
					content: input.content,
					citations: input.citations,
					contentHash: hashCanonical(input.content),
					model: input.model,
					promptVersion: input.promptVersion,
					createdBy: input.createdBy,
					retentionUntil: addDays(now, input.retentionDays),
				})
				.returning();
		} catch (err) {
			if (isUniqueViolation(err, "generated_artifacts_active_draft_uniq")) {
				throw new HttpError(409, "DRAFT_EXISTS", "a draft already exists for this case and type");
			}
			if (isUniqueViolation(err, "generated_artifacts_case_type_version_uniq")) {
				throw new HttpError(409, "VERSION_CONFLICT", "a newer version was created concurrently");
			}
			throw err;
		}
		if (!row) throw new HttpError(500, "ARTIFACT_CREATE_FAILED", "artifact insert returned no row");
		await writeAudit(tx, {
			applicationId: input.applicationId,
			actor: input.createdBy,
			action: "artifact.created",
			entity: "generated_artifact",
			payload: {
				...input.auditMetadata,
				feature: "assist",
				artifactId: row.id,
				applicationId: input.applicationId,
				type: input.type,
				version,
				actorRole: input.actorRole ?? "officer",
				model: input.model,
				promptVersion: input.promptVersion,
				citationCount: input.citations.length,
			},
		});
		return toDto(row);
	});
}

export async function updateArtifact(
	db: Db,
	input: UpdateArtifactInput,
): Promise<{ artifact: ArtifactDto; createdVersion: boolean }> {
	const now = input.now ?? new Date();
	return artifactTx(db, async (tx) => {
		const locked = await tx
			.select()
			.from(generatedArtifacts)
			.where(eq(generatedArtifacts.id, input.id))
			.for("update");
		const row = locked[0];
		if (!row) throw new HttpError(404, "NOT_FOUND", "not found");
		if (row.status === "approved") {
			if (row.revision !== input.expectedRevision) {
				throw new HttpError(409, "VERSION_CONFLICT", "the artifact changed since it was read");
			}
			const version = await nextVersion(tx, row.applicationId, row.type);
			let created: ArtifactRow;
			try {
				[created] = await tx
					.insert(generatedArtifacts)
					.values({
						applicationId: row.applicationId,
						type: row.type,
						version,
						revision: 1,
						status: "draft" as ArtifactStatus,
						documentDerived: (input.documentDerived ?? false) || row.documentDerived,
						content: input.content,
						citations: input.citations,
						contentHash: hashCanonical(input.content),
						model: input.model,
						promptVersion: input.promptVersion,
						createdBy: input.actor,
						retentionUntil: addDays(now, input.retentionDays),
					})
					.returning();
			} catch (err) {
				if (isUniqueViolation(err, "generated_artifacts_active_draft_uniq")) {
					throw new HttpError(409, "DRAFT_EXISTS", "a draft already exists for this case and type");
				}
				if (isUniqueViolation(err, "generated_artifacts_case_type_version_uniq")) {
					throw new HttpError(409, "VERSION_CONFLICT", "a newer version was created concurrently");
				}
				throw err;
			}
			if (!created)
				throw new HttpError(500, "ARTIFACT_CREATE_FAILED", "artifact insert returned no row");
			await writeAudit(tx, {
				applicationId: row.applicationId,
				actor: input.actor,
				action: "artifact.version_created",
				entity: "generated_artifact",
				payload: {
					...input.auditMetadata,
					feature: "assist",
					artifactId: created.id,
					baseArtifactId: row.id,
					applicationId: row.applicationId,
					type: row.type,
					version,
					actorRole: input.actorRole ?? "officer",
					model: input.model,
					promptVersion: input.promptVersion,
				},
			});
			return { artifact: toDto(created), createdVersion: true };
		}
		if (row.status !== "draft") {
			throw new HttpError(409, "ARTIFACT_IMMUTABLE", "only drafts can be edited");
		}
		if (row.revision !== input.expectedRevision) {
			throw new HttpError(409, "VERSION_CONFLICT", "the draft changed since it was read");
		}
		const [updated] = await tx
			.update(generatedArtifacts)
			.set({
				content: input.content,
				citations: input.citations,
				contentHash: hashCanonical(input.content),
				documentDerived: (input.documentDerived ?? false) || row.documentDerived,
				model: input.model,
				promptVersion: input.promptVersion,
				revision: row.revision + 1,
			})
			.where(
				and(
					eq(generatedArtifacts.id, row.id),
					eq(generatedArtifacts.revision, input.expectedRevision),
				),
			)
			.returning();
		if (!updated) {
			throw new HttpError(409, "VERSION_CONFLICT", "the draft changed since it was read");
		}
		await writeAudit(tx, {
			applicationId: row.applicationId,
			actor: input.actor,
			action: "artifact.edited",
			entity: "generated_artifact",
			payload: {
				...input.auditMetadata,
				feature: "assist",
				artifactId: row.id,
				applicationId: row.applicationId,
				type: row.type,
				version: row.version,
				revision: updated.revision,
				actorRole: input.actorRole ?? "officer",
				model: input.model,
				promptVersion: input.promptVersion,
			},
		});
		return { artifact: toDto(updated), createdVersion: false };
	});
}

export async function approveArtifact(
	db: Db,
	input: {
		id: string;
		actor: string;
		actorRole?: string;
		expectedRevision: number;
		auditMetadata?: ArtifactAuditMetadata;
		now?: Date;
	},
): Promise<ArtifactDto> {
	const now = input.now ?? new Date();
	return artifactTx(db, async (tx) => {
		const locked = await tx
			.select()
			.from(generatedArtifacts)
			.where(eq(generatedArtifacts.id, input.id))
			.for("update");
		const row = locked[0];
		if (!row) throw new HttpError(404, "NOT_FOUND", "not found");
		if (row.status !== "draft") {
			throw new HttpError(409, "NOT_DRAFT", "only drafts can be approved");
		}
		if (row.revision !== input.expectedRevision) {
			throw new HttpError(409, "VERSION_CONFLICT", "the draft changed since it was read");
		}
		const prior = await tx
			.select()
			.from(generatedArtifacts)
			.where(
				and(
					eq(generatedArtifacts.applicationId, row.applicationId),
					eq(generatedArtifacts.type, row.type),
					eq(generatedArtifacts.status, "approved"),
				),
			)
			.for("update");
		for (const prev of prior) {
			if (prev.id === row.id) continue;
			await tx
				.update(generatedArtifacts)
				.set({ status: "superseded" as ArtifactStatus, supersededAt: now })
				.where(eq(generatedArtifacts.id, prev.id));
		}
		const [updated] = await tx
			.update(generatedArtifacts)
			.set({ status: "approved" as ArtifactStatus, approvedBy: input.actor, approvedAt: now })
			.where(
				and(
					eq(generatedArtifacts.id, row.id),
					eq(generatedArtifacts.status, "draft"),
					eq(generatedArtifacts.revision, input.expectedRevision),
				),
			)
			.returning();
		if (!updated) {
			const fresh = (
				await tx.select().from(generatedArtifacts).where(eq(generatedArtifacts.id, row.id))
			)[0];
			if (!fresh || fresh.status !== "draft") {
				throw new HttpError(409, "NOT_DRAFT", "only drafts can be approved");
			}
			throw new HttpError(409, "VERSION_CONFLICT", "the draft changed since it was read");
		}
		await writeAudit(tx, {
			applicationId: row.applicationId,
			actor: input.actor,
			action: "artifact.approved",
			entity: "generated_artifact",
			payload: {
				...input.auditMetadata,
				feature: "assist",
				artifactId: row.id,
				applicationId: row.applicationId,
				type: row.type,
				version: row.version,
				revision: row.revision,
				actorRole: input.actorRole ?? "officer",
				model: row.model,
				promptVersion: row.promptVersion,
			},
		});
		return toDto(updated);
	});
}

export async function tombstoneArtifact(
	db: Db,
	input: {
		id: string;
		actor: string;
		actorRole?: string;
		expectedRevision: number;
		reason: string;
		now?: Date;
	},
): Promise<ArtifactDto> {
	const now = input.now ?? new Date();
	return artifactTx(db, async (tx) => {
		const locked = await tx
			.select()
			.from(generatedArtifacts)
			.where(eq(generatedArtifacts.id, input.id))
			.for("update");
		const row = locked[0];
		if (!row) throw new HttpError(404, "NOT_FOUND", "not found");
		if (row.status === "deleted" || row.status === "superseded") {
			throw new HttpError(409, "ARTIFACT_IMMUTABLE", "the artifact is terminal");
		}
		if (row.revision !== input.expectedRevision) {
			throw new HttpError(409, "VERSION_CONFLICT", "the artifact changed since it was read");
		}
		await lockArtifactCase(tx, row.applicationId);
		if (await hasActiveHold(tx, row.id, row.applicationId)) {
			throw new HttpError(409, "LEGAL_HOLD", "an active legal hold blocks deletion");
		}
		const [updated] = await tx
			.update(generatedArtifacts)
			.set({
				status: "deleted" as ArtifactStatus,
				deletedAt: now,
				content: {},
				citations: [],
				contentHash: hashCanonical({}),
			})
			.where(
				and(
					eq(generatedArtifacts.id, row.id),
					eq(generatedArtifacts.revision, input.expectedRevision),
				),
			)
			.returning();
		if (!updated)
			throw new HttpError(409, "VERSION_CONFLICT", "the artifact changed since it was read");
		await writeAudit(tx, {
			applicationId: row.applicationId,
			actor: input.actor,
			action: "artifact.tombstoned",
			entity: "generated_artifact",
			payload: {
				feature: "assist",
				artifactId: row.id,
				applicationId: row.applicationId,
				type: row.type,
				version: row.version,
				actorRole: input.actorRole ?? "officer",
				model: row.model,
				promptVersion: row.promptVersion,
				reasonHash: createHash("sha256").update(input.reason, "utf8").digest("hex"),
				reasonLength: input.reason.length,
			},
		});
		return toDto(updated);
	});
}

export async function getArtifact(db: Db, id: string): Promise<ArtifactDto | null> {
	const rows = await db
		.select()
		.from(generatedArtifacts)
		.where(eq(generatedArtifacts.id, id))
		.limit(1);
	const row = rows[0];
	return row ? toDto(row) : null;
}

export async function listArtifacts(
	db: Db,
	applicationId: string,
	type?: ArtifactType,
): Promise<ArtifactDto[]> {
	const rows = await db
		.select()
		.from(generatedArtifacts)
		.where(
			type === undefined
				? eq(generatedArtifacts.applicationId, applicationId)
				: and(
						eq(generatedArtifacts.applicationId, applicationId),
						eq(generatedArtifacts.type, type),
					),
		)
		.orderBy(desc(generatedArtifacts.version));
	return rows.map(toDto);
}

export async function createArtifactHold(
	db: Db,
	input: { artifactId: string; reason: string; createdBy: string; actorRole?: string; now?: Date },
): Promise<{ holdId: string; artifactId: string }> {
	return artifactTx(db, async (tx) => {
		const rows = await tx
			.select()
			.from(generatedArtifacts)
			.where(eq(generatedArtifacts.id, input.artifactId))
			.limit(1)
			.for("update");
		const artifact = rows[0];
		if (!artifact) throw new HttpError(404, "NOT_FOUND", "not found");
		if (artifact.status === "deleted") {
			throw new HttpError(409, "ARTIFACT_DELETED", "the artifact is already deleted");
		}
		await lockArtifactCase(tx, artifact.applicationId);
		const [hold] = await tx
			.insert(generatedArtifactHolds)
			.values({
				artifactId: artifact.id,
				applicationId: artifact.applicationId,
				reason: input.reason,
				createdBy: input.createdBy,
			})
			.returning();
		await writeAudit(tx, {
			applicationId: artifact.applicationId,
			actor: input.createdBy,
			action: "artifact.hold_created",
			entity: "generated_artifact",
			payload: {
				feature: "assist",
				artifactId: artifact.id,
				applicationId: artifact.applicationId,
				type: artifact.type,
				version: artifact.version,
				holdId: hold.id,
				actorRole: input.actorRole ?? "service",
				model: artifact.model,
				promptVersion: artifact.promptVersion,
			},
		});
		return { holdId: hold.id, artifactId: artifact.id };
	});
}

export async function releaseArtifactHold(
	db: Db,
	input: { artifactId: string; holdId: string; actor: string; actorRole?: string; now?: Date },
): Promise<{ holdId: string; artifactId: string }> {
	const now = input.now ?? new Date();
	return artifactTx(db, async (tx) => {
		const rows = await tx
			.select()
			.from(generatedArtifactHolds)
			.where(
				and(
					eq(generatedArtifactHolds.id, input.holdId),
					eq(generatedArtifactHolds.artifactId, input.artifactId),
				),
			)
			.limit(1)
			.for("update");
		const hold = rows[0];
		if (!hold) throw new HttpError(404, "NOT_FOUND", "not found");
		if (!hold.releasedAt) {
			await tx
				.update(generatedArtifactHolds)
				.set({ releasedAt: now })
				.where(eq(generatedArtifactHolds.id, hold.id));
			const artifact = (
				await tx
					.select()
					.from(generatedArtifacts)
					.where(eq(generatedArtifacts.id, hold.artifactId))
					.limit(1)
			)[0];
			await writeAudit(tx, {
				applicationId: hold.applicationId,
				actor: input.actor,
				action: "artifact.hold_released",
				entity: "generated_artifact",
				payload: {
					feature: "assist",
					artifactId: hold.artifactId,
					applicationId: hold.applicationId,
					holdId: hold.id,
					actorRole: input.actorRole ?? "service",
					...(artifact
						? {
								type: artifact.type,
								version: artifact.version,
								model: artifact.model,
								promptVersion: artifact.promptVersion,
							}
						: {}),
				},
			});
		}
		return { holdId: hold.id, artifactId: hold.artifactId };
	});
}

export async function runArtifactRetention(
	db: Db,
	input: { now?: Date; limit?: number },
): Promise<{ checked: number; deleted: number; skippedHolds: number }> {
	const now = input.now ?? new Date();
	const limit = input.limit ?? 500;
	const expired = await db
		.select()
		.from(generatedArtifacts)
		.where(
			and(
				sql`${generatedArtifacts.status} <> 'deleted'`,
				lte(generatedArtifacts.retentionUntil, now),
			),
		)
		.orderBy(generatedArtifacts.retentionUntil)
		.limit(limit);
	const result = { checked: 0, deleted: 0, skippedHolds: 0 };
	for (const candidate of expired) {
		await artifactTx(db, async (tx) => {
			const locked = await tx
				.select()
				.from(generatedArtifacts)
				.where(eq(generatedArtifacts.id, candidate.id))
				.for("update");
			const fresh = locked[0];
			if (!fresh || fresh.status === "deleted" || fresh.retentionUntil > now) return;
			result.checked++;
			await lockArtifactCase(tx, fresh.applicationId);
			if (await hasActiveHold(tx, fresh.id, fresh.applicationId)) {
				result.skippedHolds++;
				return;
			}
			await tx
				.update(generatedArtifacts)
				.set({
					status: "deleted" as ArtifactStatus,
					deletedAt: now,
					content: {},
					citations: [],
					contentHash: hashCanonical({}),
				})
				.where(eq(generatedArtifacts.id, fresh.id));
			await writeAudit(tx, {
				applicationId: fresh.applicationId,
				actor: "system",
				action: "artifact.retention_deleted",
				entity: "generated_artifact",
				payload: {
					feature: "assist",
					artifactId: fresh.id,
					applicationId: fresh.applicationId,
					type: fresh.type,
					version: fresh.version,
					actorRole: "system",
					model: fresh.model,
					promptVersion: fresh.promptVersion,
				},
			});
			result.deleted++;
		});
	}
	return result;
}
