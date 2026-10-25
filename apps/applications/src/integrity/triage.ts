// US-INT-3 triage finalization.
//
// Runs only for an active deterministic flag. The brief artifact, run row, and
// fraud-review link are written in one transaction, fenced by the run lease and
// the review version. A reviewer resolving mid-run cancels the run; a stale
// worker cannot write after a re-claim.

import { and, eq, inArray } from "drizzle-orm";
import { documentIntegrityRuns, fraudReviews, type Db } from "@credit/db/applications";
import { writeAudit, type Logger } from "@credit/service-kit";
import { lockApplication } from "../documents/access.js";
import { runIntegrityTriage } from "./agent.js";
import { insertBriefArtifact } from "./store.js";
import { loadIntegritySource } from "./source.js";
import { triageInputHash } from "./runs.js";
import type { IntegrityAgentRunner, IntegrityConfig } from "./types.js";

export interface TriageDeps {
	db: Db;
	config: IntegrityConfig;
	runner: IntegrityAgentRunner | null;
	logger: Logger;
	now?: () => Date;
}

export interface ExecuteTriageInput {
	runId: string;
	applicationId: string;
	reviewId: string | null;
	reviewVersion: number | null;
	requestedBy: string | null;
	leaseToken: string;
}

class TriageFenceLost extends Error {
	constructor() {
		super("triage lease lost");
		this.name = "TriageFenceLost";
	}
}

export async function executeTriage(
	deps: TriageDeps,
	input: ExecuteTriageInput,
): Promise<"succeeded" | "cancelled"> {
	if (!input.reviewId) throw new Error("triage run has no review");
	const [review] = await deps.db
		.select()
		.from(fraudReviews)
		.where(eq(fraudReviews.id, input.reviewId))
		.limit(1);
	if (
		!review ||
		review.applicationId !== input.applicationId ||
		!["open", "needs_info"].includes(review.status) ||
		(input.reviewVersion !== null && review.version !== input.reviewVersion)
	) {
		await cancelRun(deps.db, input.runId, input.leaseToken, "REVIEW_CLOSED");
		return "cancelled";
	}
	if (!deps.runner) throw new Error("triage runner unavailable");

	const source = await loadIntegritySource(deps.db, input.applicationId, {
		includeCustomerEvidence: true,
		now: deps.now?.() ?? new Date(),
	});
	const evidenceHash = triageInputHash(source, deps.config, input.reviewId);
	const result = await runIntegrityTriage({
		source,
		runner: deps.runner,
		config: deps.config,
		evidenceHash,
	});
	const now = deps.now?.() ?? new Date();
	const createdBy = review.createdBy || deps.config.systemUserId;

	// Evidence may have changed during the model call (retry-OCR, new upload,
	// consent withdrawal, retention). Re-read and fail closed rather than
	// persisting quotes from a superseded snapshot.
	const currentSource = await loadIntegritySource(deps.db, input.applicationId, {
		includeCustomerEvidence: true,
		now,
	});
	const currentHash = triageInputHash(currentSource, deps.config, input.reviewId);
	if (currentHash !== evidenceHash) {
		await deps.db.transaction(async (tx) => {
			await tx
				.update(fraudReviews)
				.set({ briefStaleAt: now, updatedAt: now })
				.where(
					and(
						eq(fraudReviews.id, input.reviewId!),
						inArray(fraudReviews.status, ["open", "needs_info"]),
					),
				);
			await writeAudit(tx, {
				applicationId: input.applicationId,
				actor: "system:integrity-triage",
				action: "integrity.triage_stale_evidence",
				entity: "document_integrity_run",
				payload: { feature: "document_integrity", reviewId: input.reviewId, runId: input.runId },
			});
		});
		await cancelRun(deps.db, input.runId, input.leaseToken, "EVIDENCE_CHANGED");
		return "cancelled";
	}

	const persisted = await deps.db
		.transaction(async (tx) => {
			await lockApplication(tx, input.applicationId, 5_000);
			const fresh = await loadIntegritySource(tx as unknown as Db, input.applicationId, {
				includeCustomerEvidence: true,
				now,
			});
			if (triageInputHash(fresh, deps.config, input.reviewId!) !== evidenceHash) {
				return { status: "cancelled" as const };
			}
			// Lock the review first; if it was resolved/assigned/re-versioned, do
			// not write anything.
			const [lockedReview] = await tx
				.select()
				.from(fraudReviews)
				.where(eq(fraudReviews.id, input.reviewId!))
				.limit(1)
				.for("update");
			if (
				!lockedReview ||
				!["open", "needs_info"].includes(lockedReview.status) ||
				(input.reviewVersion !== null && lockedReview.version !== input.reviewVersion)
			) {
				return { status: "cancelled" as const };
			}

			// Fence the run lease before any review mutation. A lost lease means
			// another worker owns the row and this attempt must write nothing.
			const fencedRun = await tx
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
					finishedAt: now,
				})
				.where(
					and(
						eq(documentIntegrityRuns.id, input.runId),
						eq(documentIntegrityRuns.status, "running"),
						eq(documentIntegrityRuns.leaseToken, input.leaseToken),
					),
				)
				.returning({ id: documentIntegrityRuns.id });
			if (fencedRun.length === 0) throw new TriageFenceLost();

			const artifactId = await insertBriefArtifact(tx, {
				applicationId: input.applicationId,
				content: result.content,
				citations: result.citations,
				agentTrace: result.trace,
				evidenceHash,
				model: deps.config.model,
				promptVersion: deps.config.triagePromptVersion,
				retentionDays: deps.config.retentionDays,
				createdBy,
				auditActor: "system:integrity-triage",
				now,
			});
			await tx
				.update(fraudReviews)
				.set({
					briefArtifactId: artifactId,
					agentRunId: input.runId,
					model: deps.config.model,
					promptVersion: deps.config.triagePromptVersion,
					agentVersion: deps.config.agentVersion,
					briefStaleAt: null,
				})
				.where(eq(fraudReviews.id, input.reviewId!));
			await tx
				.update(documentIntegrityRuns)
				.set({ artifactId })
				.where(eq(documentIntegrityRuns.id, input.runId));
			await writeAudit(tx, {
				applicationId: input.applicationId,
				actor: "system:integrity-triage",
				action: "integrity.triage_succeeded",
				entity: "fraud_review",
				payload: {
					feature: "document_integrity",
					reviewId: input.reviewId,
					runId: input.runId,
					artifactId,
					model: deps.config.model,
					promptVersion: deps.config.triagePromptVersion,
					agentVersion: deps.config.agentVersion,
					toolCallCount: result.toolCalls.length,
					citationCount: result.citations.length,
					repairAttempted: result.repairAttempted,
					durationMs: result.latencyMs,
				},
			});
			return { status: "succeeded" as const };
		})
		.catch((err: unknown) => {
			if (err instanceof TriageFenceLost) return { status: "cancelled" as const };
			throw err;
		});

	if (persisted.status === "cancelled") {
		await cancelRun(deps.db, input.runId, input.leaseToken, "REVIEW_CLOSED");
		return "cancelled";
	}
	return "succeeded";
}

async function cancelRun(db: Db, runId: string, leaseToken: string, code: string): Promise<void> {
	await db
		.update(documentIntegrityRuns)
		.set({ status: "cancelled", errorCode: code, finishedAt: new Date() })
		.where(
			and(
				eq(documentIntegrityRuns.id, runId),
				eq(documentIntegrityRuns.status, "running"),
				eq(documentIntegrityRuns.leaseToken, leaseToken),
			),
		);
}
