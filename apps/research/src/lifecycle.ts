// Run lifecycle (§4): idempotent ensure with advisory lock, token-claimed
// execution, and conditional finalize. Crash recovery, retry fencing and
// terminal cleanup live below (Temporal drives them). No partial writes:
// evidence/findings persist in the same transaction as success.
import { randomUUID } from "node:crypto";
import {
	agentEvidence,
	agentFindings,
	agentRuns,
	contextSignals,
	withTx,
	type Db,
	type Tx,
} from "@credit/db/research";
import { HttpError } from "@credit/service-kit";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { ResearchEnv } from "./env.js";
import { AGENT_VERSION, promptHash, PROMPT_VERSION } from "./agents/case-brief/prompt.js";
import { caseFactsSchema, type CaseFacts } from "@credit/core";
import { isUuid } from "./ids.js";

export type RunErrorCode =
	| "model_unavailable"
	| "tool_error"
	| "timeout"
	| "validation_failed"
	| "config_error"
	| "internal_error"
	| "case_facts_incomplete";

export type RunRow = typeof agentRuns.$inferSelect;

export type CaseFactsPayload = CaseFacts;

export interface EnsureInput {
	applicationId: string;
	requestedBy: string;
	/** Officer path: officer (default). Auto path: service. */
	requestedByRole?: "officer" | "service";
	/** Officer path: officer (default). Auto path: auto. */
	trigger?: "officer" | "auto";
	/** Auto path only: the Kafka envelope id (dedupe key). */
	triggerEventId?: string | null;
	/** Auto path only: internal cap accounting, never prompt/trace. */
	applicantUserId?: string | null;
	caseFacts: CaseFactsPayload;
	aiResearchConsent: boolean;
}

/** Public run summary for API responses (no case facts, no internals —
 * `applicantUserId` is cap accounting and never leaves the service). */
export function summarizeRun(run: RunRow): Record<string, unknown> {
	return {
		id: run.id,
		applicationId: run.applicationId,
		feature: run.feature,
		status: run.status,
		trigger: run.trigger,
		requestedBy: run.requestedBy,
		requestedByRole: run.requestedByRole,
		model: run.model,
		agentVersion: run.agentVersion,
		promptVersion: run.promptVersion,
		asOf: run.asOf.toISOString(),
		observability: run.observability,
		errorCode: run.errorCode,
		grafanaConversationId: run.grafanaConversationId,
		createdAt: run.createdAt.toISOString(),
		startedAt: run.startedAt?.toISOString() ?? null,
		finishedAt: run.finishedAt?.toISOString() ?? null,
		// T18 context stage (§3.1/§3.6): stage outcome rides the same run
		// row; the brief/signals join the aggregate in routes.ts.
		contextStatus: run.contextStatus,
		contextStageVersion: run.contextStageVersion,
		contextErrorCode: run.contextErrorCode,
		contextModel: run.contextModel,
		policyStatus: run.policyStatus,
		policyErrorCode: run.policyErrorCode,
		policyModel: run.policyModel,
		policyPromptVersion: run.policyPromptVersion,
	};
}

function storedCaseFacts(facts: CaseFactsPayload): Record<string, unknown> {
	// Single schema: new keys flow to storage, never silently dropped.
	// Consent rides the request, never the stored facts/prompt.
	const parsed = caseFactsSchema.parse(facts);
	const { aiResearchConsent: _consent, ...stored } = parsed;
	return stored;
}

/**
 * Idempotent by application: a repeat `triggerEventId` returns the original
 * run (even terminal) with `{inserted:false}` — zero new paid calls —
 * otherwise the active run when one exists, otherwise inserts `queued` with
 * a fresh run token. Execution starts only when `{inserted: true}`. Throws
 * HttpError (403/409/422) for rejected requests; incomplete facts persist
 * a failed run so latest explains why.
 */
export async function ensureRun(
	db: Db,
	env: ResearchEnv,
	input: EnsureInput,
): Promise<{ run: RunRow; inserted: boolean }> {
	return withTx(db, (tx) => ensureRunTx(tx, env, input));
}

/**
 * Same as `ensureRun`, but joins the caller's transaction so the insert
 * and the caller's audit row commit atomically (a failed audit leaves no
 * unaudited run behind).
 */
export async function ensureRunTx(
	tx: Tx,
	env: ResearchEnv,
	input: EnsureInput,
): Promise<{ run: RunRow; inserted: boolean }> {
	if (!input.aiResearchConsent) {
		throw new HttpError(403, "CONSENT_REQUIRED", "AI research consent is required");
	}
	const facts = input.caseFacts;
	const trigger = input.trigger ?? "officer";
	const requestedByRole = input.requestedByRole ?? "officer";
	const triggerEventId = input.triggerEventId ?? null;
	const applicantUserId = input.applicantUserId ?? null;
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.applicationId}))`);
	// T11: a repeat referral generation returns the original run even
	// when terminal — first, so redelivered events never insert again
	// (not even the failed row below). The advisory lock serializes
	// this with the inserts further down.
	if (triggerEventId) {
		const dup = await tx
			.select()
			.from(agentRuns)
			.where(
				and(
					eq(agentRuns.applicationId, input.applicationId),
					eq(agentRuns.trigger, trigger),
					eq(agentRuns.triggerEventId, triggerEventId),
				),
			)
			.limit(1);
		if (dup[0]) return { run: dup[0], inserted: false };
	}
	// Legacy rows without city need an SME registration number, else reject.
	if (facts.city === null && !facts.registrationNumber) {
		const [row] = await tx
			.insert(agentRuns)
			.values({
				applicationId: input.applicationId,
				feature: "case_brief",
				status: "failed",
				trigger,
				requestedBy: input.requestedBy,
				requestedByRole,
				triggerEventId,
				applicantUserId,
				runToken: null,
				caseFacts: storedCaseFacts(facts),
				model: env.agentModel,
				agentVersion: AGENT_VERSION,
				promptVersion: PROMPT_VERSION,
				promptHash: promptHash(),
				asOf: new Date(facts.asOf),
				grafanaConversationId: randomUUID(),
				observability: "degraded",
				errorCode: "case_facts_incomplete",
				error: "case facts are incomplete for research",
				usage: {},
				timeoutAt: new Date(Date.now() + env.timeoutMs + 30_000),
				finishedAt: new Date(),
			})
			.returning();
		return { run: row, inserted: false };
	}
	if (facts.status !== "pending_review") {
		throw new HttpError(409, "CASE_NOT_PENDING", "case is not awaiting an officer decision");
	}
	if (facts.asOf !== facts.submittedAt) {
		throw new HttpError(422, "VALIDATION_ERROR", "asOf must equal submittedAt");
	}
	const active = await tx
		.select()
		.from(agentRuns)
		.where(
			and(
				eq(agentRuns.applicationId, input.applicationId),
				eq(agentRuns.feature, "case_brief"),
				inArray(agentRuns.status, ["queued", "running"]),
			),
		)
		.orderBy(desc(agentRuns.createdAt))
		.limit(1);
	if (active[0]) return { run: active[0], inserted: false };
	const id = randomUUID();
	const [row] = await tx
		.insert(agentRuns)
		.values({
			id,
			applicationId: input.applicationId,
			feature: "case_brief",
			status: "queued",
			trigger,
			requestedBy: input.requestedBy,
			requestedByRole,
			triggerEventId,
			applicantUserId,
			runToken: randomUUID(),
			caseFacts: storedCaseFacts(facts),
			model: env.agentModel,
			agentVersion: AGENT_VERSION,
			promptVersion: PROMPT_VERSION,
			promptHash: promptHash(),
			asOf: new Date(facts.asOf),
			grafanaConversationId: id,
			observability: "degraded",
			usage: {},
			// Combined lease (§3.5): external + context + policy stages +
			// grace — the same budget as one Temporal attempt (runLeaseMs).
			timeoutAt: new Date(Date.now() + runLeaseMs(env)),
		})
		.returning();
	return { run: row, inserted: true };
}

export class StaleRunError extends Error {}

/** Malformed ids/tokens match nothing (uuid columns reject them with 22P02). */
function tokenMatch(runId: string, token: string): boolean {
	return isUuid(runId) && isUuid(token);
}

/** Claim a queued run for execution; false unless status+token match. */
export async function claimRun(db: Db, runId: string, token: string): Promise<boolean> {
	if (!tokenMatch(runId, token)) return false;
	const rows = await db
		.update(agentRuns)
		.set({ status: "running", startedAt: new Date(), heartbeatAt: new Date() })
		.where(
			and(eq(agentRuns.id, runId), eq(agentRuns.status, "queued"), eq(agentRuns.runToken, token)),
		)
		.returning({ id: agentRuns.id });
	return rows.length > 0;
}

export async function heartbeatRun(db: Db, runId: string, token: string): Promise<void> {
	if (!tokenMatch(runId, token)) return;
	await db
		.update(agentRuns)
		.set({ heartbeatAt: new Date() })
		.where(
			and(eq(agentRuns.id, runId), eq(agentRuns.status, "running"), eq(agentRuns.runToken, token)),
		);
}

/** Fail a run; false when the token already turned over (stale). The
 * failure row carries the caller's real observability status, never just
 * the insert default. `usage` is the accumulated partial spend (agent +
 * judge + repair tokens/cost so far): failed runs keep counting toward
 * the auto daily budget instead of reading as free. Omit it only when no
 * work was done (e.g. a losing claim race, which returns false anyway). */
export async function finalizeFailure(
	db: Db,
	runId: string,
	token: string,
	code: RunErrorCode,
	error: string,
	observability: "ok" | "degraded" = "degraded",
	usage?: Record<string, unknown>,
): Promise<boolean> {
	if (!tokenMatch(runId, token)) return false;
	const rows = await db
		.update(agentRuns)
		.set({
			status: "failed",
			errorCode: code,
			error,
			observability,
			...(usage !== undefined ? { usage } : {}),
			finishedAt: new Date(),
			runToken: null,
		})
		.where(
			and(eq(agentRuns.id, runId), eq(agentRuns.status, "running"), eq(agentRuns.runToken, token)),
		)
		.returning({ id: agentRuns.id });
	return rows.length > 0;
}

export async function latestRunForApplication(
	db: Db,
	applicationId: string,
): Promise<RunRow | null> {
	const rows = await db
		.select()
		.from(agentRuns)
		.where(and(eq(agentRuns.applicationId, applicationId), eq(agentRuns.feature, "case_brief")))
		.orderBy(desc(agentRuns.createdAt))
		.limit(1);
	return rows[0] ?? null;
}

export async function getRun(db: Db, runId: string): Promise<RunRow | null> {
	const rows = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
	return rows[0] ?? null;
}

// --- T18 context stage lifecycle (SPEC-t17-t18 §3.1/§3.5, D3b). ---
//
// The stage token (not run status) is authoritative: stage writers persist
// with `status IN ('running','succeeded','failed') AND
// context_status='running' AND context_stage_token=...`, so an external
// failure never blocks context persistence and a retry after terminal never
// touches the external brief. No `partial` run status exists.

export type ContextStatus =
	| "not_applicable"
	| "queued"
	| "running"
	| "succeeded"
	| "failed"
	| "skipped";

/** Max context stage attempts per run: the initial stage + one retry. */
export const MAX_CONTEXT_STAGES = 2;

export interface PersistedContextSignal {
	type: string;
	periodStart: string;
	periodEnd: string;
	metric: string;
	observed: number | null;
	expected: number | null;
	evidence: Array<{ kind: string; id: string; page?: number }>;
	confidence: "low" | "medium" | "high";
	status: "review" | "needs_chase" | "insufficient_data";
	policyVersion: string;
	accountScope: string;
	explanation: string;
}

/**
 * Initialize the stage right after the run claim: `queued` when the stage
 * will run, otherwise its terminal skip state. Predicate: running + token.
 */
export async function initContextStage(
	db: Db,
	env: ResearchEnv,
	runId: string,
	token: string,
	status: "queued" | "not_applicable" | "skipped",
): Promise<boolean> {
	if (!tokenMatch(runId, token)) return false;
	const rows = await db
		.update(agentRuns)
		.set({
			contextStatus: status,
			...(status === "queued"
				? { contextTimeoutAt: new Date(Date.now() + env.contextTimeoutMs + 30_000) }
				: {}),
		})
		.where(
			and(eq(agentRuns.id, runId), eq(agentRuns.status, "running"), eq(agentRuns.runToken, token)),
		)
		.returning({ id: agentRuns.id });
	return rows.length > 0;
}

/**
 * Terminal skip of a queued stage (consent withdrawn/missing): predicate
 * running + run token + queued. External research is unaffected.
 */
export async function skipContextStage(db: Db, runId: string, token: string): Promise<boolean> {
	if (!tokenMatch(runId, token)) return false;
	const rows = await db
		.update(agentRuns)
		.set({ contextStatus: "skipped" })
		.where(
			and(
				eq(agentRuns.id, runId),
				eq(agentRuns.status, "running"),
				eq(agentRuns.runToken, token),
				eq(agentRuns.contextStatus, "queued"),
			),
		)
		.returning({ id: agentRuns.id });
	return rows.length > 0;
}
/**
 * Claim the queued stage for execution: sets running + a fresh stage token,
 * refreshes the combined run lease, and supersedes prior signals (a new
 * stage version owns the reads). False unless running + token + queued.
 */
export async function claimContextStage(
	db: Db,
	env: ResearchEnv,
	runId: string,
	token: string,
	opts: { promptVersion: string; model: string },
): Promise<string | null> {
	if (!tokenMatch(runId, token)) return null;
	const stageToken = randomUUID();
	const claimed = await withTx(db, async (tx) => {
		const rows = await tx
			.update(agentRuns)
			.set({
				contextStatus: "running",
				contextStageToken: stageToken,
				contextStartedAt: new Date(),
				contextHeartbeatAt: new Date(),
				contextTimeoutAt: new Date(Date.now() + env.contextTimeoutMs + 30_000),
				contextPromptVersion: opts.promptVersion,
				contextModel: opts.model,
				timeoutAt: new Date(Date.now() + env.contextTimeoutMs + 30_000),
			})
			.where(
				and(
					eq(agentRuns.id, runId),
					eq(agentRuns.status, "running"),
					eq(agentRuns.runToken, token),
					eq(agentRuns.contextStatus, "queued"),
				),
			)
			.returning({ id: agentRuns.id });
		if (rows.length === 0) return null;
		await tx
			.update(contextSignals)
			.set({ supersededAt: new Date() })
			.where(and(eq(contextSignals.runId, runId), sql`${contextSignals.supersededAt} IS NULL`));
		return stageToken;
	});
	return claimed;
}

export async function heartbeatContextStage(
	db: Db,
	runId: string,
	stageToken: string,
): Promise<void> {
	if (!tokenMatch(runId, stageToken)) return;
	await db
		.update(agentRuns)
		.set({ contextHeartbeatAt: new Date() })
		.where(
			and(
				eq(agentRuns.id, runId),
				eq(agentRuns.contextStatus, "running"),
				eq(agentRuns.contextStageToken, stageToken),
			),
		);
}

interface StageGuard {
	id: string;
	status: string;
	contextStatus: string;
	contextStageToken: string | null;
	contextStageVersion: number;
}

async function loadStageGuard(tx: Tx, runId: string): Promise<StageGuard | null> {
	const rows = (await tx.execute(
		sql`SELECT id, status, context_status, context_stage_token, context_stage_version FROM agent_runs WHERE id = ${runId} FOR UPDATE`,
	)) as unknown as Array<{
		id: string;
		status: string;
		context_status: string;
		context_stage_token: string | null;
		context_stage_version: number;
	}>;
	const row = rows[0];
	if (!row) return null;
	return {
		id: row.id,
		status: row.status,
		contextStatus: row.context_status,
		contextStageToken: row.context_stage_token,
		contextStageVersion: row.context_stage_version,
	};
}

/** Stage-writer predicate: terminal runs stay writable via the stage token. */
function stageTokenMatches(guard: StageGuard, stageToken: string): boolean {
	return (
		tokenMatch(guard.id, stageToken) &&
		(guard.status === "running" || guard.status === "succeeded" || guard.status === "failed") &&
		guard.contextStatus === "running" &&
		guard.contextStageToken === stageToken
	);
}

/**
 * Persist a succeeded stage: supersede-then-insert signals (old rows are
 * never mutated — the unique key rides the new stage version), set the
 * server-composed brief, clear the token. Never changes run status or the
 * external brief. False when the token turned over (stale).
 *
 * `opts.consent === false` aborts inside the transaction with zero writes:
 * the caller re-probes live consent just before persisting and passes it
 * here, so a withdrawal racing the model call cannot land persisted context.
 */
export async function persistContextSuccess(
	db: Db,
	runId: string,
	stageToken: string,
	data: {
		brief: Record<string, unknown>;
		validation: Record<string, unknown>;
		usage: Record<string, unknown>;
		signals: PersistedContextSignal[];
	},
	opts: { consent?: boolean } = {},
): Promise<boolean> {
	return withTx(db, async (tx) => {
		const guard = await loadStageGuard(tx, runId);
		if (!guard || !stageTokenMatches(guard, stageToken)) return false;
		if (opts.consent === false) return false;
		await tx
			.update(contextSignals)
			.set({ supersededAt: new Date() })
			.where(and(eq(contextSignals.runId, runId), sql`${contextSignals.supersededAt} IS NULL`));
		// Dedupe by the row unique key (scope/type/period/metric): a model
		// emitting the same candidate twice must not 23505 the insert.
		const deduped = new Map<string, (typeof data.signals)[number]>();
		for (const s of data.signals) {
			const key = [s.accountScope, s.type, s.periodStart, s.periodEnd, s.metric].join("\n");
			if (!deduped.has(key)) deduped.set(key, s);
		}
		const signals = [...deduped.values()];
		if (signals.length > 0) {
			await tx.insert(contextSignals).values(
				signals.map((s) => ({
					runId,
					stageVersion: guard.contextStageVersion,
					accountId: s.accountScope === "all" ? null : s.accountScope,
					accountScope: s.accountScope,
					type: s.type,
					periodStart: s.periodStart,
					periodEnd: s.periodEnd,
					metric: s.metric,
					observed: s.observed === null ? null : String(s.observed),
					expected: s.expected === null ? null : String(s.expected),
					confidence: s.confidence,
					status: s.status,
					policyVersion: s.policyVersion,
					explanation: s.explanation,
					evidence: s.evidence,
				})),
			);
		}
		await tx
			.update(agentRuns)
			.set({
				contextStatus: "succeeded",
				contextBrief: data.brief,
				contextValidation: data.validation,
				contextUsage: data.usage,
				contextFinishedAt: new Date(),
				contextHeartbeatAt: new Date(),
				contextStageToken: null,
			})
			.where(eq(agentRuns.id, runId));
		return true;
	});
}

/**
 * Persist a failed stage with a sanitized code. Same stale-token predicate
 * as success; never touches run status or the external brief.
 */
export async function persistContextFailure(
	db: Db,
	runId: string,
	stageToken: string,
	code: string,
	usage?: Record<string, unknown>,
): Promise<boolean> {
	if (!tokenMatch(runId, stageToken)) return false;
	const rows = await db
		.update(agentRuns)
		.set({
			contextStatus: "failed",
			contextErrorCode: code,
			...(usage !== undefined ? { contextUsage: usage } : {}),
			contextFinishedAt: new Date(),
			contextStageToken: null,
		})
		.where(
			and(
				eq(agentRuns.id, runId),
				inArray(agentRuns.status, ["running", "succeeded", "failed"]),
				eq(agentRuns.contextStatus, "running"),
				eq(agentRuns.contextStageToken, stageToken),
			),
		)
		.returning({ id: agentRuns.id });
	return rows.length > 0;
}

/**
 * Retry claim (D3 internal seam; the D4 review route proxies it): only for a
 * terminal run whose stage is terminal-failed/skipped with no live token,
 * and only once (stage_version 1 → 2). Starts a new stage version and
 * supersedes prior signals. Returns the new token/version, or null.
 *
 * The tx-scoped core composes with a caller's transaction so budget guards
 * and the claim commit atomically (no concurrent-retry budget bypass).
 */
export async function claimContextRetry(
	db: Db,
	env: ResearchEnv,
	runId: string,
): Promise<{ stageToken: string; stageVersion: number } | null> {
	if (!isUuid(runId)) return null;
	return withTx(db, (tx) => claimContextRetryTx(tx, env, runId));
}

export async function claimContextRetryTx(
	tx: Tx,
	env: ResearchEnv,
	runId: string,
): Promise<{ stageToken: string; stageVersion: number } | null> {
	if (!isUuid(runId)) return null;
	const guard = await loadStageGuard(tx, runId);
	if (!guard) return null;
	if (
		(guard.status !== "succeeded" && guard.status !== "failed") ||
		(guard.contextStatus !== "failed" && guard.contextStatus !== "skipped") ||
		guard.contextStageToken !== null ||
		guard.contextStageVersion >= MAX_CONTEXT_STAGES
	) {
		return null;
	}
	const stageToken = randomUUID();
	const version = guard.contextStageVersion + 1;
	await tx
		.update(agentRuns)
		.set({
			contextStatus: "running",
			contextStageToken: stageToken,
			contextStageVersion: version,
			contextStartedAt: new Date(),
			contextFinishedAt: null,
			// Null until an agent attempt beats: the sweep reads "never
			// heartbeated" as "workflow never started" (token still original).
			contextHeartbeatAt: null,
			contextTimeoutAt: new Date(Date.now() + env.contextTimeoutMs + 30_000),
			contextErrorCode: null,
		})
		.where(eq(agentRuns.id, runId));
	await tx
		.update(contextSignals)
		.set({ supersededAt: new Date() })
		.where(and(eq(contextSignals.runId, runId), sql`${contextSignals.supersededAt} IS NULL`));
	return { stageToken, stageVersion: version };
}

export interface PolicySignalRow {
	type: string;
	metric: string;
	periodStart: string;
	periodEnd: string;
	accountScope: string;
	status: "review" | "needs_chase" | "insufficient_data";
	confidence: "low" | "medium" | "high";
}

export async function loadPolicySignals(db: Db, runId: string): Promise<PolicySignalRow[]> {
	const rows = await db
		.select({
			type: contextSignals.type,
			metric: contextSignals.metric,
			periodStart: contextSignals.periodStart,
			periodEnd: contextSignals.periodEnd,
			accountScope: contextSignals.accountScope,
			status: contextSignals.status,
			confidence: contextSignals.confidence,
		})
		.from(contextSignals)
		.where(and(eq(contextSignals.runId, runId), sql`${contextSignals.supersededAt} IS NULL`))
		.orderBy(asc(contextSignals.periodStart), asc(contextSignals.type), asc(contextSignals.metric));
	return rows.map((row) => ({
		type: row.type,
		metric: row.metric,
		periodStart: row.periodStart ?? "",
		periodEnd: row.periodEnd ?? "",
		accountScope: row.accountScope,
		status: row.status,
		confidence: row.confidence,
	}));
}

export async function beginPolicyStage(
	db: Db,
	env: ResearchEnv,
	runId: string,
	token: string,
	opts: { model: string; promptVersion: string; documentFindings: unknown },
): Promise<boolean> {
	if (!tokenMatch(runId, token)) return false;
	const now = new Date();
	const policyTimeoutAt = new Date(now.getTime() + env.policyCaseTimeoutMs + 30_000);
	const rows = await db
		.update(agentRuns)
		.set({
			policyStatus: "running",
			policyStartedAt: now,
			policyFinishedAt: null,
			policyTimeoutAt,
			policyHeartbeatAt: now,
			policyErrorCode: null,
			policyModel: opts.model,
			policyPromptVersion: opts.promptVersion,
			contextDocumentFindings: opts.documentFindings,
			// Extend the run lease past the synchronous policy call; never
			// shorten an existing context lease.
			timeoutAt: sql`GREATEST(${agentRuns.timeoutAt}, ${policyTimeoutAt})`,
		})
		.where(
			and(eq(agentRuns.id, runId), eq(agentRuns.status, "running"), eq(agentRuns.runToken, token)),
		)
		.returning({ id: agentRuns.id });
	return rows.length > 0;
}

export async function heartbeatPolicyStage(db: Db, runId: string, token: string): Promise<void> {
	if (!tokenMatch(runId, token)) return;
	await db
		.update(agentRuns)
		.set({ policyHeartbeatAt: new Date() })
		.where(
			and(
				eq(agentRuns.id, runId),
				eq(agentRuns.status, "running"),
				eq(agentRuns.runToken, token),
				eq(agentRuns.policyStatus, "running"),
			),
		);
}

export async function persistPolicySuccess(
	db: Db,
	runId: string,
	token: string,
	data: {
		status: "succeeded" | "no_match" | "needs_policy_owner" | "budget_exceeded";
		brief: Record<string, unknown> | null;
		validation: Record<string, unknown> | null;
		usage: Record<string, unknown> | null;
	},
): Promise<boolean> {
	if (!tokenMatch(runId, token)) return false;
	const rows = await db
		.update(agentRuns)
		.set({
			policyStatus: data.status,
			policyBrief: data.brief,
			policyValidation: data.validation,
			policyUsage: data.usage,
			policyFinishedAt: new Date(),
			policyHeartbeatAt: new Date(),
			policyErrorCode: data.status === "budget_exceeded" ? "budget_exceeded" : null,
		})
		.where(
			and(
				eq(agentRuns.id, runId),
				eq(agentRuns.status, "running"),
				eq(agentRuns.runToken, token),
				eq(agentRuns.policyStatus, "running"),
			),
		)
		.returning({ id: agentRuns.id });
	return rows.length > 0;
}

export async function skipPolicyStage(
	db: Db,
	runId: string,
	token: string,
	code: string,
): Promise<boolean> {
	if (!tokenMatch(runId, token)) return false;
	const rows = await db
		.update(agentRuns)
		.set({
			policyStatus: "skipped",
			policyErrorCode: code,
			policyFinishedAt: new Date(),
			policyHeartbeatAt: new Date(),
		})
		.where(
			and(eq(agentRuns.id, runId), eq(agentRuns.status, "running"), eq(agentRuns.runToken, token)),
		)
		.returning({ id: agentRuns.id });
	return rows.length > 0;
}

export async function persistPolicyFailure(
	db: Db,
	runId: string,
	token: string,
	status: "failed" | "skipped",
	code: string,
	usage?: Record<string, unknown>,
): Promise<boolean> {
	if (!tokenMatch(runId, token)) return false;
	const rows = await db
		.update(agentRuns)
		.set({
			policyStatus: status,
			policyErrorCode: code,
			...(usage !== undefined ? { policyUsage: usage } : {}),
			policyFinishedAt: new Date(),
			policyHeartbeatAt: new Date(),
		})
		.where(
			and(
				eq(agentRuns.id, runId),
				eq(agentRuns.status, "running"),
				eq(agentRuns.runToken, token),
				eq(agentRuns.policyStatus, "running"),
			),
		)
		.returning({ id: agentRuns.id });
	return rows.length > 0;
}

// --- Temporal-driven durability (replaces the reapers + boot recovery). ---
//
// Temporal owns dispatch, crash retries and the terminal "mark failed"
// step; these helpers are the DB half of that contract. Every fence is the
// existing token guard: rotating a token makes the dead attempt's writes
// fail with StaleRunError / a false return.

/** Whole-run lease: external + context + policy stage budgets + grace. Also the
 * per-attempt Temporal start-to-close budget. */
export function runLeaseMs(env: ResearchEnv): number {
	return env.timeoutMs + env.contextTimeoutMs + env.policyCaseTimeoutMs + 30_000;
}

/** Grace past the whole retry horizon before the sweep fails a row. */
export const OVERDUE_GRACE_MS = 5 * 60_000;

/**
 * Attempts agentRunWorkflow drives per run. Mirrors agent-kit's
 * DEFAULT_MAX_ATTEMPTS (research inputs never override it) and its backoff
 * (2s doubling, 30s cap) below.
 */
export const RUN_MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_INITIAL_MS = 2_000;
const RETRY_BACKOFF_MAX_MS = 30_000;

/**
 * Longest a live workflow can keep a row active: every attempt's full
 * start-to-close lease, the backoff between attempts, plus
 * OVERDUE_GRACE_MS. The sweep never fails a row inside this horizon, so a
 * live retry (or a start waiting on a backlogged worker) is never killed.
 */
export function activeHorizonMs(attemptLeaseMs: number, maxAttempts = RUN_MAX_ATTEMPTS): number {
	let backoff = 0;
	for (let attempt = 1; attempt < maxAttempts; attempt++) {
		backoff += Math.min(RETRY_BACKOFF_MAX_MS, RETRY_BACKOFF_INITIAL_MS * 2 ** (attempt - 1));
	}
	return attemptLeaseMs * maxAttempts + backoff + OVERDUE_GRACE_MS;
}

/** Context-retry attempt lease: stage deadline + grace (one workflow attempt). */
export function contextRetryLeaseMs(env: ResearchEnv): number {
	return env.contextTimeoutMs + 30_000;
}

/**
 * Fence a retried attempt (attempt > 1) before it does any work. In one
 * transaction, only while the run is non-terminal: rotate `run_token` to a
 * fresh uuid, reset to `queued`, refresh the lease, and discard everything
 * the dead attempt persisted (evidence, findings, context signals, stage
 * state and the retained external outcome) so the rerun re-initializes the
 * stages from scratch. The dead attempt's token-guarded writes then fail.
 * Returns the new token, or null when the run is terminal/missing (no work).
 *
 * Spend already incurred by the dead attempt is not carried forward (the
 * rerun's own ledger starts fresh).
 */
export async function rotateRunForRetry(
	db: Db,
	env: ResearchEnv,
	runId: string,
): Promise<string | null> {
	if (!isUuid(runId)) return null;
	return withTx(db, async (tx) => {
		const rows = (await tx.execute(
			sql`SELECT status FROM agent_runs WHERE id = ${runId} FOR UPDATE`,
		)) as unknown as Array<{ status: string }>;
		const row = rows[0];
		if (!row || (row.status !== "queued" && row.status !== "running")) return null;
		await tx.delete(agentEvidence).where(eq(agentEvidence.runId, runId));
		await tx.delete(agentFindings).where(eq(agentFindings.runId, runId));
		await tx.delete(contextSignals).where(eq(contextSignals.runId, runId));
		const token = randomUUID();
		const now = new Date();
		await tx
			.update(agentRuns)
			.set({
				runToken: token,
				status: "queued",
				startedAt: null,
				// Stamped so the sweep never mistakes the rotated token for a
				// never-started row (it only restarts heartbeat-less rows).
				heartbeatAt: now,
				timeoutAt: new Date(now.getTime() + runLeaseMs(env)),
				brief: null,
				validation: null,
				errorCode: null,
				error: null,
				contextStatus: "not_applicable",
				contextBrief: null,
				contextValidation: null,
				contextUsage: null,
				contextErrorCode: null,
				contextStartedAt: null,
				contextFinishedAt: null,
				contextTimeoutAt: null,
				contextHeartbeatAt: null,
				contextPromptVersion: null,
				contextModel: null,
				contextStageToken: null,
				contextDocumentFindings: null,
				policyStatus: "not_applicable",
				policyBrief: null,
				policyValidation: null,
				policyUsage: null,
				policyErrorCode: null,
				policyModel: null,
				policyPromptVersion: null,
				policyStartedAt: null,
				policyFinishedAt: null,
				policyTimeoutAt: null,
				policyHeartbeatAt: null,
			})
			.where(eq(agentRuns.id, runId));
		return token;
	});
}

/**
 * Fence a retried context-retry attempt: rotate the stage token of the
 * running stage on a terminal run (the dead attempt's stage writes then
 * fail). Null when no stage is running (it already finished or failed).
 */
export async function rotateContextStageForRetry(db: Db, runId: string): Promise<string | null> {
	if (!isUuid(runId)) return null;
	const token = randomUUID();
	const rows = await db
		.update(agentRuns)
		.set({ contextStageToken: token, contextHeartbeatAt: new Date() })
		.where(
			and(
				eq(agentRuns.id, runId),
				inArray(agentRuns.status, ["succeeded", "failed"]),
				eq(agentRuns.contextStatus, "running"),
			),
		)
		.returning({ id: agentRuns.id });
	return rows.length > 0 ? token : null;
}

/**
 * Terminal cleanup for a run whose workflow failed or was cancelled (or
 * whose start never happened): fail a still-active run (queued/running,
 * any token) and the stages the dead attempt left queued/running, clearing
 * the token. Idempotent; a terminal run (and its persisted brief/stages)
 * is never touched. Returns whether this call failed the run.
 */
export async function failActiveRun(
	db: Db,
	runId: string,
	failure: { code: RunErrorCode; message: string },
	opts: { staleForSecs?: number } = {},
): Promise<boolean> {
	if (!isUuid(runId)) return false;
	// Sweep backstop: re-check staleness under the row lock so a run that
	// heartbeated since the sweep's select is never failed.
	const staleSecs = opts.staleForSecs ?? 0;
	return withTx(db, async (tx) => {
		const rows = (await tx.execute(
			sql`SELECT status, context_status, policy_status,
				coalesce(heartbeat_at, created_at) < now() - make_interval(secs => ${staleSecs}) AS stale
				FROM agent_runs WHERE id = ${runId} FOR UPDATE`,
		)) as unknown as Array<{
			status: string;
			context_status: string;
			policy_status: string;
			stale: boolean;
		}>;
		const row = rows[0];
		if (!row || (row.status !== "queued" && row.status !== "running")) return false;
		if (opts.staleForSecs !== undefined && !row.stale) return false;
		const now = new Date();
		const stageCode = failure.code === "timeout" ? "timeout" : "internal_error";
		await tx
			.update(agentRuns)
			.set({
				status: "failed",
				errorCode: failure.code,
				error: failure.message,
				finishedAt: now,
				runToken: null,
				...(row.context_status === "queued" || row.context_status === "running"
					? {
							contextStatus: "failed" as const,
							contextErrorCode: stageCode,
							contextFinishedAt: now,
							contextStageToken: null,
						}
					: {}),
				...(row.policy_status === "running"
					? {
							policyStatus: "failed" as const,
							policyErrorCode: stageCode,
							policyFinishedAt: now,
							policyHeartbeatAt: now,
						}
					: {}),
			})
			.where(eq(agentRuns.id, runId));
		return true;
	});
}

/**
 * Terminal cleanup for a context-retry workflow: fail the stage still
 * running on the (terminal) run. The stage token may have rotated across
 * attempts, so the match is the running stage itself; run status, brief
 * and evidence are never touched.
 */
export async function failRunningContextStage(
	db: Db,
	runId: string,
	code: string,
	opts: { staleForSecs?: number } = {},
): Promise<boolean> {
	if (!isUuid(runId)) return false;
	const rows = await db
		.update(agentRuns)
		.set({
			contextStatus: "failed",
			contextErrorCode: code,
			contextFinishedAt: new Date(),
			contextStageToken: null,
		})
		.where(
			and(
				eq(agentRuns.id, runId),
				inArray(agentRuns.status, ["succeeded", "failed"]),
				eq(agentRuns.contextStatus, "running"),
				opts.staleForSecs === undefined
					? undefined
					: sql`coalesce(${agentRuns.contextHeartbeatAt}, ${agentRuns.contextStartedAt}) < now() - make_interval(secs => ${opts.staleForSecs})`,
			),
		)
		.returning({ id: agentRuns.id });
	return rows.length > 0;
}

export interface PendingStart {
	runId: string;
	token: string;
}

/**
 * Queued runs committed but never picked up (API crashed or Temporal was
 * down between commit and start). Only rows that never heartbeated: a
 * rotated/claimed row always has a heartbeat, so its token is no longer
 * the workflow's original and must not be restarted.
 */
export async function listUnstartedRuns(db: Db, olderThanSeconds = 10): Promise<PendingStart[]> {
	const rows = (await db.execute(sql`SELECT id, run_token FROM agent_runs
		WHERE status = 'queued' AND run_token IS NOT NULL AND heartbeat_at IS NULL
		  AND created_at < now() - make_interval(secs => ${olderThanSeconds})`)) as unknown as Array<{
		id: string;
		run_token: string;
	}>;
	return rows.map((r) => ({ runId: r.id, token: r.run_token }));
}

/** Context retries claimed but never started (same heartbeat-null rule). */
export async function listUnstartedContextRetries(
	db: Db,
	olderThanSeconds = 10,
): Promise<PendingStart[]> {
	const rows = (await db.execute(sql`SELECT id, context_stage_token FROM agent_runs
		WHERE status IN ('succeeded', 'failed') AND context_status = 'running'
		  AND context_stage_token IS NOT NULL AND context_heartbeat_at IS NULL
		  AND context_started_at < now() - make_interval(secs => ${olderThanSeconds})`)) as unknown as Array<{
		id: string;
		context_stage_token: string;
	}>;
	return rows.map((r) => ({ runId: r.id, token: r.context_stage_token }));
}

/**
 * Sweep backstop for orphaned active runs: a queued or running row whose
 * last sign of life (DB heartbeat, else creation) is older than the whole
 * retry horizon (activeHorizonMs: lease x attempts + backoff + grace) has
 * no live workflow — never started (Temporal unreachable), terminated,
 * failAgentRun exhausted, history lost, or a pre-migration in-flight row.
 * It fails "timeout" through failActiveRun (stages included), so the UI
 * reaches a terminal state and ensureRunTx stops returning it as the
 * active run. A live attempt heartbeats every 15s and a started run waiting
 * on a backlogged worker stays inside the horizon, so neither is killed.
 * Returns the failed run ids.
 */
export async function failOrphanedRuns(db: Db, env: ResearchEnv): Promise<string[]> {
	const staleForSecs = activeHorizonMs(runLeaseMs(env)) / 1000;
	const rows = (await db.execute(sql`SELECT id FROM agent_runs
		WHERE status IN ('queued', 'running')
		  AND coalesce(heartbeat_at, created_at) < now() - make_interval(secs => ${staleForSecs})`)) as unknown as Array<{
		id: string;
	}>;
	const failed: string[] = [];
	for (const { id } of rows) {
		const done = await failActiveRun(
			db,
			id,
			{ code: "timeout", message: "research run timed out" },
			{ staleForSecs },
		);
		if (done) failed.push(id);
	}
	return failed;
}

/**
 * Same backstop for stages left running on a terminal run: a context
 * stage (an unstarted or dead retry, or an initial stage whose failure
 * never persisted) and a policy stage. Run status, brief and evidence are
 * never touched. Returns the run ids whose stage this call failed.
 */
export async function failOrphanedStages(db: Db, env: ResearchEnv): Promise<string[]> {
	const contextStaleSecs = activeHorizonMs(contextRetryLeaseMs(env)) / 1000;
	const contextRows = (await db.execute(sql`SELECT id FROM agent_runs
		WHERE status IN ('succeeded', 'failed') AND context_status = 'running'
		  AND coalesce(context_heartbeat_at, context_started_at) < now() - make_interval(secs => ${contextStaleSecs})`)) as unknown as Array<{
		id: string;
	}>;
	const failed: string[] = [];
	for (const { id } of contextRows) {
		const done = await failRunningContextStage(db, id, "timeout", {
			staleForSecs: contextStaleSecs,
		});
		if (done) failed.push(id);
	}
	// Policy only runs inside a run attempt: once the run is terminal a
	// running policy stage is orphaned (it would otherwise hold an auto
	// budget reservation forever).
	const policyStaleSecs = activeHorizonMs(runLeaseMs(env)) / 1000;
	const policyRows = await db
		.update(agentRuns)
		.set({
			policyStatus: "failed",
			policyErrorCode: "timeout",
			policyFinishedAt: new Date(),
		})
		.where(
			and(
				inArray(agentRuns.status, ["succeeded", "failed"]),
				eq(agentRuns.policyStatus, "running"),
				sql`coalesce(${agentRuns.policyHeartbeatAt}, ${agentRuns.policyStartedAt}, ${agentRuns.createdAt}) < now() - make_interval(secs => ${policyStaleSecs})`,
			),
		)
		.returning({ id: agentRuns.id });
	for (const { id } of policyRows) if (!failed.includes(id)) failed.push(id);
	return failed;
}
