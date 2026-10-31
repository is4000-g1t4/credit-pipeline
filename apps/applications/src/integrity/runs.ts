// Integrity run rows + per-run execution.
//
// One run per case/evidence hash. The same agent call produces extraction and
// consistency candidates; for a flagged case it also produces the advisory
// brief. Dispatch is Temporal (see ./activities.ts): the API inserts a queued
// row and starts a workflow; the agent worker claims THAT row by id (a short
// UPDATE that mints a lease token), runs the model outside any transaction,
// and finalizes under the lease token. Attempts increment at every claim, so a
// crash cannot buy unbounded retries, and a re-lease on retry rotates the
// token so a zombie attempt's writes are fenced out. Transient failures before
// the last attempt are retried by the workflow; the rest finalize at once.

import { randomUUID } from "node:crypto";
import { documentIntegrityRuns, fraudReviews, type Db } from "@credit/db/applications";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { hashCanonical } from "@credit/core";
import type { AgentRunStarter } from "@credit/agent-kit/temporal/client";
import { HttpError, writeAudit, type Logger } from "@credit/service-kit";
import { runIntegrityAnalysis } from "../agents/integrity/index.js";
import { lockApplication } from "../documents/access.js";
import { insertAnalysisResults, insertBriefArtifact } from "./store.js";
import { loadIntegritySource } from "./source.js";
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
	/** API side only: starts the run's Temporal workflow. Null/absent = no dispatch. */
	starter?: AgentRunStarter | null;
}

/** Dispatch key shared by the API starter and the agent worker activities. */
export const INTEGRITY_RUN_KIND = "integrity.run";

/** One attempt's lease: the model deadline plus headroom (min 30s). */
export function integrityLeaseSeconds(config: Pick<IntegrityConfig, "timeoutMs">): number {
	return Math.max(30, Math.ceil((config.timeoutMs * 1.5) / 1000));
}

/**
 * Failure codes a later attempt can plausibly clear (model, transport or
 * output flakiness, unexpected errors). Everything else (no runner, budget,
 * consent, flags, evidence or review changes) is final on the first attempt.
 */
export const RETRYABLE_INTEGRITY_ERROR_CODES: ReadonlySet<string> = new Set([
	"MODEL_ERROR",
	"TIMEOUT",
	"INVALID_OUTPUT",
	"NO_TOOL_USE",
	"STEP_LIMIT",
	"TOOL_CALL_LIMIT",
	"INTERNAL_ERROR",
]);

/**
 * Thrown out of the activity when a retryable failure happened before the
 * final attempt: the row stays `running` with the error recorded and the
 * workflow retries with backoff. A plain Error so this module stays
 * importable by the Bun API (no @temporalio/activity here).
 */
export class IntegrityAttemptFailed extends Error {
	constructor(readonly errorCode: string) {
		super(`integrity attempt failed: ${errorCode}`);
		this.name = "IntegrityAttemptFailed";
	}
}

type RunRow = typeof documentIntegrityRuns.$inferSelect;

function nowOf(deps: IntegrityRunDeps): Date {
	return deps.now?.() ?? new Date();
}

export interface IntegrityHashOptions {
	generateBrief?: boolean;
	reviewId?: string;
}

export function analysisInputHash(
	source: IntegritySource,
	config: IntegrityConfig,
	options: IntegrityHashOptions = {},
): string {
	const generateBrief = options.generateBrief === true;
	return hashCanonical({
		feature: "integrity",
		applicationId: source.applicationId,
		generateBrief,
		reviewId: generateBrief ? (options.reviewId ?? null) : null,
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
		promptVersion: config.promptVersion,
		agentVersion: config.agentVersion,
	});
}

async function recentRunCount(
	db: Db,
	applicationId: string,
	inputHash: string,
	since: Date,
): Promise<number> {
	const rows = await db
		.select({ id: documentIntegrityRuns.id })
		.from(documentIntegrityRuns)
		.where(
			and(
				eq(documentIntegrityRuns.applicationId, applicationId),
				eq(documentIntegrityRuns.feature, "document_analysis"),
				eq(documentIntegrityRuns.inputHash, inputHash),
				gte(documentIntegrityRuns.createdAt, since),
			),
		);
	return rows.length;
}

async function findActiveRun(
	db: Db,
	applicationId: string,
	inputHash: string,
): Promise<RunRow | null> {
	const rows = await db
		.select()
		.from(documentIntegrityRuns)
		.where(
			and(
				eq(documentIntegrityRuns.applicationId, applicationId),
				eq(documentIntegrityRuns.feature, "document_analysis"),
				eq(documentIntegrityRuns.inputHash, inputHash),
				sql`${documentIntegrityRuns.status} IN ('queued','running','succeeded')`,
			),
		)
		.orderBy(desc(documentIntegrityRuns.createdAt))
		.limit(1);
	return rows[0] ?? null;
}

export interface CreateRunInput {
	applicationId: string;
	inputHash: string;
	documentSha256: string[];
	requestedBy: string;
	generateBrief?: boolean;
	fraudReviewId?: string | null;
	reviewVersion?: number | null;
	now?: Date;
}

export async function createIntegrityRun(
	deps: IntegrityRunDeps,
	input: CreateRunInput,
): Promise<{ run: RunRow; replayed: boolean }> {
	const { db, config } = deps;
	const existing = await findActiveRun(db, input.applicationId, input.inputHash);
	if (existing) return { run: existing, replayed: true };
	const now = input.now ?? nowOf(deps);
	const since = new Date(now.getTime() - 24 * 3_600_000);
	const attempts = await recentRunCount(db, input.applicationId, input.inputHash, since);
	if (attempts >= config.maxRunsPerHash) {
		throw new HttpError(429, "RETRY_LIMIT", "too many runs for this evidence set");
	}
	const generateBrief = input.generateBrief === true;
	const [inserted] = await db
		.insert(documentIntegrityRuns)
		.values({
			applicationId: input.applicationId,
			feature: "document_analysis",
			status: "queued",
			inputHash: input.inputHash,
			documentSha256: input.documentSha256,
			fingerprintVersion: "document-fingerprint-v1",
			model: config.model,
			promptVersion: config.promptVersion,
			agentVersion: config.agentVersion,
			requestedBy: input.requestedBy,
			fraudReviewId: generateBrief ? (input.fraudReviewId ?? null) : null,
			reviewVersion: generateBrief ? (input.reviewVersion ?? null) : null,
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
	const winner = await findActiveRun(db, input.applicationId, input.inputHash);
	if (!winner) throw new HttpError(500, "INTERNAL_ERROR", "internal error");
	return { run: winner, replayed: true };
}

export interface ClaimedRow {
	id: string;
	application_id: string;
	input_hash: string;
	attempts: number;
	max_attempts: number;
	requested_by: string | null;
	fraud_review_id: string | null;
	review_version: number | null;
	lease_token: string;
}

function mapClaimed(row: Record<string, unknown>): ClaimedRow {
	return {
		id: String(row.id),
		application_id: String(row.application_id),
		input_hash: String(row.input_hash),
		attempts: Number(row.attempts),
		max_attempts: Number(row.max_attempts),
		requested_by: typeof row.requested_by === "string" ? row.requested_by : null,
		fraud_review_id: typeof row.fraud_review_id === "string" ? row.fraud_review_id : null,
		review_version: row.review_version === null ? null : Number(row.review_version),
		lease_token: String(row.lease_token),
	};
}

export type ClaimResult =
	| { kind: "claimed"; row: ClaimedRow }
	| { kind: "missing" }
	/** Terminal, or running under another live attempt: nothing to do. */
	| { kind: "skip"; status: string }
	/** Active but out of attempts: finalized failed. */
	| { kind: "exhausted" };

/**
 * Claims one specific run for a Temporal activity attempt.
 *
 * Attempt 1 claims a `queued` row. Attempt > 1 force re-leases a `running`
 * row (Temporal says the previous attempt is dead) or a still-`queued` one
 * (the previous attempt died before claiming) with a fresh lease token, so a
 * zombie's lease-token-guarded writes fail. Every claim increments attempts
 * and respects max_attempts.
 */
export async function claimIntegrityRunById(
	deps: IntegrityRunDeps,
	runId: string,
	attempt: number,
): Promise<ClaimResult> {
	const { db, config } = deps;
	const leaseSeconds = integrityLeaseSeconds(config);
	const statuses = attempt > 1 ? sql`('queued','running')` : sql`('queued')`;
	const result = await db.execute(sql`
		UPDATE document_integrity_runs
		SET status = 'running',
			attempts = attempts + 1,
			lease_token = ${randomUUID()}::uuid,
			lease_expires_at = now() + (${leaseSeconds} * interval '1 second'),
			started_at = COALESCE(started_at, now())
		WHERE id = ${runId}::uuid
			AND feature = 'document_analysis'
			AND status IN ${statuses}
			AND attempts < max_attempts
		RETURNING *
	`);
	const rows = result as unknown as Array<Record<string, unknown>>;
	if (rows[0]) return { kind: "claimed", row: mapClaimed(rows[0]) };
	const [row] = await db
		.select({
			status: documentIntegrityRuns.status,
			attempts: documentIntegrityRuns.attempts,
			maxAttempts: documentIntegrityRuns.maxAttempts,
		})
		.from(documentIntegrityRuns)
		.where(
			and(
				eq(documentIntegrityRuns.id, runId),
				eq(documentIntegrityRuns.feature, "document_analysis"),
			),
		);
	if (!row) return { kind: "missing" };
	const active = row.status === "queued" || row.status === "running";
	if (active && row.attempts >= row.maxAttempts) {
		await failIntegrityRun(deps, runId, "LEASE_EXPIRED", "attempts exhausted");
		return { kind: "exhausted" };
	}
	return { kind: "skip", status: row.status };
}

/**
 * Marks a still-active (queued/running) run failed and clears its lease.
 * Idempotent; never touches a terminal row. Returns whether it changed one.
 */
export async function failIntegrityRun(
	deps: Pick<IntegrityRunDeps, "db" | "logger">,
	runId: string,
	errorCode: string,
	detail: string,
): Promise<boolean> {
	const [failed] = await deps.db
		.update(documentIntegrityRuns)
		.set({
			status: "failed",
			errorCode,
			errorDetail: `${errorCode}: ${detail}`.slice(0, 200),
			finishedAt: new Date(),
			leaseToken: null,
			leaseExpiresAt: null,
		})
		.where(
			and(
				eq(documentIntegrityRuns.id, runId),
				eq(documentIntegrityRuns.feature, "document_analysis"),
				sql`${documentIntegrityRuns.status} IN ('queued','running')`,
			),
		)
		.returning({
			id: documentIntegrityRuns.id,
			applicationId: documentIntegrityRuns.applicationId,
		});
	if (!failed) return false;
	await deps.db
		.transaction(async (tx) => {
			await writeAudit(tx, {
				applicationId: failed.applicationId,
				actor: "system:integrity",
				action: "integrity.analysis_failed",
				entity: "document_integrity_run",
				payload: { feature: "document_integrity", runId, errorCode },
			});
		})
		.catch(() => {});
	deps.logger.warn(
		{ runId, applicationId: failed.applicationId, errorCode },
		"integrity run failed by cleanup",
	);
	return true;
}

/**
 * Starts the run's Temporal workflow after its row committed. Never throws:
 * on failure the row stays queued and the agent-worker sweep re-issues the
 * (idempotent) start. Metadata-only logging.
 */
export async function startIntegrityRun(
	deps: IntegrityRunDeps,
	run: { id: string },
): Promise<void> {
	if (!deps.starter) return;
	try {
		await deps.starter.start({
			kind: INTEGRITY_RUN_KIND,
			runId: run.id,
			token: run.id,
			timeoutMs: integrityLeaseSeconds(deps.config) * 1000,
		});
	} catch (err) {
		deps.logger.warn(
			{ runId: run.id, error: err instanceof Error ? err.name : "unknown" },
			"integrity run start failed; left queued for sweep",
		);
	}
}

class ReviewClosed extends Error {
	constructor() {
		super("review closed");
		this.name = "ReviewClosed";
	}
}

async function persistBrief(
	tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
	input: {
		applicationId: string;
		runId: string;
		reviewId: string;
		reviewVersion: number | null;
		leaseToken: string;
		brief: NonNullable<Awaited<ReturnType<typeof runIntegrityAnalysis>>["brief"]>;
		agentTrace: Awaited<ReturnType<typeof runIntegrityAnalysis>>["trace"];
		evidenceHash: string;
		now: Date;
		config: IntegrityConfig;
		requestedBy: string | null;
	},
): Promise<void> {
	const [review] = await tx
		.select()
		.from(fraudReviews)
		.where(eq(fraudReviews.id, input.reviewId))
		.limit(1)
		.for("update");
	if (
		!review ||
		!["open", "needs_info"].includes(review.status) ||
		(input.reviewVersion !== null && review.version !== input.reviewVersion)
	) {
		throw new ReviewClosed();
	}
	await tx
		.update(documentIntegrityRuns)
		.set({
			status: "succeeded",
			finishedAt: input.now,
		})
		.where(
			and(
				eq(documentIntegrityRuns.id, input.runId),
				eq(documentIntegrityRuns.status, "running"),
				eq(documentIntegrityRuns.leaseToken, input.leaseToken),
			),
		);
	const artifactId = await insertBriefArtifact(tx, {
		applicationId: input.applicationId,
		content: input.brief.content,
		citations: input.brief.citations,
		agentTrace: input.agentTrace,
		evidenceHash: input.evidenceHash,
		model: input.config.model,
		promptVersion: input.config.promptVersion,
		retentionDays: input.config.retentionDays,
		createdBy: review.createdBy || input.config.systemUserId,
		auditActor: "system:integrity-agent",
		now: input.now,
	}).catch((err) => {
		throw err;
	});
	await tx
		.update(fraudReviews)
		.set({
			briefArtifactId: artifactId,
			agentRunId: input.runId,
			model: input.config.model,
			promptVersion: input.config.promptVersion,
			agentVersion: input.config.agentVersion,
			briefStaleAt: null,
		})
		.where(eq(fraudReviews.id, input.reviewId));
	await tx
		.update(documentIntegrityRuns)
		.set({ artifactId })
		.where(eq(documentIntegrityRuns.id, input.runId));
	await writeAudit(tx, {
		applicationId: input.applicationId,
		actor: "system:integrity-agent",
		action: "integrity.triage_succeeded",
		entity: "fraud_review",
		payload: {
			feature: "document_integrity",
			reviewId: input.reviewId,
			runId: input.runId,
			artifactId,
			model: input.config.model,
			promptVersion: input.config.promptVersion,
			agentVersion: input.config.agentVersion,
		},
	});
}

export interface ExecuteIntegrityRunOptions {
	/** The attempt's cancel signal (worker shutdown, heartbeat-timeout cancel). */
	signal?: AbortSignal;
	/** The workflow runs no further attempt: every failure is final. */
	finalAttempt?: boolean;
}

/**
 * Runs one claimed row. Success and final failures reach a terminal state
 * here. A retryable failure before the last attempt records the error on the
 * still-running row and throws `IntegrityAttemptFailed` so the workflow
 * retries; a cancelled attempt rethrows without touching the row.
 */
export async function executeIntegrityRun(
	deps: IntegrityRunDeps,
	claimed: ClaimedRow,
	opts: ExecuteIntegrityRunOptions = {},
): Promise<void> {
	if (!deps.config.enabled) {
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
	const generateBrief = claimed.fraud_review_id !== null;
	if (generateBrief && (!deps.config.fraudReviewEnabled || !deps.config.triageEnabled)) {
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
			action: "integrity.analysis_started",
			entity: "document_integrity_run",
			payload: {
				feature: "document_integrity",
				runId: claimed.id,
				reviewId: claimed.fraud_review_id,
				attempts: claimed.attempts,
				model: deps.config.model,
				promptVersion: deps.config.promptVersion,
				agentVersion: deps.config.agentVersion,
			},
		});
	});
	try {
		if (!deps.runner) throw new IntegrityAgentError("AGENT_UNAVAILABLE");
		const source = await loadIntegritySource(deps.db, claimed.application_id, {
			includeCustomerEvidence: generateBrief,
		});
		const result = await runIntegrityAnalysis({
			source,
			runner: deps.runner,
			config: deps.config,
			evidenceHash: claimed.input_hash,
			generateBrief,
			conversationId: claimed.id,
			signal: opts.signal,
		});
		const persisted = await deps.db.transaction(async (tx) => {
			await lockApplication(tx, claimed.application_id, 5_000);
			const fresh = await loadIntegritySource(tx as unknown as Db, claimed.application_id, {
				includeCustomerEvidence: generateBrief,
			});
			const currentHash = analysisInputHash(fresh, deps.config, {
				generateBrief,
				reviewId: claimed.fraud_review_id ?? undefined,
			});
			if (currentHash !== claimed.input_hash) return { changed: true as const, briefLost: false };
			const fenced = await tx
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
					errorDetail: null,
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
			if (fenced.length === 0) throw new Error("lease_lost");
			await insertAnalysisResults(tx, {
				applicationId: claimed.application_id,
				runId: claimed.id,
				candidates: result.candidates,
				consistency: result.consistency,
			});
			if (result.brief && claimed.fraud_review_id) {
				await persistBrief(tx, {
					applicationId: claimed.application_id,
					runId: claimed.id,
					reviewId: claimed.fraud_review_id,
					reviewVersion: claimed.review_version,
					leaseToken: claimed.lease_token,
					brief: result.brief,
					agentTrace: result.trace,
					evidenceHash: result.evidenceHash,
					now: new Date(),
					config: deps.config,
					requestedBy: claimed.requested_by,
				});
			}
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
					brief: result.brief !== null,
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
				.set({ status: "cancelled", errorCode: "EVIDENCE_CHANGED", finishedAt: new Date() })
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
	} catch (err) {
		// A cancelled attempt is not a business failure (the runner reports the
		// abort as TIMEOUT): leave the row to the next attempt or to cleanup.
		if (opts.signal?.aborted) throw err;
		if (err instanceof ReviewClosed) {
			await deps.db
				.update(documentIntegrityRuns)
				.set({ status: "cancelled", errorCode: "REVIEW_CLOSED", finishedAt: new Date() })
				.where(
					and(
						eq(documentIntegrityRuns.id, claimed.id),
						eq(documentIntegrityRuns.status, "running"),
						eq(documentIntegrityRuns.leaseToken, claimed.lease_token),
					),
				);
			return;
		}
		errorCode =
			err instanceof IntegrityAgentError
				? err.code
				: err instanceof HttpError
					? err.code
					: "INTERNAL_ERROR";
		const errorDetail = `${errorCode}: ${Date.now() - started}ms`.slice(0, 200);
		const retryable =
			!(err instanceof HttpError) &&
			RETRYABLE_INTEGRITY_ERROR_CODES.has(errorCode) &&
			opts.finalAttempt !== true &&
			claimed.attempts < claimed.max_attempts;
		if (retryable) {
			// Keep the row running under this lease; the next attempt re-leases it.
			const kept = await deps.db
				.update(documentIntegrityRuns)
				.set({ errorCode, errorDetail })
				.where(
					and(
						eq(documentIntegrityRuns.id, claimed.id),
						eq(documentIntegrityRuns.status, "running"),
						eq(documentIntegrityRuns.leaseToken, claimed.lease_token),
					),
				)
				.returning({ id: documentIntegrityRuns.id });
			if (kept.length === 0) return;
			deps.logger.warn(
				{
					runId: claimed.id,
					applicationId: claimed.application_id,
					errorCode,
					attempts: claimed.attempts,
				},
				"integrity attempt failed; retrying",
			);
			throw new IntegrityAttemptFailed(errorCode);
		}
		// Final failure: finalize, audit, and record the run on the review.
		const fenced = await deps.db
			.update(documentIntegrityRuns)
			.set({
				status: "failed",
				errorCode,
				errorDetail,
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
		if (fenced.length === 0) return;
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
			if (claimed.fraud_review_id) {
				await tx
					.update(fraudReviews)
					.set({
						agentRunId: claimed.id,
						model: deps.config.model,
						promptVersion: deps.config.promptVersion,
						agentVersion: deps.config.agentVersion,
					})
					.where(
						and(
							eq(fraudReviews.id, claimed.fraud_review_id),
							sql`${fraudReviews.status} IN ('open','needs_info')`,
						),
					);
			}
		});
		deps.logger.warn(
			{ runId: claimed.id, applicationId: claimed.application_id, errorCode, outcome },
			"integrity run failed",
		);
	}
	deps.logger.info(
		{
			runId: claimed.id,
			applicationId: claimed.application_id,
			outcome,
			durationMs: Date.now() - started,
		},
		"integrity run finished",
	);
}
