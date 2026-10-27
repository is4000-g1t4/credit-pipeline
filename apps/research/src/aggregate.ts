// Read model for latest/bundle responses: one aggregate per run joining
// evidence, findings, links, reviews, context signals, and policy state.
// Moved verbatim from routes.ts; shaping rules unchanged.
import {
	agentEvidence,
	agentFindingReviews,
	agentFindings,
	agentRunViews,
	contextSignalReviews,
	contextSignals,
	findingEvidence,
	type Db,
} from "@credit/db/research";
import { and, desc, eq, sql } from "drizzle-orm";
import { summarizeRun, type RunRow } from "./lifecycle.js";

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

export interface AggregateFinding {
	id: string;
	claim: string;
	category: string;
	whyItMatters: string;
	allegationStatus: string;
	support: string;
	confidence: string;
	confidenceBasis: unknown;
	entityMatch: unknown;
	evidenceIds: string[];
	evidence: AggregateEvidence[];
	reviewStatus: string;
	reviewedAt: string | null;
}

export interface AggregateEvidence {
	id: string;
	url: string;
	finalUrl: string;
	title: string | null;
	publisher: string;
	publishedAt: string | null;
	dateBasis: string;
	retrievedAt: string | null;
	quote: string;
	quoteStart: number;
	quoteEnd: number;
	snapshotText: string;
	snapshotHash: string;
	rawContentSha256: string | null;
	sourceTier: string;
}

/** Single context-signal DTO: latest read and signal review share it. */
export function toContextSignalDto(
	s: typeof contextSignals.$inferSelect,
	review?: { action: string; reviewedAt: string | null },
): {
	id: string;
	stageVersion: number;
	accountScope: string;
	type: string;
	periodStart: string | null;
	periodEnd: string | null;
	metric: string;
	observed: number | null;
	expected: number | null;
	confidence: string;
	status: string;
	policyVersion: string;
	explanation: string | null;
	evidence: unknown;
	reviewStatus: string;
	reviewedAt: string | null;
} {
	return {
		id: s.id,
		stageVersion: s.stageVersion,
		accountScope: s.accountScope,
		type: s.type,
		periodStart: s.periodStart,
		periodEnd: s.periodEnd,
		metric: s.metric,
		observed: s.observed === null ? null : Number(s.observed),
		expected: s.expected === null ? null : Number(s.expected),
		confidence: s.confidence,
		status: s.status,
		policyVersion: s.policyVersion,
		explanation: s.explanation,
		evidence: s.evidence,
		reviewStatus: review?.action ?? "pending",
		reviewedAt: review?.reviewedAt ?? null,
	};
}
/** Single evidence DTO: top-level and per-finding share it. */
function toEvidenceDto(e: typeof agentEvidence.$inferSelect): AggregateEvidence {
	return {
		id: e.id,
		url: e.url,
		finalUrl: e.finalUrl,
		title: e.title,
		publisher: e.publisher,
		publishedAt: e.publishedAt,
		dateBasis: e.dateBasis,
		retrievedAt: iso(e.retrievedAt),
		quote: e.quote,
		quoteStart: e.quoteStart,
		quoteEnd: e.quoteEnd,
		snapshotText: e.snapshotText,
		snapshotHash: e.snapshotHash,
		rawContentSha256: e.rawContentSha256,
		sourceTier: e.sourceTier,
	};
}

export async function aggregateRun(
	db: Db,
	run: RunRow,
	officerId: string,
	opts: { includeContext?: boolean; includePolicy?: boolean } = {},
): Promise<{
	run: Record<string, unknown>;
	brief: unknown;
	validation: unknown;
	usage: unknown;
	evidence: AggregateEvidence[];
	findings: AggregateFinding[];
	context: {
		status: string;
		stageVersion: number;
		errorCode: string | null;
		model: string | null;
		brief: unknown;
		validation: unknown;
		usage: unknown;
		startedAt: string | null;
		finishedAt: string | null;
		signals: Array<ReturnType<typeof toContextSignalDto>>;
	};
	policy: {
		status: string;
		errorCode: string | null;
		model: string | null;
		promptVersion: string | null;
		brief: unknown;
		validation: unknown;
		usage: unknown;
		startedAt: string | null;
		finishedAt: string | null;
	};
	viewedAt: string | null;
}> {
	const [evidenceRows, findingRows, linkRows, reviewRows, viewRows, signalRows, signalReviewRows] =
		await Promise.all([
			db.select().from(agentEvidence).where(eq(agentEvidence.runId, run.id)),
			db.select().from(agentFindings).where(eq(agentFindings.runId, run.id)),
			db
				.select()
				.from(findingEvidence)
				.where(sql`finding_id IN (SELECT id FROM agent_findings WHERE run_id = ${run.id})`),
			db
				.select()
				.from(agentFindingReviews)
				.where(eq(agentFindingReviews.runId, run.id))
				.orderBy(desc(agentFindingReviews.createdAt)),
			db
				.select({ viewedAt: agentRunViews.viewedAt })
				.from(agentRunViews)
				.where(and(eq(agentRunViews.runId, run.id), eq(agentRunViews.officerId, officerId)))
				.orderBy(desc(agentRunViews.viewedAt))
				.limit(1),
			// T18: reads return only the live stage version (`superseded_at IS
			// NULL`); superseded rows stay historical. A terminal failed run
			// still exposes its stored context here.
			db
				.select()
				.from(contextSignals)
				.where(and(eq(contextSignals.runId, run.id), sql`${contextSignals.supersededAt} IS NULL`)),
			db
				.select()
				.from(contextSignalReviews)
				.where(eq(contextSignalReviews.runId, run.id))
				.orderBy(desc(contextSignalReviews.createdAt)),
		]);
	const evidenceById = new Map(evidenceRows.map((e) => [e.id, e]));
	const findingEvidenceIds = new Map<string, string[]>();
	for (const link of linkRows) {
		const list = findingEvidenceIds.get(link.findingId) ?? [];
		list.push(link.evidenceId);
		findingEvidenceIds.set(link.findingId, list);
	}
	const latestReview = new Map<string, { action: string; createdAt: Date }>();
	for (const review of reviewRows) {
		if (!latestReview.has(review.findingId)) {
			latestReview.set(review.findingId, { action: review.action, createdAt: review.createdAt });
		}
	}
	// Append-only signal reviews: latest action per live signal (badges in
	// the UI); history stays in the table and audit log.
	const latestSignalReview = new Map<string, { action: string; reviewedAt: string }>();
	for (const review of signalReviewRows) {
		if (!latestSignalReview.has(review.signalId)) {
			latestSignalReview.set(review.signalId, {
				action: review.action,
				reviewedAt: review.createdAt.toISOString(),
			});
		}
	}
	// Withdrawn consent omits stored context at read time (the caller
	// audits context.denied): status/version stay visible as metadata, but
	// no brief, usage, or signal content leaves the service.
	const includeContext = opts.includeContext ?? true;
	const includePolicy = opts.includePolicy ?? true;
	return {
		run: summarizeRun(run),
		brief: run.brief,
		validation: run.validation,
		usage: run.usage,
		evidence: evidenceRows.map(toEvidenceDto),
		findings: findingRows.map((f) => {
			const evidenceIds = findingEvidenceIds.get(f.id) ?? [];
			const review = latestReview.get(f.id);
			return {
				id: f.id,
				claim: f.claim,
				category: f.category,
				whyItMatters: f.whyItMatters,
				allegationStatus: f.allegationStatus,
				support: f.support,
				confidence: f.confidence,
				confidenceBasis: f.confidenceBasis,
				entityMatch: f.entityMatch,
				evidenceIds,
				evidence: evidenceIds.flatMap((id) => {
					const e = evidenceById.get(id);
					return e ? [toEvidenceDto(e)] : [];
				}),
				reviewStatus: review?.action ?? "pending",
				reviewedAt: review ? review.createdAt.toISOString() : null,
			};
		}),
		context: {
			status: run.contextStatus,
			stageVersion: run.contextStageVersion,
			errorCode: run.contextErrorCode,
			model: run.contextModel,
			brief: includeContext ? run.contextBrief : null,
			validation: includeContext ? run.contextValidation : null,
			usage: includeContext ? run.contextUsage : null,
			startedAt: iso(run.contextStartedAt),
			finishedAt: iso(run.contextFinishedAt),
			signals: includeContext
				? signalRows.map((s) => toContextSignalDto(s, latestSignalReview.get(s.id)))
				: [],
		},
		policy: {
			status: run.policyStatus,
			errorCode: run.policyErrorCode,
			model: run.policyModel,
			promptVersion: run.policyPromptVersion,
			brief: includePolicy ? run.policyBrief : null,
			validation: includePolicy ? run.policyValidation : null,
			usage: includePolicy ? run.policyUsage : null,
			startedAt: iso(run.policyStartedAt),
			finishedAt: iso(run.policyFinishedAt),
		},
		viewedAt: viewRows[0] ? viewRows[0].viewedAt.toISOString() : null,
	};
}
