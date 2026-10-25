// Deterministic flag evaluation + triage enqueue.
//
// Runs only after an officer/service mutation. Applicant uploads never create
// items or spend triage budget. Both feature flags are required. Evaluation is
// best-effort at the route boundary: the deterministic computation is
// synchronous, and a failure is audited without failing the primary action.

import { and, desc, eq, inArray } from "drizzle-orm";
import { documentIntegrityRuns, fraudReviews } from "@credit/db/applications";
import { hashCanonical } from "@credit/core";
import { writeAudit } from "@credit/service-kit";
import { createFraudReview, findActiveFraudReview } from "./fraud.js";
import {
	drainIntegrityRunsSafely,
	enqueueTriageRun,
	triageInputHash,
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

async function latestTriageRun(
	deps: IntegrityRunDeps,
	reviewId: string,
): Promise<typeof documentIntegrityRuns.$inferSelect | null> {
	const [row] = await deps.db
		.select()
		.from(documentIntegrityRuns)
		.where(
			and(
				eq(documentIntegrityRuns.fraudReviewId, reviewId),
				eq(documentIntegrityRuns.feature, "document_triage"),
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

async function synchronizeTriage(
	deps: IntegrityRunDeps,
	input: {
		source: IntegritySource;
		review: typeof fraudReviews.$inferSelect;
		requestedBy: string;
		now: Date;
	},
): Promise<void> {
	const currentHash = triageInputHash(input.source, deps.config, input.review.id);
	const latest = await latestTriageRun(deps, input.review.id);
	if (
		input.review.briefStaleAt === null &&
		latest &&
		latest.inputHash === currentHash &&
		["queued", "running", "succeeded"].includes(latest.status)
	) {
		return;
	}
	if (input.review.briefArtifactId) {
		await markBriefStale(deps, input.review.id, input.review.applicationId, input.now);
	}
	const queued = await enqueueTriageRun(deps, {
		applicationId: input.review.applicationId,
		reviewId: input.review.id,
		reviewVersion: input.review.version,
		source: input.source,
		requestedBy: input.requestedBy,
	});
	if (queued) {
		await deps.db.transaction(async (tx) => {
			await writeAudit(tx, {
				applicationId: input.review.applicationId,
				actor: "system:integrity-evaluate",
				action: "integrity.triage_queued",
				entity: "document_integrity_run",
				payload: {
					feature: "document_integrity",
					reviewId: input.review.id,
					runId: queued.run.id,
					replayed: queued.replayed,
					model: deps.config.model,
					promptVersion: deps.config.triagePromptVersion,
					agentVersion: deps.config.agentVersion,
				},
			});
		});
		void drainIntegrityRunsSafely(deps);
	}
}

/** Manual/created-item path: load the triage snapshot and queue a brief. */
export async function queueTriageForReview(
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
	await synchronizeTriage(deps, {
		source,
		review: input.review,
		requestedBy: input.requestedBy,
		now,
	});
}

/** Applicant/service evidence change on an already-open review: mark the
 * brief stale and queue a fresh triage run without creating a new flag. */
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
	await synchronizeTriage(deps, {
		source,
		review,
		requestedBy: input.requestedBy,
		now,
	});
}

/** Evaluate signals, create/refresh one active item, and queue triage when the
 * evidence hash changed. Caller has already checked assigned case access. */
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
	if (!shouldFlag(signals, deps.config.flagSeverity)) {
		const existing = await findActiveFraudReview(deps.db, input.applicationId);
		if (existing) {
			// New evidence can arrive while an item is already open; the brief
			// must go stale and be regenerated even when no new threshold is
			// crossed.
			await synchronizeTriage(deps, {
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
	await synchronizeTriage(deps, {
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
