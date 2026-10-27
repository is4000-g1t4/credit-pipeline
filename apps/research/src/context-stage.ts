// T18 context stage (§3.5): consent probe → claim → model → validate (one
// repair) → budget → persist. Moved verbatim from run.ts; error mapping and
// stage sequencing unchanged. External outcome is untouched here.
import {
	agentFindings,
	agentRuns,
	withTx,
	type Db,
} from "@credit/db/research";
import { signInternalHeaders, type Logger } from "@credit/service-kit";
import { eq, sql } from "drizzle-orm";
import { projectCostUsd } from "./agent.js";
import { auditResearch } from "./access.js";
import {
	ContextTimeoutError,
	ContextUnavailableError,
	type ContextAgentRunner,
} from "./context-agent.js";
import { ContextToolError } from "./context-tools.js";
import {
	CONTEXT_PROMPT_VERSION,
	CONTEXT_VALIDATOR_VERSION,
	validateContextOutput,
} from "./context-validator.js";
import type { ResearchEnv } from "./env.js";
import {
	claimContextStage,
	getRun,
	heartbeatContextStage,
	initContextStage,
	persistContextFailure,
	persistContextSuccess,
	skipContextStage,
	StaleRunError,
} from "./lifecycle.js";
import type { Observability } from "./observability.js";
import { asOfDate } from "./validator.js";

export class ContextValidationFailure extends Error {}
export class CostExceededError extends Error {}

/**
 * Fresh context-consent probe over the signed service route (fail closed:
 * any error or non-true value means no consent — the stage skips, external
 * research is unaffected). Never written into caseFacts (strict schema).
 */
export async function fetchContextConsentOverHttp(
	env: ResearchEnv,
	applicationId: string,
): Promise<boolean> {
	const path = `/internal/applications/${applicationId}/research-context`;
	const headers = signInternalHeaders(env.internalSecret, {
		userId: env.autoTriggerServiceUserId,
		role: "service",
		email: env.autoTriggerServiceEmail,
		method: "GET",
		path,
	});
	try {
		const res = await fetch(`${env.applicationsUrl}${path}`, {
			headers,
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) return false;
		const body = (await res.json()) as { contextAnalysisConsent?: unknown };
		return body?.contextAnalysisConsent === true;
	} catch {
		return false;
	}
}

/**
 * Shared context-consent probe: the test seam when set, otherwise the
 * signed HMAC read. Fail closed: a throwing probe reads as no consent —
 * the stage skips/fails while external research is unaffected.
 */
export function contextConsentProbe(
	deps: Pick<ContextExecDeps, "fetchContextConsent">,
	env: ResearchEnv,
	onError?: (err: unknown) => void,
): (applicationId: string) => Promise<boolean> {
	const probe = deps.fetchContextConsent ?? ((id: string) => fetchContextConsentOverHttp(env, id));
	return async (applicationId: string) => {
		try {
			return await probe(applicationId);
		} catch (err) {
			onError?.(err);
			return false;
		}
	};
}

/** Narrow deps for the context stage: no external agent/judge/repair. */
export interface ContextExecDeps {
	db: Db;
	env: ResearchEnv;
	logger: Logger;
	observability: Observability;
	/** Test seam: fresh consent probe; default reads research-context over HMAC. */
	fetchContextConsent?: (applicationId: string) => Promise<boolean>;
	/** Optional: absent fails the context stage closed (never the external brief). */
	contextRunner?: ContextAgentRunner;
}

export interface StageResult {
	status: "succeeded" | "failed" | "skipped" | "not_applicable";
	inputTokens: number;
	outputTokens: number;
	toolCalls: number;
	costUsd: number;
	attempted: boolean;
}

export const ZERO_STAGE: StageResult = {
	status: "not_applicable",
	inputTokens: 0,
	outputTokens: 0,
	toolCalls: 0,
	costUsd: 0,
	attempted: false,
};

/** Structured validated claims for the context tool — never raw web text. */
export function externalSummaryOf(input: {
	brief: unknown;
	findings: Array<{ claim: string; category: string; confidence: string }>;
}): unknown {
	const brief = input.brief as { summary?: unknown };
	return {
		summary: typeof brief.summary === "string" ? brief.summary : null,
		findings: input.findings.map((f) => ({
			claim: f.claim,
			category: f.category,
			confidence: f.confidence,
		})),
	};
}

export function mapContextError(err: unknown): string {
	if (err instanceof ContextTimeoutError) return "timeout";
	if (err instanceof ContextValidationFailure) return "validation_failed";
	if (err instanceof CostExceededError) return "cost_exceeded";
	if (err instanceof ContextToolError) return "tool_error";
	if (err instanceof ContextUnavailableError) {
		return /not configured/i.test(err.message) ? "config_error" : "model_unavailable";
	}
	return "internal_error";
}

/**
 * T18 context stage (§3.5): consent probe → claim → model → validate (one
 * repair) → budget → persist. Initial path passes `runToken`; the retry
 * path passes a pre-claimed `stageToken` and never re-runs external work.
 * External outcome is untouched either way; the run status is never set
 * here. Throws StaleRunError when the run was reaped mid-stage.
 */
export async function runContextStage(
	deps: ContextExecDeps,
	opts: {
		runId: string;
		applicationId: string;
		caseFacts: Record<string, unknown>;
		asOfDate: string;
		runToken?: string;
		stageToken?: string;
		externalSummary: unknown;
	},
): Promise<StageResult> {
	const { db, env } = deps;
	const { runId, applicationId } = opts;
	if (!env.agentsEnabled || !env.contextEnabled) {
		const status = !env.agentsEnabled && env.contextEnabled ? "skipped" : "not_applicable";
		if (opts.runToken) {
			await initContextStage(db, env, runId, opts.runToken, status);
		} else if (opts.stageToken) {
			await persistContextFailure(db, runId, opts.stageToken, "config_error");
		}
		return { ...ZERO_STAGE, status };
	}
	// Initial path: mark the stage queued before the consent probe so the
	// claim below (running + token + queued) can succeed. A miss means the
	// run was reaped between external persist and stage start.
	if (opts.runToken && !opts.stageToken) {
		const queued = await initContextStage(db, env, runId, opts.runToken, "queued");
		if (!queued) throw new StaleRunError();
	}
	// Fresh consent probe: withdrawal blocks new context work. Probe
	// failure fails closed to skip — external research is unaffected.
	const consent = await contextConsentProbe(deps, env, (err) =>
		deps.logger.error(
			{ runId, err: err instanceof Error ? err.message : String(err) },
			"context consent probe failed",
		),
	)(applicationId);
	if (!consent) {
		if (opts.runToken) await skipContextStage(db, runId, opts.runToken);
		if (opts.stageToken) {
			await persistContextFailure(db, runId, opts.stageToken, "consent_required");
			await auditResearch(db, {
				applicationId,
				runId,
				actorId: env.autoTriggerServiceUserId,
				actorRole: "service",
				action: "context.failed",
				metadata: { code: "consent_required" },
			});
		}
		return { ...ZERO_STAGE, status: "skipped" };
	}
	let stageToken = opts.stageToken ?? null;
	if (!stageToken) {
		if (!opts.runToken) throw new Error("runContextStage needs a run or stage token");
		stageToken = await claimContextStage(db, env, runId, opts.runToken, {
			promptVersion: CONTEXT_PROMPT_VERSION,
			model: env.contextModel,
		});
		if (!stageToken) throw new StaleRunError();
	}
	const token: string = stageToken;
	const beat = setInterval(() => {
		void (async () => {
			try {
				await heartbeatContextStage(db, runId, token);
			} catch {
				// Best-effort; the stage reaper owns staleness.
			}
		})();
	}, 15_000);
	const stageStart = Date.now();
	let inputTokens = 0;
	let outputTokens = 0;
	let toolCalls = 0;
	try {
		if (!deps.contextRunner) {
			throw new ContextUnavailableError("context runner is not configured");
		}
		// Separate stage deadline: it never aborts the finalized external stage.
		const signal = AbortSignal.timeout(env.contextTimeoutMs);
		const base = {
			applicationId,
			caseFacts: opts.caseFacts,
			asOfDate: opts.asOfDate,
			externalSummary: opts.externalSummary,
			signal,
			runId,
			observability: deps.observability,
		};
		const raw = await deps.contextRunner.runContext(base);
		inputTokens = raw.usage.inputTokens;
		outputTokens = raw.usage.outputTokens;
		toolCalls = raw.usage.toolCalls;
		// Server-authored gaps for preflight screens that failed: the
		// officer sees the screen name regardless of model prose. No PII —
		// tool names and sanitized reasons only.
		const preflightFailures = raw.toolFailures ?? [];
		if (preflightFailures.length > 0) {
			// Reasons are sanitized at collection (tool name + short error
			// class, no PII/args) — logged once here for diagnosis. The
			// officer-facing gap below carries the tool name only.
			deps.logger.warn(
				{
					runId,
					failures: preflightFailures.map((f) => ({ tool: f.tool, reason: f.reason })),
				},
				"context preflight screens unavailable",
			);
		}
		const preflightGaps = preflightFailures.map((f) => `Context screen unavailable: ${f.tool}`);
		// The model hit its tool-invocation cap mid-loop: record it once and
		// tell the officer the review stopped early, never complete-looking.
		if (raw.modelBudgetExceeded) {
			deps.logger.warn({ runId }, "context model hit the tool-call limit");
			preflightGaps.push("Context investigation stopped at the tool-call limit.");
		}
		let validation = validateContextOutput({
			output: raw.output,
			snapshots: raw.snapshots,
			seenEvidence: raw.seenEvidence,
			asOfDate: opts.asOfDate,
			historyMonths: env.contextHistoryMonths,
		});
		if (!validation.ok) {
			deps.logger.warn(
				{ runId, issues: validation.issues, dropped: validation.dropped },
				"context validation failed; attempting repair",
			);
			try {
				const repaired = await deps.contextRunner.repairContext({
					...base,
					previous: raw.output,
					issues: validation.issues,
					snapshots: raw.snapshots,
					seenEvidence: raw.seenEvidence,
				});
				inputTokens += repaired.usage.inputTokens;
				outputTokens += repaired.usage.outputTokens;
				validation = validateContextOutput({
					output: repaired.output,
					snapshots: raw.snapshots,
					seenEvidence: raw.seenEvidence,
					asOfDate: opts.asOfDate,
					historyMonths: env.contextHistoryMonths,
				});
			} catch {
				if (signal.aborted) throw new ContextTimeoutError("context stage timed out");
				throw new ContextValidationFailure(validation.issues.join("; "));
			}
		}
		if (!validation.ok) {
			deps.logger.warn(
				{ runId, issues: validation.issues, dropped: validation.dropped },
				"context validation still failed after repair",
			);
			throw new ContextValidationFailure(validation.issues.join("; "));
		}
		// Separate stage budget: overage fails context only, never the brief.
		const costUsd = projectCostUsd(inputTokens, outputTokens);
		if (costUsd > env.contextMaxCostUsd)
			throw new CostExceededError(`context projected $${costUsd}`);
		// Live consent recheck before persisting: a withdrawal racing the
		// model call must not land stored context. Fail the stage closed
		// (consent_required) instead of persisting; the external outcome is
		// untouched. The same value gates inside the persist transaction.
		const persistConsent = await contextConsentProbe(deps, env, (err) =>
			deps.logger.error(
				{ runId, err: err instanceof Error ? err.message : String(err) },
				"context persist consent recheck failed",
			),
		)(applicationId);
		if (!persistConsent) {
			const measured = projectCostUsd(inputTokens, outputTokens);
			await persistContextFailure(db, runId, token, "consent_required", {
				inputTokens,
				outputTokens,
				toolCalls,
				costUsd: measured,
				durationMs: Date.now() - stageStart,
			});
			await auditResearch(db, {
				applicationId,
				runId,
				actorId: env.autoTriggerServiceUserId,
				actorRole: "service",
				action: "context.failed",
				metadata: { code: "consent_required" },
			});
			deps.logger.error({ runId, code: "consent_required" }, "context stage failed");
			return { status: "failed", inputTokens, outputTokens, toolCalls, costUsd, attempted: true };
		}
		const persisted = await persistContextSuccess(
			db,
			runId,
			token,
			{
				brief: {
					summary: validation.summary,
					claims: validation.claims,
					dataGaps: [...preflightGaps, ...validation.dataGaps],
					limitations: validation.limitations,
				},
				validation: {
					validatorVersion: CONTEXT_VALIDATOR_VERSION,
					dropped: validation.dropped,
					signalCount: validation.signals.length,
					claimCount: validation.claims.length,
				},
				usage: {
					inputTokens,
					outputTokens,
					toolCalls,
					costUsd,
					durationMs: Date.now() - stageStart,
					model: raw.model,
				},
				signals: validation.signals,
			},
			{ consent: persistConsent },
		);
		if (!persisted) {
			// The stage can be invalidated after the consent probe but before
			// the transaction: a purge/reaper clears the token and marks the
			// context skipped/failed while the run still owns finalization.
			// That must not strand a valid external brief as StaleRunError.
			// Only a token handover to another live stage is whole-run stale.
			const live = await getRun(db, runId);
			if (!live || live.status !== "running") throw new StaleRunError();
			if (live.contextStatus === "skipped") return { ...ZERO_STAGE, status: "skipped" };
			if (live.contextStatus === "failed")
				return { ...ZERO_STAGE, status: "failed", attempted: true };
			if (live.contextStatus === "succeeded") return { ...ZERO_STAGE, status: "succeeded" };
			throw new StaleRunError();
		}
		await auditResearch(db, {
			applicationId,
			runId,
			actorId: env.autoTriggerServiceUserId,
			actorRole: "service",
			action: "context.completed",
		});
		return { status: "succeeded", inputTokens, outputTokens, toolCalls, costUsd, attempted: true };
	} catch (err) {
		if (err instanceof StaleRunError) throw err;
		const code = mapContextError(err);
		// Attempted work counts even in failure (floor when unmeasured).
		const measured = projectCostUsd(inputTokens, outputTokens);
		const costUsd = inputTokens + outputTokens === 0 ? env.contextMaxCostUsd : measured;
		await persistContextFailure(db, runId, token, code, {
			inputTokens,
			outputTokens,
			toolCalls,
			costUsd,
			durationMs: Date.now() - stageStart,
		});
		await auditResearch(db, {
			applicationId,
			runId,
			actorId: env.autoTriggerServiceUserId,
			actorRole: "service",
			action: "context.failed",
			metadata: { code },
		});
		deps.logger.error(
			{ runId, code, err: err instanceof Error ? err.message : String(err) },
			"context stage failed",
		);
		return { status: "failed", inputTokens, outputTokens, toolCalls, costUsd, attempted: true };
	} finally {
		clearInterval(beat);
	}
}

/**
 * Retry execution for a claimed retry stage: no external rerun, usage
 * merged into the single ledger, run status untouched.
 */
export async function executeContextRetry(
	deps: ContextExecDeps,
	runId: string,
	stageToken: string,
): Promise<void> {
	const { db } = deps;
	const run = await getRun(db, runId);
	if (!run || run.contextStatus !== "running" || run.contextStageToken !== stageToken) return;
	let externalSummary: unknown = null;
	if (run.status === "succeeded" && run.brief) {
		const findings = await db.select().from(agentFindings).where(eq(agentFindings.runId, runId));
		externalSummary = externalSummaryOf({ brief: run.brief, findings });
	}
	const asOf = asOfDate(run.asOf.toISOString());
	const result = await runContextStage(deps, {
		runId,
		stageToken,
		applicationId: run.applicationId,
		caseFacts: run.caseFacts as Record<string, unknown>,
		asOfDate: asOf,
		externalSummary,
	});
	if (!result.attempted) return;
	// Merge retry spend into the single usage ledger; nothing else changes.
	await withTx(db, async (tx) => {
		const rows = (await tx.execute(
			sql`SELECT usage FROM agent_runs WHERE id = ${runId} FOR UPDATE`,
		)) as unknown as Array<{ usage: Record<string, number> | null }>;
		const prev = (rows[0]?.usage ?? {}) as Record<string, number>;
		const num = (v: unknown): number => (typeof v === "number" ? v : 0);
		await tx
			.update(agentRuns)
			.set({
				usage: {
					...prev,
					inputTokens: num(prev["inputTokens"]) + result.inputTokens,
					outputTokens: num(prev["outputTokens"]) + result.outputTokens,
					toolCalls: num(prev["toolCalls"]) + result.toolCalls,
					costUsd: num(prev["costUsd"]) + result.costUsd,
				},
			})
			.where(eq(agentRuns.id, runId));
	});
}
