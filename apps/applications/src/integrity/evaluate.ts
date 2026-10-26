// Deterministic flag evaluation + one async integrity run.
//
// An officer mutation or the manual evaluate route computes deterministic
// signals. At/above the threshold it creates/updates one case-level item and
// queues the single integrity agent run (candidates + optional brief). New
// evidence on an already-open item re-queues the same run, keeping the brief
// current. Applicant evidence changes only refresh an existing item.

import { and, desc, eq, inArray } from "drizzle-orm";
import { documentIntegrityRuns, fraudReviews } from "@credit/db/applications";
import { hashCanonical } from "@credit/core";
import { writeAudit } from "@credit/service-kit";
import { createFraudReview, findActiveFraudReview } from "./fraud.js";
import {
	analysisInputHash,
	createIntegrityRun,
	drainIntegrityRunsSafely,
	type IntegrityRunDeps,
} from "./runs.js";
import { loadIntegritySource } from "./source.js";
import { maxSeverity, shouldFlag } from "./signals.js";
import type { DeterministicSignal, IntegritySeverity, IntegritySource } from "./types.js";

export interface EvaluateIntegrityInput {
	applicationId: string;
	actor: { id: string; role: "officer" | "service" | "applicant" };
	actorRole: string;
	now?: Date;
}

export interface EvaluateIntegrityResult {
	flagged: boolean;
	severity: IntegritySeverity | null;
	reviewId: string | null;
	signals: DeterministicSignal[];
}

function flaggableSeverity(signals: DeterministicSignal[]): IntegritySeverity | null {
	return maxSeverity(
		signals.filter(
			(signal) => signal.code !== "metadata_unknown" && signal.code !== "consistency_candidate",
		),
	);
}

function documentRefs(signals: DeterministicSignal[]): string[] {
	return [
		...new Set(
			signals.map((signal) => signal.documentFileId).filter((id): id is string => id !== null),
		),
	].slice(0, 100);
}

function sourceHash(source: IntegritySource, signals: DeterministicSignal[]): string {
	return hashCanonical({
		documents: source.documents.map((doc) => [doc.documentFileId, doc.sha256]).sort(),
		signals: signals.map((signal) => signal.code).sort(),
	});
}

async function latestReviewRun(
	deps: IntegrityRunDeps,
	reviewId: string,
): Promise<typeof documentIntegrityRuns.$inferSelect | null> {
	const [row] = await deps.db
		.select()
		.from(documentIntegrityRuns)
		.where(
			and(
				eq(documentIntegrityRuns.fraudReviewId, reviewId),
				eq(documentIntegrityRuns.feature, "document_analysis"),
			),
		)
		.orderBy(desc(documentIntegrityRuns.createdAt))
		.limit(1);
	return row ?? null;
}

async function markBriefStale(
	deps: IntegrityRunDeps,
	reviewId: string,
	applicationId: string,
	now: Date,
): Promise<void> {
	await deps.db.transaction(async (tx) => {
		await tx
			.update(fraudReviews)
			.set({ briefStaleAt: now, updatedAt: now })
			.where(
				and(eq(fraudReviews.id, reviewId), inArray(fraudReviews.status, ["open", "needs_info"])),
			);
		await writeAudit(tx, {
			applicationId,
			actor: "system:integrity-evaluate",
			action: "integrity.brief_stale",
			entity: "fraud_review",
			payload: { feature: "document_integrity", reviewId },
		});
	});
}

/** Queue (or replay) the single integrity run for an active review. */
async function synchronizeRun(
	deps: IntegrityRunDeps,
	input: {
		source: IntegritySource;
		review: typeof fraudReviews.$inferSelect;
		requestedBy: string;
		now: Date;
	},
): Promise<void> {
	if (!deps.config.triageEnabled) return;
	const currentHash = analysisInputHash(input.source, deps.config, {
		generateBrief: true,
		reviewId: input.review.id,
	});
	const latest = await latestReviewRun(deps, input.review.id);
	if (
		latest &&
		latest.inputHash === currentHash &&
		["queued", "running", "succeeded"].includes(latest.status) &&
		input.review.briefArtifactId !== null &&
		input.review.briefStaleAt === null
	) {
		return;
	}
	if (input.review.briefArtifactId) {
		await markBriefStale(deps, input.review.id, input.review.applicationId, input.now);
	}
	const queued = await createIntegrityRun(deps, {
		applicationId: input.review.applicationId,
		inputHash: currentHash,
		documentSha256: input.source.documents.map((doc) => doc.sha256).sort(),
		requestedBy: input.requestedBy,
		generateBrief: true,
		fraudReviewId: input.review.id,
		reviewVersion: input.review.version,
		now: input.now,
	});
	await deps.db.transaction(async (tx) => {
		await tx
			.update(fraudReviews)
			.set({ agentRunId: queued.run.id })
			.where(eq(fraudReviews.id, input.review.id));
		await writeAudit(tx, {
			applicationId: input.review.applicationId,
			actor: "system:integrity-evaluate",
			action: "integrity.run_queued",
			entity: "document_integrity_run",
			payload: {
				feature: "document_integrity",
				reviewId: input.review.id,
				runId: queued.run.id,
				replayed: queued.replayed,
				model: deps.config.model,
				promptVersion: deps.config.promptVersion,
				agentVersion: deps.config.agentVersion,
			},
		});
	});
	void drainIntegrityRunsSafely(deps);
}

/** Manual/created-item path: queue the combined run for an active item. */
export async function queueIntegrityRunForReview(
	deps: IntegrityRunDeps,
	input: {
		applicationId: string;
		review: typeof fraudReviews.$inferSelect;
		requestedBy: string;
		now?: Date;
	},
): Promise<void> {
	const now = input.now ?? deps.now?.() ?? new Date();
	const source = await loadIntegritySource(deps.db, input.applicationId, {
		includeCustomerEvidence: true,
		now,
	});
	await synchronizeRun(deps, {
		source,
		review: input.review,
		requestedBy: input.requestedBy,
		now,
	});
}

/** Applicant/service evidence change on an already-open review: refresh the
 * combined run without creating a new flag. */
export async function requeueActiveReviewForEvidenceChange(
	deps: IntegrityRunDeps,
	input: { applicationId: string; requestedBy: string; now?: Date },
): Promise<void> {
	if (!deps.config.enabled || !deps.config.fraudReviewEnabled) return;
	const review = await findActiveFraudReview(deps.db, input.applicationId);
	if (!review) return;
	const now = input.now ?? deps.now?.() ?? new Date();
	const source = await loadIntegritySource(deps.db, input.applicationId, {
		includeCustomerEvidence: true,
		now,
	});
	await synchronizeRun(deps, {
		source,
		review,
		requestedBy: input.requestedBy,
		now,
	});
}

/** Evaluate signals, create/refresh one active item, and queue the one
 * combined run. Caller has already checked assigned case access. */
export async function evaluateIntegrity(
	deps: IntegrityRunDeps,
	input: EvaluateIntegrityInput,
): Promise<EvaluateIntegrityResult> {
	if (!deps.config.enabled || !deps.config.fraudReviewEnabled) {
		return { flagged: false, severity: null, reviewId: null, signals: [] };
	}
	if (input.actor.role === "applicant") {
		return { flagged: false, severity: null, reviewId: null, signals: [] };
	}
	const now = input.now ?? deps.now?.() ?? new Date();
	const source = await loadIntegritySource(deps.db, input.applicationId, {
		includeCustomerEvidence: true,
		now,
	});
	const signals = source.signals;
	const existing = await findActiveFraudReview(deps.db, input.applicationId);
	if (!shouldFlag(signals, deps.config.flagSeverity)) {
		if (existing) {
			await synchronizeRun(deps, {
				source,
				review: existing,
				requestedBy: input.actor.id,
				now,
			});
		}
		return {
			flagged: existing !== null,
			severity: existing?.severity ?? null,
			reviewId: existing?.id ?? null,
			signals,
		};
	}
	const severity = flaggableSeverity(signals) ?? deps.config.flagSeverity;
	const reasonCode = signals.some((signal) => signal.code === "duplicate_hash_cross_application")
		? "duplicate_document"
		: "document_integrity";
	const { review } = await createFraudReview(deps.db, {
		applicationId: input.applicationId,
		reasonCode,
		note: null,
		severity,
		signalCodes: signals.map((signal) => signal.code),
		documentRefs: documentRefs(signals),
		sourceHash: sourceHash(source, signals),
		createdBy: input.actor.role === "service" ? deps.config.systemUserId : input.actor.id,
		actorRole: input.actorRole,
		retentionDays: deps.config.retentionDays,
		customerProfileId: source.customerProfileId,
		now,
	});
	await synchronizeRun(deps, {
		source,
		review,
		requestedBy: input.actor.id,
		now,
	});
	return { flagged: true, severity, reviewId: review.id, signals };
}

/** Manual retry path. Same semantics as the post-mutation hook. */
export async function reevaluateIntegrity(
	deps: IntegrityRunDeps,
	input: EvaluateIntegrityInput,
): Promise<EvaluateIntegrityResult> {
	return evaluateIntegrity(deps, input);
}
