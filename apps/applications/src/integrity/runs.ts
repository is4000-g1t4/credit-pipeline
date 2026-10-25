// US-INT-1/3 async run queue.
//
// Analysis runs are officer-requested; triage runs are created only for an
// active deterministic flag. A short claim transaction leases one row with
// FOR UPDATE SKIP LOCKED; the model call runs outside that transaction and a
// second transaction finalizes under the lease token. Attempts increment at
// claim, so a crash cannot buy unbounded retries. Stale work fails at the cap.

import { randomUUID } from "node:crypto";
import { documentIntegrityRuns, fraudReviews, type Db } from "@credit/db/applications";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { hashCanonical } from "@credit/core";
import { HttpError, writeAudit, type Logger } from "@credit/service-kit";
import { lockApplication } from "../documents/access.js";
import { runIntegrityAnalysis } from "./agent.js";
import { insertAnalysisResults } from "./store.js";
import { loadIntegritySource } from "./source.js";
import { executeTriage } from "./triage.js";
import {
	IntegrityAgentError,
	type IntegrityAgentRunner,
	type IntegrityConfig,
	type IntegritySource,
} from "./types.js";

export interface IntegrityRunDeps {
	db: Db;
	config: IntegrityConfig;
	runner: IntegrityAgentRunner | null;
	logger: Logger;
	now?: () => Date;
}

type RunRow = typeof documentIntegrityRuns.$inferSelect;

function nowOf(deps: IntegrityRunDeps): Date {
	return deps.now?.() ?? new Date();
}

export function analysisInputHash(source: IntegritySource, config: IntegrityConfig): string {
	return hashCanonical({
		feature: "document_analysis",
		applicationId: source.applicationId,
		documentConsent: source.documentConsent,
		documents: source.documents
			.map((doc) => ({
				id: doc.documentFileId,
				sha256: doc.sha256,
				pageCount: doc.pageCount,
				ocrStatus: doc.ocrStatus,
				pages: doc.pages.map((page) => [page.pageNumber, page.textSha256]),
			}))
			.sort((a, b) => a.id.localeCompare(b.id)),
		fingerprintVersion: "document-fingerprint-v1",
		model: config.model,
		promptVersion: config.promptVersion,
		agentVersion: config.agentVersion,
	});
}

export function triageInputHash(
	source: IntegritySource,
	config: IntegrityConfig,
	reviewId: string,
): string {
	return hashCanonical({
		feature: "document_triage",
		applicationId: source.applicationId,
		reviewId,
		documentConsent: source.documentConsent,
		contextConsent: source.contextConsent,
		documents: source.documents
			.map((doc) => ({
				id: doc.documentFileId,
				sha256: doc.sha256,
				pageCount: doc.pageCount,
				ocrStatus: doc.ocrStatus,
				pages: doc.pages.map((page) => [page.pageNumber, page.textSha256]),
			}))
			.sort((a, b) => a.id.localeCompare(b.id)),
		customerDocuments: source.customerDocuments
			.map((doc) => ({
				id: doc.customerDocumentId,
				sha256Prefix: doc.sha256Prefix,
				pageCount: doc.pageCount,
				pages: doc.pages.map((page) => [page.pageNumber, page.textSha256]),
			}))
			.sort((a, b) => a.id.localeCompare(b.id)),
		signals: source.signals.map((signal) => signal.code).sort(),
		duplicates: source.duplicateMatches
			.map((match) => [match.sourceDocumentFileId, match.matchingDocumentFileId, match.relation])
			.sort(),
		crosscheck:
			source.crosscheck?.findings
				.map((finding) => [
					finding.id,
					finding.field,
					finding.status,
					finding.confidence,
					finding.quoteHash,
				])
				.sort() ?? [],
		fingerprintVersion: "document-fingerprint-v1",
		model: config.model,
		promptVersion: config.triagePromptVersion,
		agentVersion: config.agentVersion,
	});
}

async function recentRunCount(
	db: Db,
	applicationId: string,
	feature: "document_analysis" | "document_triage",
	inputHash: string,
	since: Date,
): Promise<number> {
	const rows = await db
		.select({ id: documentIntegrityRuns.id })
		.from(documentIntegrityRuns)
		.where(
			and(
				eq(documentIntegrityRuns.applicationId, applicationId),
				eq(documentIntegrityRuns.feature, feature),
				eq(documentIntegrityRuns.inputHash, inputHash),
				gte(documentIntegrityRuns.createdAt, since),
			),
		);
	return rows.length;
}

async function findActiveRun(
	db: Db,
	applicationId: string,
	feature: "document_analysis" | "document_triage",
	inputHash: string,
): Promise<RunRow | null> {
	const rows = await db
		.select()
		.from(documentIntegrityRuns)
		.where(
			and(
				eq(documentIntegrityRuns.applicationId, applicationId),
				eq(documentIntegrityRuns.feature, feature),
				eq(documentIntegrityRuns.inputHash, inputHash),
				sql`${documentIntegrityRuns.status} IN ('queued','running','succeeded')`,
			),
		)
		.orderBy(desc(documentIntegrityRuns.createdAt))
		.limit(1);
	return rows[0] ?? null;
}

interface CreateRunInput {
	applicationId: string;
	feature: "document_analysis" | "document_triage";
	inputHash: string;
	documentSha256: string[];
	requestedBy: string;
	fraudReviewId?: string | null;
	reviewVersion?: number | null;
	now?: Date;
}

export async function createIntegrityRun(
	deps: IntegrityRunDeps,
	input: CreateRunInput,
): Promise<{ run: RunRow; replayed: boolean }> {
	const { db, config } = deps;
	const existing = await findActiveRun(db, input.applicationId, input.feature, input.inputHash);
	if (existing) return { run: existing, replayed: true };
	const now = input.now ?? nowOf(deps);
	const since = new Date(now.getTime() - 24 * 3_600_000);
	const attempts = await recentRunCount(
		db,
		input.applicationId,
		input.feature,
		input.inputHash,
		since,
	);
	if (attempts >= config.maxRunsPerHash) {
		throw new HttpError(429, "RETRY_LIMIT", "too many runs for this evidence set");
	}
	const promptVersion =
		input.feature === "document_triage" ? config.triagePromptVersion : config.promptVersion;
	const [inserted] = await db
		.insert(documentIntegrityRuns)
		.values({
			applicationId: input.applicationId,
			feature: input.feature,
			status: "queued",
			inputHash: input.inputHash,
			documentSha256: input.documentSha256,
			fingerprintVersion: "document-fingerprint-v1",
			model: config.model,
			promptVersion,
			agentVersion: config.agentVersion,
			requestedBy: input.requestedBy,
			fraudReviewId: input.fraudReviewId ?? null,
			reviewVersion: input.reviewVersion ?? null,
			createdAt: now,
		})
		.onConflictDoNothing({
			target: [
				documentIntegrityRuns.applicationId,
				documentIntegrityRuns.feature,
				documentIntegrityRuns.inputHash,
			],
			where: sql`${documentIntegrityRuns.status} IN ('queued','running','succeeded')`,
		})
		.returning();
	if (inserted) return { run: inserted, replayed: false };
	const winner = await findActiveRun(db, input.applicationId, input.feature, input.inputHash);
	if (!winner) throw new HttpError(500, "INTERNAL_ERROR", "internal error");
	return { run: winner, replayed: true };
}

export async function enqueueTriageRun(
	deps: IntegrityRunDeps,
	input: {
		applicationId: string;
		reviewId: string;
		reviewVersion: number;
		source: IntegritySource;
		requestedBy: string;
	},
): Promise<{ run: RunRow; replayed: boolean } | null> {
	if (
		!deps.config.triageEnabled ||
		!deps.config.agentEnabled ||
		!deps.config.fraudReviewEnabled ||
		!deps.config.enabled ||
		!deps.runner
	) {
		return null;
	}
	return createIntegrityRun(deps, {
		applicationId: input.applicationId,
		feature: "document_triage",
		inputHash: triageInputHash(input.source, deps.config, input.reviewId),
		documentSha256: input.source.documents.map((doc) => doc.sha256).sort(),
		requestedBy: input.requestedBy,
		fraudReviewId: input.reviewId,
		reviewVersion: input.reviewVersion,
	});
}

interface ClaimedRow {
	id: string;
	application_id: string;
	feature: "document_analysis" | "document_triage";
	input_hash: string;
	attempts: number;
	max_attempts: number;
	model: string;
	prompt_version: string;
	agent_version: string;
	requested_by: string | null;
	fraud_review_id: string | null;
	review_version: number | null;
	lease_token: string;
	created_at: string | Date;
}

function mapClaimed(row: Record<string, unknown>): ClaimedRow {
	return {
		id: String(row.id),
		application_id: String(row.application_id),
		feature: row.feature as ClaimedRow["feature"],
		input_hash: String(row.input_hash),
		attempts: Number(row.attempts),
		max_attempts: Number(row.max_attempts),
		model: String(row.model),
		prompt_version: String(row.prompt_version),
		agent_version: String(row.agent_version),
		requested_by: typeof row.requested_by === "string" ? row.requested_by : null,
		fraud_review_id: typeof row.fraud_review_id === "string" ? row.fraud_review_id : null,
		review_version: row.review_version === null ? null : Number(row.review_version),
		lease_token: String(row.lease_token),
		created_at: row.created_at as string | Date,
	};
}

export async function claimIntegrityRun(deps: IntegrityRunDeps): Promise<ClaimedRow | null> {
	const { db, config } = deps;
	await db.execute(sql`
		UPDATE document_integrity_runs
		SET status = 'failed', error_code = 'LEASE_EXPIRED', finished_at = now()
		WHERE status = 'running'
			AND lease_expires_at < now()
			AND attempts >= max_attempts
	`);
	const leaseSeconds = Math.max(30, Math.ceil((config.timeoutMs * 1.5) / 1000));
	const result = await db.execute(sql`
		UPDATE document_integrity_runs
		SET status = 'running',
			attempts = attempts + 1,
			lease_token = ${randomUUID()}::uuid,
			lease_expires_at = now() + (${leaseSeconds} * interval '1 second'),
			started_at = COALESCE(started_at, now())
		WHERE id = (
			SELECT id FROM document_integrity_runs
			WHERE (
				status = 'queued'
				OR (status = 'running' AND lease_expires_at < now())
				OR (status = 'running' AND lease_expires_at IS NULL)
			)
			AND attempts < max_attempts
			ORDER BY created_at
			LIMIT 1
			FOR UPDATE SKIP LOCKED
		)
		RETURNING *
	`);
	const rows = result as unknown as Array<Record<string, unknown>>;
	return rows[0] ? mapClaimed(rows[0]) : null;
}

export async function drainIntegrityRuns(deps: IntegrityRunDeps): Promise<void> {
	const claimed = await claimIntegrityRun(deps);
	if (!claimed) return;
	if (
		(claimed.feature === "document_analysis" && !deps.config.enabled) ||
		(claimed.feature === "document_triage" &&
			(!deps.config.enabled || !deps.config.fraudReviewEnabled || !deps.config.triageEnabled))
	) {
		await deps.db
			.update(documentIntegrityRuns)
			.set({ status: "cancelled", errorCode: "FEATURE_DISABLED", finishedAt: new Date() })
			.where(
				and(
					eq(documentIntegrityRuns.id, claimed.id),
					eq(documentIntegrityRuns.status, "running"),
					eq(documentIntegrityRuns.leaseToken, claimed.lease_token),
				),
			);
		return;
	}
	const started = Date.now();
	let outcome: "succeeded" | "failed" | "cancelled" = "failed";
	let errorCode: string | null = null;
	await deps.db.transaction(async (tx) => {
		await writeAudit(tx, {
			applicationId: claimed.application_id,
			actor: claimed.requested_by ?? "system:integrity",
			action:
				claimed.feature === "document_analysis"
					? "integrity.analysis_started"
					: "integrity.triage_started",
			entity: "document_integrity_run",
			payload: {
				feature: "document_integrity",
				runId: claimed.id,
				reviewId: claimed.fraud_review_id,
				attempts: claimed.attempts,
				model: deps.config.model,
				promptVersion:
					claimed.feature === "document_analysis"
						? deps.config.promptVersion
						: deps.config.triagePromptVersion,
				agentVersion: deps.config.agentVersion,
			},
		});
	});
	try {
		if (claimed.feature === "document_analysis") {
			if (!deps.runner) throw new IntegrityAgentError("AGENT_UNAVAILABLE");
			const source = await loadIntegritySource(deps.db, claimed.application_id, {
				includeCustomerEvidence: false,
			});
			const result = await runIntegrityAnalysis({
				source,
				runner: deps.runner,
				config: deps.config,
				evidenceHash: claimed.input_hash,
			});
			const currentSource = await loadIntegritySource(deps.db, claimed.application_id, {
				includeCustomerEvidence: false,
			});
			if (analysisInputHash(currentSource, deps.config) !== claimed.input_hash) {
				await deps.db
					.update(documentIntegrityRuns)
					.set({
						status: "cancelled",
						errorCode: "EVIDENCE_CHANGED",
						finishedAt: new Date(),
					})
					.where(
						and(
							eq(documentIntegrityRuns.id, claimed.id),
							eq(documentIntegrityRuns.status, "running"),
							eq(documentIntegrityRuns.leaseToken, claimed.lease_token),
						),
					);
				outcome = "cancelled";
				return;
			}
			const persisted = await deps.db.transaction(async (tx) => {
				await lockApplication(tx, claimed.application_id, 5_000);
				const fresh = await loadIntegritySource(tx as unknown as Db, claimed.application_id, {
					includeCustomerEvidence: false,
				});
				if (analysisInputHash(fresh, deps.config) !== claimed.input_hash) {
					return { changed: true as const };
				}
				const updated = await tx
					.update(documentIntegrityRuns)
					.set({
						status: "succeeded",
						steps: result.steps,
						toolCalls: result.toolCalls,
						sourceRefs: result.sourceRefs,
						repairAttempted: result.repairAttempted,
						repairSucceeded: result.repairSucceeded,
						usage: result.usage,
						errorCode: null,
						finishedAt: new Date(),
					})
					.where(
						and(
							eq(documentIntegrityRuns.id, claimed.id),
							eq(documentIntegrityRuns.status, "running"),
							eq(documentIntegrityRuns.leaseToken, claimed.lease_token),
						),
					)
					.returning({ id: documentIntegrityRuns.id });
				if (updated.length === 0) throw new Error("lease_lost");
				await insertAnalysisResults(tx, {
					applicationId: claimed.application_id,
					runId: claimed.id,
					candidates: result.candidates,
					consistency: result.consistency,
				});
				await writeAudit(tx, {
					applicationId: claimed.application_id,
					actor: claimed.requested_by ?? deps.config.systemUserId,
					action: "integrity.analysis_succeeded",
					entity: "document_integrity_run",
					payload: {
						feature: "document_integrity",
						runId: claimed.id,
						candidateCount: result.candidates.length,
						consistencyCount: result.consistency.length,
						droppedClaims: result.droppedClaims,
						model: deps.config.model,
						promptVersion: deps.config.promptVersion,
						agentVersion: deps.config.agentVersion,
						toolCallCount: result.toolCalls.length,
						repairAttempted: result.repairAttempted,
					},
				});
				return { changed: false as const };
			});
			if (persisted.changed) {
				await deps.db
					.update(documentIntegrityRuns)
					.set({
						status: "cancelled",
						errorCode: "EVIDENCE_CHANGED",
						finishedAt: new Date(),
					})
					.where(
						and(
							eq(documentIntegrityRuns.id, claimed.id),
							eq(documentIntegrityRuns.status, "running"),
							eq(documentIntegrityRuns.leaseToken, claimed.lease_token),
						),
					);
				outcome = "cancelled";
				return;
			}
			outcome = "succeeded";
		} else {
			if (!deps.runner) throw new IntegrityAgentError("AGENT_UNAVAILABLE");
			const result = await executeTriage(deps, {
				runId: claimed.id,
				applicationId: claimed.application_id,
				reviewId: claimed.fraud_review_id,
				reviewVersion: claimed.review_version,
				requestedBy: claimed.requested_by,
				leaseToken: claimed.lease_token,
			});
			outcome = result;
		}
	} catch (err) {
		errorCode =
			err instanceof IntegrityAgentError
				? err.code
				: err instanceof HttpError
					? err.code
					: "INTERNAL_ERROR";
		if (errorCode === "cancelled") outcome = "cancelled";
		const retry = claimed.attempts < claimed.max_attempts;
		const fenced = await deps.db
			.update(documentIntegrityRuns)
			.set({
				status: retry ? "queued" : "failed",
				errorCode,
				errorDetail: `${errorCode}: ${Date.now() - started}ms`.slice(0, 200),
				finishedAt: retry ? null : new Date(),
			})
			.where(
				and(
					eq(documentIntegrityRuns.id, claimed.id),
					eq(documentIntegrityRuns.status, "running"),
					eq(documentIntegrityRuns.leaseToken, claimed.lease_token),
				),
			)
			.returning({ id: documentIntegrityRuns.id });
		if (fenced.length === 0) {
			deps.logger.warn(
				{ runId: claimed.id, applicationId: claimed.application_id, errorCode },
				"stale integrity worker lost its lease",
			);
			return;
		}
		if (claimed.feature === "document_analysis") {
			await deps.db.transaction(async (tx) => {
				await writeAudit(tx, {
					applicationId: claimed.application_id,
					actor: "system:integrity",
					action: "integrity.analysis_failed",
					entity: "document_integrity_run",
					payload: {
						feature: "document_integrity",
						runId: claimed.id,
						errorCode,
						attempts: claimed.attempts,
						model: deps.config.model,
						promptVersion: deps.config.promptVersion,
						agentVersion: deps.config.agentVersion,
					},
				});
			});
		}
		if (claimed.fraud_review_id) {
			const reviewId = claimed.fraud_review_id;
			await deps.db.transaction(async (tx) => {
				await tx
					.update(fraudReviews)
					.set({
						agentRunId: claimed.id,
						model: deps.config.model,
						promptVersion: deps.config.triagePromptVersion,
						agentVersion: deps.config.agentVersion,
					})
					.where(
						and(
							eq(fraudReviews.id, reviewId),
							sql`${fraudReviews.status} IN ('open','needs_info')`,
						),
					);
				await writeAudit(tx, {
					applicationId: claimed.application_id,
					actor: "system:integrity-triage",
					action: "integrity.triage_failed",
					entity: "fraud_review",
					payload: {
						feature: "document_integrity",
						reviewId: claimed.fraud_review_id,
						runId: claimed.id,
						errorCode,
						attempts: claimed.attempts,
						model: deps.config.model,
						promptVersion: deps.config.triagePromptVersion,
						agentVersion: deps.config.agentVersion,
					},
				});
			});
		}
		deps.logger.warn(
			{ runId: claimed.id, applicationId: claimed.application_id, errorCode, outcome },
			"integrity run failed",
		);
	}
	deps.logger.info(
		{
			runId: claimed.id,
			applicationId: claimed.application_id,
			feature: claimed.feature,
			outcome,
			durationMs: Date.now() - started,
		},
		"integrity run finished",
	);
}

let draining = false;

export async function drainIntegrityRunsSafely(deps: IntegrityRunDeps): Promise<void> {
	if (draining) return;
	draining = true;
	try {
		await drainIntegrityRuns(deps);
	} catch (err) {
		deps.logger.warn(
			{ error: err instanceof Error ? err.message : "unknown" },
			"integrity drain failed",
		);
	} finally {
		draining = false;
	}
}

export function startIntegrityWorker(deps: IntegrityRunDeps, intervalMs = 10_000): () => void {
	void drainIntegrityRunsSafely(deps);
	const timer = setInterval(() => {
		void drainIntegrityRunsSafely(deps);
	}, intervalMs);
	timer.unref?.();
	return () => clearInterval(timer);
}
