// EN-04/E2 persistence helpers: fingerprints, analysis results, panel reads,
// and the tx-aware brief artifact writer. Every write is scoped by
// application id; audit payloads carry ids/codes/counts only.

import {
	applications,
	documentConsistencyCandidates,
	documentCrosschecks,
	documentFieldCandidates,
	documentFiles,
	documentFindings,
	documentFingerprints,
	documentIntegrityRuns,
	documentPages,
	fraudReviews,
	generatedArtifacts,
	withTx,
	type Db,
	type Tx,
} from "@credit/db/applications";
import { and, desc, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import { codePointSlice, hashCanonical, type DocumentIntegrityBriefContent } from "@credit/core";
import { HttpError, writeAudit } from "@credit/service-kit";
import { memoAgentTraceSchema, type MemoAgentTrace } from "../assist/memo-trace.js";
import { lockApplication } from "../documents/access.js";
import { countDuplicateDocuments } from "./duplicates.js";
import { buildIntegritySignals } from "./signals.js";
import type { FingerprintValues } from "./fingerprint.js";
import type {
	IntegrityCandidateDto,
	IntegrityConsistencyDto,
	IntegrityConfig,
	IntegrityDocumentPanelDto,
	IntegrityFingerprintDto,
	IntegrityPanelDto,
	IntegrityRunTraceDto,
	ValidatedCandidate,
	ValidatedConsistency,
} from "./types.js";

type FingerprintRow = typeof documentFingerprints.$inferSelect;
type CandidateRow = typeof documentFieldCandidates.$inferSelect;
type ConsistencyRow = typeof documentConsistencyCandidates.$inferSelect;
type RunRow = typeof documentIntegrityRuns.$inferSelect;

export function fingerprintDto(row: FingerprintRow): IntegrityFingerprintDto {
	return {
		sha256: row.sha256,
		sizeBytes: row.sizeBytes,
		mimeType: row.mimeType,
		pageCount: row.pageCount,
		ocrConfidence: row.ocrConfidence,
		producer: row.producer,
		creator: row.creator,
		metadataCreatedAt: row.metadataCreatedAt?.toISOString() ?? null,
		metadataModifiedAt: row.metadataModifiedAt?.toISOString() ?? null,
		metadataSource: row.metadataSource as IntegrityFingerprintDto["metadataSource"],
		editSignal: row.editSignal,
		editCodes: row.editCodes,
		fingerprintVersion: row.fingerprintVersion,
	};
}

export async function writeFingerprint(tx: Tx, values: FingerprintValues): Promise<void> {
	await tx
		.insert(documentFingerprints)
		.values({
			documentFileId: values.documentFileId,
			applicationId: values.applicationId,
			fingerprintVersion: values.fingerprintVersion,
			sha256: values.sha256,
			sizeBytes: values.sizeBytes,
			mimeType: values.mimeType,
			pageCount: values.pageCount,
			ocrConfidence: values.ocrConfidence,
			producer: values.producer,
			creator: values.creator,
			metadataCreatedAt: values.metadataCreatedAt,
			metadataModifiedAt: values.metadataModifiedAt,
			metadataSource: values.metadataSource,
			editSignal: values.editSignal,
			editCodes: values.editCodes,
		})
		.onConflictDoNothing({ target: documentFingerprints.documentFileId });
}

/** Fill missing fingerprints for legacy/reused/seeded rows. Never infers
 * provenance: only copies metadata already on document_files. */
export async function ensureFingerprints(
	db: Db,
	applicationId: string,
	now: Date = new Date(),
): Promise<void> {
	void now;
	const files = await db
		.select()
		.from(documentFiles)
		.where(and(eq(documentFiles.applicationId, applicationId), eq(documentFiles.status, "ready")));
	if (files.length === 0) return;
	const existing = await db
		.select({ id: documentFingerprints.documentFileId })
		.from(documentFingerprints)
		.where(
			inArray(
				documentFingerprints.documentFileId,
				files.map((file) => file.id),
			),
		);
	const have = new Set(existing.map((row) => row.id));
	const missing = files.filter((file) => !have.has(file.id));
	if (missing.length === 0) return;
	await db
		.insert(documentFingerprints)
		.values(
			missing.map((file) => ({
				documentFileId: file.id,
				applicationId,
				fingerprintVersion: "document-fingerprint-v1",
				sha256: file.sha256,
				sizeBytes: file.sizeBytes,
				mimeType: file.mimeType,
				pageCount: file.pageCount,
				ocrConfidence: file.ocrConfidence,
				producer: "unknown",
				creator: "unknown",
				metadataSource: "unknown",
				editSignal: "unknown" as const,
				editCodes: [],
			})),
		)
		.onConflictDoNothing({ target: documentFingerprints.documentFileId });
}

export async function updateFingerprintOcr(
	tx: Tx,
	documentFileId: string,
	input: { ocrConfidence: number | null; pageCount: number },
): Promise<void> {
	await tx
		.update(documentFingerprints)
		.set({
			ocrConfidence: input.ocrConfidence,
			pageCount: input.pageCount,
			updatedAt: new Date(),
		})
		.where(eq(documentFingerprints.documentFileId, documentFileId));
}

/** Refresh all provenance fields after a retry extraction (producer, dates,
 * edit signals). Never infers: absent metadata becomes `unknown`. */
export async function updateFingerprint(tx: Tx, values: FingerprintValues): Promise<void> {
	await tx
		.update(documentFingerprints)
		.set({
			sha256: values.sha256,
			sizeBytes: values.sizeBytes,
			mimeType: values.mimeType,
			pageCount: values.pageCount,
			ocrConfidence: values.ocrConfidence,
			producer: values.producer,
			creator: values.creator,
			metadataCreatedAt: values.metadataCreatedAt,
			metadataModifiedAt: values.metadataModifiedAt,
			metadataSource: values.metadataSource,
			editSignal: values.editSignal,
			editCodes: values.editCodes,
			updatedAt: new Date(),
		})
		.where(eq(documentFingerprints.documentFileId, values.documentFileId));
}

export interface InsertAnalysisResultsInput {
	applicationId: string;
	runId: string;
	candidates: ValidatedCandidate[];
	consistency: ValidatedConsistency[];
	now?: Date;
}

/** Persist one successful analysis run's results. A prior officer-confirmed
 * candidate with the same evidence key keeps its confirmed status. */
export async function insertAnalysisResults(
	tx: Tx,
	input: InsertAnalysisResultsInput,
): Promise<void> {
	const now = input.now ?? new Date();
	if (input.candidates.length > 0) {
		const priorConfirmed = await tx
			.select()
			.from(documentFieldCandidates)
			.where(
				and(
					eq(documentFieldCandidates.applicationId, input.applicationId),
					eq(documentFieldCandidates.status, "confirmed"),
				),
			);
		const confirmedByKey = new Map(
			priorConfirmed.map((row) => [
				[row.documentFileId, row.field, row.normalizedValue, row.quoteHash].join("|"),
				row,
			]),
		);
		await tx
			.insert(documentFieldCandidates)
			.values(
				input.candidates.map((candidate) => {
					const prior = confirmedByKey.get(
						[
							candidate.documentFileId,
							candidate.field,
							candidate.normalizedValue,
							candidate.quoteHash,
						].join("|"),
					);
					return {
						applicationId: input.applicationId,
						documentFileId: candidate.documentFileId,
						runId: input.runId,
						field: candidate.field,
						value: candidate.value,
						normalizedValue: candidate.normalizedValue,
						pageNumber: candidate.pageNumber,
						offsetStart: candidate.offsetStart,
						offsetEnd: candidate.offsetEnd,
						quote: candidate.quote,
						quoteHash: candidate.quoteHash,
						confidence: candidate.confidence,
						status: prior ? ("confirmed" as const) : candidate.status,
						validationCodes: candidate.validationCodes,
						confirmedBy: prior?.confirmedBy ?? null,
						confirmedAt: prior?.confirmedAt ?? null,
						createdAt: now,
					};
				}),
			)
			.onConflictDoNothing();
	}
	if (input.consistency.length > 0) {
		await tx
			.insert(documentConsistencyCandidates)
			.values(
				input.consistency.map((item) => ({
					applicationId: input.applicationId,
					runId: input.runId,
					field: item.field,
					proposedKind: item.proposedKind,
					kind: item.kind,
					severity: item.severity,
					comparisonBasis: item.comparisonBasis,
					leftDocumentFileId: item.left.documentFileId,
					leftPageNumber: item.left.pageNumber,
					leftValue: item.left.value,
					leftLabel: item.left.label,
					leftCurrency: item.left.currency,
					leftQuote: item.left.quote,
					leftOffsetStart: item.left.offsetStart,
					leftOffsetEnd: item.left.offsetEnd,
					leftQuoteHash: item.left.quoteHash,
					rightDocumentFileId: item.right.documentFileId,
					rightPageNumber: item.right.pageNumber,
					rightValue: item.right.value,
					rightLabel: item.right.label,
					rightCurrency: item.right.currency,
					rightQuote: item.right.quote,
					rightOffsetStart: item.right.offsetStart,
					rightOffsetEnd: item.right.offsetEnd,
					rightQuoteHash: item.right.quoteHash,
					explanation: item.explanation,
					explanationVerified: item.explanationVerified,
					status: item.status,
					reason: item.reason,
					createdAt: now,
				})),
			)
			.onConflictDoNothing();
	}
}

export function runTraceDto(row: RunRow): IntegrityRunTraceDto {
	return {
		id: row.id,
		feature: "document_analysis",
		status: row.status,
		model: row.model,
		promptVersion: row.promptVersion,
		agentVersion: row.agentVersion,
		steps: row.steps,
		toolCalls: Array.isArray(row.toolCalls)
			? (row.toolCalls as IntegrityRunTraceDto["toolCalls"])
			: [],
		sourceRefs: Array.isArray(row.sourceRefs) ? row.sourceRefs : [],
		repairAttempted: row.repairAttempted,
		repairSucceeded: row.repairSucceeded,
		usage:
			row.usage && typeof row.usage === "object"
				? (row.usage as IntegrityRunTraceDto["usage"])
				: null,
		errorCode: row.errorCode,
		createdAt: row.createdAt.toISOString(),
		finishedAt: row.finishedAt?.toISOString() ?? null,
	};
}

function candidateDto(row: CandidateRow, pageText: string | null): IntegrityCandidateDto {
	const stale =
		row.redactedAt !== null ||
		pageText === null ||
		codePointSlice(pageText, row.offsetStart, row.offsetEnd) !== row.quote;
	return {
		id: row.id,
		documentFileId: row.documentFileId,
		field: row.field,
		value: row.value,
		pageNumber: row.pageNumber,
		offsetStart: row.offsetStart,
		offsetEnd: row.offsetEnd,
		confidence: row.confidence,
		status: row.redactedAt !== null ? "rejected" : row.status,
		validationCodes: row.validationCodes,
		confirmedAt: row.confirmedAt?.toISOString() ?? null,
		stale,
	};
}

function consistencyDto(row: ConsistencyRow): IntegrityConsistencyDto | null {
	if (row.status === "rejected" || row.redactedAt !== null) return null;
	const findingState =
		row.status === "confirmed" && row.kind === "mismatch"
			? "mismatch"
			: row.status === "confirmed" && row.kind === "match"
				? "match"
				: "needs_chase";
	return {
		id: row.id,
		field: row.field,
		proposedKind: row.proposedKind,
		findingState,
		severity: row.severity,
		left: {
			documentFileId: row.leftDocumentFileId,
			pageNumber: row.leftPageNumber,
			value: row.leftValue,
			label: row.leftLabel,
			currency: row.leftCurrency,
			quote: row.leftQuote,
			offsetStart: row.leftOffsetStart,
			offsetEnd: row.leftOffsetEnd,
		},
		right: {
			documentFileId: row.rightDocumentFileId,
			pageNumber: row.rightPageNumber,
			value: row.rightValue,
			label: row.rightLabel,
			currency: row.rightCurrency,
			quote: row.rightQuote,
			offsetStart: row.rightOffsetStart,
			offsetEnd: row.rightOffsetEnd,
		},
		explanation: row.explanation,
		reason: row.reason,
	};
}

export async function loadIntegrityPanel(
	db: Db,
	applicationId: string,
	config: IntegrityConfig,
	now: Date = new Date(),
): Promise<IntegrityPanelDto> {
	const [application] = await db
		.select()
		.from(applications)
		.where(eq(applications.id, applicationId))
		.limit(1);
	if (!application) throw new HttpError(404, "NOT_FOUND", "not found");
	await ensureFingerprints(db, applicationId, now);

	const files = await db
		.select()
		.from(documentFiles)
		.where(
			and(
				eq(documentFiles.applicationId, applicationId),
				ne(documentFiles.status, "deleted"),
				gt(documentFiles.retentionUntil, now),
				isNull(documentFiles.blobPurgedAt),
			),
		)
		.orderBy(desc(documentFiles.uploadedAt))
		.limit(20);
	const fingerprints = await db
		.select()
		.from(documentFingerprints)
		.where(eq(documentFingerprints.applicationId, applicationId));
	const fingerprintByFile = new Map(fingerprints.map((row) => [row.documentFileId, row]));

	const [latestRun] = await db
		.select()
		.from(documentIntegrityRuns)
		.where(
			and(
				eq(documentIntegrityRuns.applicationId, applicationId),
				eq(documentIntegrityRuns.feature, "document_analysis"),
				eq(documentIntegrityRuns.status, "succeeded"),
			),
		)
		.orderBy(desc(documentIntegrityRuns.createdAt))
		.limit(1);
	const [latestRunAny] = await db
		.select()
		.from(documentIntegrityRuns)
		.where(
			and(
				eq(documentIntegrityRuns.applicationId, applicationId),
				eq(documentIntegrityRuns.feature, "document_analysis"),
			),
		)
		.orderBy(desc(documentIntegrityRuns.createdAt))
		.limit(1);

	const candidates = latestRun
		? await db
				.select()
				.from(documentFieldCandidates)
				.where(eq(documentFieldCandidates.runId, latestRun.id))
				.orderBy(documentFieldCandidates.createdAt)
		: [];
	const consistency = latestRun
		? await db
				.select()
				.from(documentConsistencyCandidates)
				.where(eq(documentConsistencyCandidates.runId, latestRun.id))
				.orderBy(documentConsistencyCandidates.createdAt)
		: [];

	const pageTextByFile = new Map<string, Map<number, string>>();
	if (candidates.length > 0) {
		const pageRows = await db
			.select({
				documentFileId: documentPages.documentFileId,
				pageNumber: documentPages.pageNumber,
				text: documentPages.text,
			})
			.from(documentPages)
			.where(
				inArray(documentPages.documentFileId, [
					...new Set(candidates.map((row) => row.documentFileId)),
				]),
			);
		for (const row of pageRows) {
			const map = pageTextByFile.get(row.documentFileId) ?? new Map<number, string>();
			map.set(row.pageNumber, row.text);
			pageTextByFile.set(row.documentFileId, map);
		}
	}

	const [crosscheck] = await db
		.select()
		.from(documentCrosschecks)
		.where(
			and(
				eq(documentCrosschecks.applicationId, applicationId),
				eq(documentCrosschecks.status, "succeeded"),
			),
		)
		.orderBy(desc(documentCrosschecks.startedAt))
		.limit(1);
	const findings = crosscheck
		? await db
				.select()
				.from(documentFindings)
				.where(eq(documentFindings.crosscheckId, crosscheck.id))
		: [];

	const perDocumentDuplicates = new Map<
		string,
		{ sameApplication: number; sameApplicantOther: number; crossApplicant: number }
	>();
	for (const file of files) {
		perDocumentDuplicates.set(
			file.id,
			await countDuplicateDocuments(
				db,
				file.sha256,
				applicationId,
				application.applicantUserId,
				now,
			),
		);
	}
	const caseDuplicateCounts = {
		sameApplication: Math.max(
			0,
			...[...perDocumentDuplicates.values()].map((count) => count.sameApplication),
		),
		sameApplicantOther: Math.max(
			0,
			...[...perDocumentDuplicates.values()].map((count) => count.sameApplicantOther),
		),
		crossApplicant: Math.max(
			0,
			...[...perDocumentDuplicates.values()].map((count) => count.crossApplicant),
		),
	};
	const unconfirmedConsistency = consistency.filter(
		(row) => row.status === "candidate" && row.proposedKind === "mismatch",
	).length;
	const signals = buildIntegritySignals({
		documents: files
			.filter((file) => file.status === "ready")
			.map((file) => {
				const fingerprint = fingerprintByFile.get(file.id);
				return {
					documentFileId: file.id,
					textLayerRisk: file.textLayerRisk,
					ocrStatus: file.ocrStatus,
					ocrConfidence: file.ocrConfidence,
					editSignal: fingerprint?.editSignal ?? "unknown",
					editCodes: fingerprint?.editCodes ?? [],
				};
			}),
		crosscheckFindings: findings.map((finding) => ({
			id: finding.id,
			field: finding.field,
			status: finding.status,
			confidence: finding.confidence,
			expected: finding.expected,
			observed: finding.observed,
			documentFileId: finding.documentFileId,
			pageNumber: finding.pageNumber,
			quote: finding.quote,
			quoteStart: finding.quoteStart,
			quoteEnd: finding.quoteEnd,
			quoteHash: finding.quoteHash,
			reason: finding.reason,
		})),
		duplicateCounts: caseDuplicateCounts,
		unconfirmedConsistencyCount: unconfirmedConsistency,
		minOcrConfidence: 0.7,
	});
	const caseSignals = signals.filter(
		(signal) => signal.documentFileId === null && !signal.code.startsWith("duplicate_hash_"),
	);

	const [review] = await db
		.select()
		.from(fraudReviews)
		.where(
			and(
				eq(fraudReviews.applicationId, applicationId),
				inArray(fraudReviews.status, ["open", "needs_info"]),
			),
		)
		.limit(1);

	const panelDocuments: IntegrityDocumentPanelDto[] = files.map((file) => {
		const fingerprint = fingerprintByFile.get(file.id);
		const docCandidates = candidates.filter((row) => row.documentFileId === file.id);
		const docConsistency = consistency.filter(
			(row) => row.leftDocumentFileId === file.id || row.rightDocumentFileId === file.id,
		);
		const duplicates = perDocumentDuplicates.get(file.id) ?? {
			sameApplication: 0,
			sameApplicantOther: 0,
			crossApplicant: 0,
		};
		return {
			documentFileId: file.id,
			kind: file.kind,
			status: file.status,
			ocrStatus: file.ocrStatus,
			originalFilename: file.originalFilename,
			fingerprint: fingerprint ? fingerprintDto(fingerprint) : null,
			signals: signals.filter((signal) => signal.documentFileId === file.id),
			duplicateCount: duplicates.sameApplication,
			crossApplicationRestricted: duplicates.crossApplicant > 0,
			candidates: docCandidates.map((row) =>
				candidateDto(row, pageTextByFile.get(row.documentFileId)?.get(row.pageNumber) ?? null),
			),
			consistency: docConsistency
				.map(consistencyDto)
				.filter((item): item is IntegrityConsistencyDto => item !== null),
		};
	});

	return {
		documents: panelDocuments,
		caseSignals,
		latestAnalysis: latestRunAny ? runTraceDto(latestRunAny) : null,
		openReview: review
			? {
					id: review.id,
					status: review.status,
					severity: review.severity,
					reasonCode: review.reasonCode,
					createdAt: review.createdAt.toISOString(),
				}
			: null,
	};
}

export interface InsertBriefArtifactInput {
	applicationId: string;
	content: DocumentIntegrityBriefContent;
	citations: Array<{ ref: string; quote: string }>;
	agentTrace: MemoAgentTrace;
	evidenceHash: string;
	model: string;
	promptVersion: string;
	retentionDays: number;
	createdBy: string;
	auditActor: string;
	now?: Date;
}

/** Tx-aware brief writer. Does not reuse assist/createArtifact: that opens its
 * own transaction and audits feature "assist". Supersedes a prior draft brief
 * for the same case so the active draft stays unique. */
export async function insertBriefArtifact(
	tx: Tx,
	input: InsertBriefArtifactInput,
): Promise<string> {
	const parsedTrace = memoAgentTraceSchema.safeParse(input.agentTrace);
	if (!parsedTrace.success) {
		throw new HttpError(500, "ARTIFACT_TRACE_INVALID", "agent trace failed validation");
	}
	const now = input.now ?? new Date();
	await lockApplication(tx, input.applicationId, 5_000);
	const [versionRow] = await tx
		.select({ version: generatedArtifacts.version })
		.from(generatedArtifacts)
		.where(
			and(
				eq(generatedArtifacts.applicationId, input.applicationId),
				eq(generatedArtifacts.type, "document_integrity_brief"),
			),
		)
		.orderBy(desc(generatedArtifacts.version))
		.limit(1);
	const version = (versionRow?.version ?? 0) + 1;
	const priorDrafts = await tx
		.select({ id: generatedArtifacts.id })
		.from(generatedArtifacts)
		.where(
			and(
				eq(generatedArtifacts.applicationId, input.applicationId),
				eq(generatedArtifacts.type, "document_integrity_brief"),
				eq(generatedArtifacts.status, "draft"),
			),
		)
		.for("update");
	for (const draft of priorDrafts) {
		await tx
			.update(generatedArtifacts)
			.set({ status: "superseded", supersededAt: now })
			.where(eq(generatedArtifacts.id, draft.id));
		await writeAudit(tx, {
			applicationId: input.applicationId,
			actor: input.auditActor,
			action: "artifact.superseded",
			entity: "generated_artifact",
			payload: {
				feature: "document_integrity",
				artifactId: draft.id,
				applicationId: input.applicationId,
				type: "document_integrity_brief",
				supersededByVersion: version,
			},
		});
	}
	const [row] = await tx
		.insert(generatedArtifacts)
		.values({
			applicationId: input.applicationId,
			type: "document_integrity_brief",
			version,
			revision: 1,
			status: "draft",
			documentDerived: true,
			content: input.content,
			citations: input.citations,
			contentHash: hashCanonical(input.content),
			agentTrace: parsedTrace.data,
			evidenceHash: input.evidenceHash,
			model: input.model,
			promptVersion: input.promptVersion,
			createdBy: input.createdBy,
			retentionUntil: new Date(now.getTime() + input.retentionDays * 86_400_000),
		})
		.returning({ id: generatedArtifacts.id });
	if (!row) throw new HttpError(500, "ARTIFACT_CREATE_FAILED", "artifact insert returned no row");
	await writeAudit(tx, {
		applicationId: input.applicationId,
		actor: input.auditActor,
		action: "artifact.created",
		entity: "generated_artifact",
		payload: {
			feature: "document_integrity",
			artifactId: row.id,
			applicationId: input.applicationId,
			type: "document_integrity_brief",
			version,
			model: input.model,
			promptVersion: input.promptVersion,
			agentVersion: parsedTrace.data.agentVersion,
			toolCallCount: parsedTrace.data.toolCalls.length,
			citationCount: input.citations.length,
		},
	});
	return row.id;
}

export async function getBriefArtifact(
	db: Db,
	artifactId: string,
): Promise<{
	id: string;
	applicationId: string;
	status: string;
	content: unknown;
	citations: unknown;
	agentTrace: unknown;
	model: string;
	promptVersion: string;
	createdAt: Date;
} | null> {
	const [row] = await db
		.select()
		.from(generatedArtifacts)
		.where(eq(generatedArtifacts.id, artifactId))
		.limit(1);
	if (!row || row.type !== "document_integrity_brief") return null;
	return {
		id: row.id,
		applicationId: row.applicationId,
		status: row.status,
		content: row.content,
		citations: row.citations,
		agentTrace: row.agentTrace,
		model: row.model,
		promptVersion: row.promptVersion,
		createdAt: row.createdAt,
	};
}

export async function tombstoneDraftBrief(
	tx: Tx,
	artifactId: string,
	applicationId: string,
	actor: string,
	now: Date,
): Promise<void> {
	await tx
		.update(generatedArtifacts)
		.set({
			status: "deleted",
			content: {},
			citations: [],
			deletedAt: now,
		})
		.where(
			and(
				eq(generatedArtifacts.id, artifactId),
				eq(generatedArtifacts.applicationId, applicationId),
				eq(generatedArtifacts.status, "draft"),
			),
		);
	await writeAudit(tx, {
		applicationId,
		actor,
		action: "artifact.deleted",
		entity: "generated_artifact",
		payload: { feature: "document_integrity", artifactId, applicationId },
	});
}

/** Compatibility helper for callers that already have a Db. */
export async function withIntegrityTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
	return withTx(db, fn);
}

export type { RunRow };
