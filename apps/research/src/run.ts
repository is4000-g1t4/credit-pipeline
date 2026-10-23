// Background execution (§4, §6.4): claim → agent → blocking validation →
// conditional finalize. Never renders unverified findings: unsupported
// findings are discarded before persistence, and a stale token aborts with
// zero evidence/finding writes.
import {
	agentEvidence,
	agentFindings,
	agentRuns,
	findingEvidence,
	withTx,
	type Db,
} from "@credit/db/research";
import { type Logger, signInternalHeaders } from "@credit/service-kit";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
	AgentTimeoutError,
	ModelUnavailableError,
	projectCostUsd,
	type AgentResult,
	type AgentRunner,
	type FetchedEvidence,
} from "./agent.js";
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
import type { CaseFacts } from "@credit/core";
import type { ResearchEnv } from "./env.js";
import { runPolicyStage, type PolicyExecResult } from "./policy-exec.js";
import type { PolicyRunner } from "./policy-stage.js";
import {
	claimContextStage,
	claimRun,
	finalizeFailure,
	getRun,
	heartbeatContextStage,
	heartbeatRun,
	initContextStage,
	persistContextFailure,
	persistContextSuccess,
	skipContextStage,
	StaleRunError,
	type RunErrorCode,
} from "./lifecycle.js";
import type { Observability } from "./observability.js";
import { PROMPT_VERSION, type PromptCaseFacts } from "./prompt.js";
import { RepairRejectedError, type LanguageRepair, type RepairUsage } from "./repair.js";
import {
	countsTowardTwoSourceRule,
	isIndependent,
	registrableDomain,
	tierForHost,
	type SourceTier,
} from "./sources.js";
import { judgeWithRepair, type JudgeUsage, type SupportJudge } from "./support.js";
import { TavilyError, type QueryEntity } from "./tavily.js";
import { validateFinalUrl } from "./urls.js";
import {
	asOfDate,
	assessEntityMatch,
	buildSnapshot,
	decideConfidence,
	modelBriefSchema,
	piiExceptionApplies,
	resolvePublishedDate,
	scanForbidden,
	scanProtected,
	sha256Hex,
	verifyQuote,
	type CaseEntity,
	type Confidence,
	type ModelBrief,
	type ValidationScores,
} from "./validator.js";

export class ValidationFailure extends Error {}
export class ContextValidationFailure extends Error {}
export class CostExceededError extends Error {}

/** Max judge pairs per finding; over-limit candidates are skipped with an
 * explicit reason (no silent global discard). Bounds total judge work. */
const PER_FINDING_PAIR_CAP = 8;
const VALIDATOR_VERSION = "v1";

export interface ExecDeps {
	db: Db;
	env: ResearchEnv;
	logger: Logger;
	runner: AgentRunner;
	judge: SupportJudge;
	repair: LanguageRepair;
	observability: Observability;
	/** Optional: absent fails the context stage closed (never the external brief). */
	contextRunner?: ContextAgentRunner;
	/** Test seam: fresh consent probe; default reads research-context over HMAC. */
	fetchContextConsent?: (applicationId: string) => Promise<boolean>;
	/** T03/T04 case policy review; absent fails the policy stage only. */
	policyRunner?: PolicyRunner;
}

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

interface ProcessedEvidence {
	localId: string;
	id: string;
	url: string;
	finalUrl: string;
	host: string;
	title: string | null;
	publisher: string;
	publishedAt: string | null;
	dateBasis: "publisher_metadata" | "tavily_estimate" | "unknown";
	quote: string;
	quoteStart: number;
	quoteEnd: number;
	snapshotText: string;
	snapshotHash: string;
	rawContentSha256: string;
	sourceTier: SourceTier;
}

export async function executeRun(deps: ExecDeps, runId: string, token: string): Promise<void> {
	const { db, env } = deps;
	// AGENTS_ENABLED=false gates both LLM stages at execution: fail closed
	// with the context stage skipped (or not_applicable when T18 is off).
	// No model calls, no budget consumed.
	if (!env.agentsEnabled) {
		if (!(await claimRun(db, runId, token))) return;
		deps.logger.error({ runId, code: "config_error" }, "research run failed");
		await db
			.update(agentRuns)
			.set({
				status: "failed",
				errorCode: "config_error",
				error: "research is disabled",
				observability: deps.observability.status,
				contextStatus: env.contextEnabled ? "skipped" : "not_applicable",
				usage: {},
				finishedAt: new Date(),
				runToken: null,
			})
			.where(
				and(
					eq(agentRuns.id, runId),
					eq(agentRuns.status, "running"),
					eq(agentRuns.runToken, token),
				),
			);
		return;
	}
	// Every failure path below finalizes the run: claim, fetch, agent,
	// judge, stage, and finalize errors all land in `catch`, so the
	// fire-and-forget caller in routes.ts never sees an unhandled rejection.
	let timer: ReturnType<typeof setInterval> | undefined;
	const startedAt = Date.now();
	// Partial spend accumulated for the failure row: failed runs keep
	// counting toward the auto daily budget (success rows use checkBudget's
	// totals instead — these counters only feed the catch below).
	let agentIn = 0;
	let agentOut = 0;
	let agentTools = 0;
	let agentSearches = 0;
	let agentExtracts = 0;
	let judgeIn = 0;
	let judgeOut = 0;
	let judgeCalls = 0;
	let repairIn = 0;
	let repairOut = 0;
	let repairCalls = 0;
	let contextResult: StageResult = ZERO_STAGE;
	let policyResult: PolicyExecResult = {
		status: "not_applicable",
		inputTokens: 0,
		outputTokens: 0,
		costUsd: 0,
		brief: null,
		validation: null,
		usage: null,
		attempted: false,
	};
	// Counting pass-throughs: validateAndBuild keeps its own error mapping
	// and budget totals; these only observe, never alter behavior.
	const countingJudge: SupportJudge = async (claim, quote, opts) => {
		judgeCalls += 1;
		const judgment = await deps.judge(claim, quote, opts);
		judgeIn += judgment.usage?.inputTokens ?? Math.ceil((claim.length + quote.length) / 4);
		judgeOut += judgment.usage?.outputTokens ?? 0;
		return judgment;
	};
	const countingRepair: LanguageRepair = async (brief, opts) => {
		repairCalls += 1;
		const out = await deps.repair(brief, opts);
		repairIn += out.usage?.inputTokens ?? Math.ceil(JSON.stringify(brief).length / 4);
		repairOut += out.usage?.outputTokens ?? 0;
		return out;
	};
	try {
		if (!(await claimRun(db, runId, token))) return;
		timer = setInterval(() => {
			void (async () => {
				try {
					await heartbeatRun(db, runId, token);
				} catch {
					// Heartbeats are best-effort; the reaper owns staleness.
				}
			})();
		}, 15_000);
		const run = await getRun(db, runId);
		if (!run || run.id !== runId) throw new ValidationFailure("run row missing after claim");
		const facts = readStoredFacts(run.caseFacts);
		const asOf = asOfDate(run.asOf.toISOString());
		const obs = deps.observability;
		// EXTERNAL stage: validated brief/evidence/findings persist before
		// context starts; an external failure is caught and retained — the
		// context stage still runs while the row is `running`.
		let external: ExternalOutcome;
		// One deadline signal for the agent and the judge: abort ends both.
		const signal = AbortSignal.timeout(env.timeoutMs);
		try {
			const result = await deps.runner.runBrief({
				caseFacts: facts.prompt,
				entity: facts.entity,
				asOfDate: asOf,
				signal,
				hooksFor: (runner) =>
					obs.hooksFor(runner, {
						runId,
						asOf: run.asOf.toISOString(),
						promptVersion: PROMPT_VERSION,
						model: run.model,
					}),
				observability: obs,
				runId,
			});
			agentIn = result.usage.inputTokens;
			agentOut = result.usage.outputTokens;
			agentTools = result.usage.toolCalls;
			agentSearches = result.usage.searches;
			agentExtracts = result.usage.extracts;
			if (agentIn + agentOut === 0) {
				// Same backstop checkBudget applies on success: chars/4.
				agentIn = Math.ceil(
					(JSON.stringify(result.brief).length +
						result.fetched.reduce((n, f) => n + f.rawContent.length, 0)) /
						4,
				);
			}
			const validated = await validateAndBuild({
				brief: result.brief,
				fetched: result.fetched,
				entity: facts.caseEntity,
				asOf,
				judge: countingJudge,
				repair: countingRepair,
				signal,
				runId,
			});
			const usage = checkBudget(env, result, validated.judgeUsage, validated.repairUsage);
			await persistExternalSuccess(db, runId, token, {
				brief: validated.brief,
				validation: validated.validation,
				evidence: validated.evidence,
				findings: validated.findings,
				links: validated.links,
			});
			external = { ok: true as const, usage, brief: validated.brief, findings: validated.findings };
		} catch (err) {
			if (err instanceof StaleRunError) throw err;
			const [code, message] = mapError(err);
			await persistExternalFailure(db, runId, token, code, message);
			external = { ok: false as const, code, message };
		}
		// CONTEXT stage: independent of the external outcome. External
		// failure is retained; context failure never discards a valid
		// external brief. Finalization below follows the external result.
		try {
			contextResult = await runContextStage(deps, {
				runId,
				runToken: token,
				applicationId: run.applicationId,
				applicantUserId: run.applicantUserId,
				caseFacts: run.caseFacts as Record<string, unknown>,
				asOfDate: asOf,
				externalSummary: external.ok ? externalSummaryOf(external) : null,
			});
		} catch (err) {
			// Reaped mid-stage: the run is already terminal (the reaper or
			// a retry owns it now) — nothing left to finalize.
			if (err instanceof StaleRunError) return;
			// Unexpected stage error (DB/auth/audit blew up outside the
			// stage's own fail-closed paths): fail the stage best-effort and
			// finalize from the external outcome only. A valid external
			// brief must never flip to failed because context errored.
			deps.logger.error(
				{ runId, err: err instanceof Error ? err.message : String(err) },
				"context stage errored unexpectedly",
			);
			try {
				const live = await getRun(db, runId);
				if (live && live.contextStatus === "running" && live.contextStageToken) {
					await persistContextFailure(db, runId, live.contextStageToken, "internal_error");
				}
			} catch {
				// Best-effort: the stage reaper fails stuck stages on lease
				// expiry. Finalization below still follows external only.
			}
			contextResult = { ...ZERO_STAGE, status: "failed", attempted: true };
		}
		// POLICY stage: independent of the external outcome, after context.
		// It extends the lease before the synchronous call; a policy failure
		// is visible but never rewrites external/context results.
		try {
			policyResult = await runPolicyStage(
				{
					db,
					env,
					logger: deps.logger,
					policyRunner: deps.policyRunner,
					fetchConsent:
						deps.fetchContextConsent ?? ((id: string) => fetchContextConsentOverHttp(env, id)),
				},
				{
					runId,
					runToken: token,
					applicationId: run.applicationId,
					applicantUserId: run.applicantUserId,
					requestedBy: run.requestedBy,
					requestedByRole: run.requestedByRole,
					caseFacts: run.caseFacts as unknown as CaseFacts,
					asOfDate: asOf,
					documentFindings: run.contextDocumentFindings,
				},
			);
		} catch (err) {
			if (err instanceof StaleRunError) return;
			deps.logger.error(
				{ runId, err: err instanceof Error ? err.message : String(err) },
				"policy stage errored unexpectedly",
			);
			policyResult = {
				status: "failed",
				inputTokens: 0,
				outputTokens: 0,
				costUsd: 0,
				brief: null,
				validation: null,
				usage: null,
				attempted: true,
			};
		}
		if (external.ok) {
			const usage = {
				inputTokens:
					external.usage.inputTokens + contextResult.inputTokens + policyResult.inputTokens,
				outputTokens:
					external.usage.outputTokens + contextResult.outputTokens + policyResult.outputTokens,
				toolCalls: external.usage.toolCalls + contextResult.toolCalls,
				searches: external.usage.searches,
				extracts: external.usage.extracts,
				judgeCalls: external.usage.judgeCalls,
				repairCalls: external.usage.repairCalls,
				// Single ledger: external + context + policy spend. Stage
				// detail stays in context_usage/policy_usage.
				costUsd: external.usage.costUsd + contextResult.costUsd + policyResult.costUsd,
				durationMs: Date.now() - startedAt,
			};
			await finalizeRunSuccess(db, runId, token, { usage, observability: obs.status });
		} else {
			deps.logger.error(
				{ runId, code: external.code, err: external.message },
				"research run failed",
			);
			await finalizeFailure(
				db,
				runId,
				token,
				external.code,
				external.message,
				deps.observability.status,
				mergeFailureUsage(
					env,
					{
						inputTokens: agentIn + judgeIn + repairIn,
						outputTokens: agentOut + judgeOut + repairOut,
						toolCalls: agentTools + judgeCalls,
						searches: agentSearches,
						extracts: agentExtracts,
						judgeCalls,
						repairCalls,
						durationMs: Date.now() - startedAt,
					},
					contextResult,
					policyResult,
				),
			).catch((finalizeErr: unknown) => {
				deps.logger.error(
					{
						runId,
						err: finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr),
					},
					"research finalize failed",
				);
			});
		}
	} catch (err) {
		if (err instanceof StaleRunError) return;
		const [code, message] = mapError(err);
		// The failure row carries the real observability status, not the
		// insert default: Grafana hooks ran before the failure. The log
		// carries the sanitized code/message only — never case content.
		// Partial spend persists with the failure so the auto daily budget
		// counts failed work instead of reading it as free.
		deps.logger.error({ runId, code, err: message }, "research run failed");
		const inputTokens = agentIn + judgeIn + repairIn;
		const outputTokens = agentOut + judgeOut + repairOut;
		// Runner-thrown before any usage (timeout/model error): persist a
		// conservative floor so the auto daily budget counts the failed
		// work. Post-agent failures already carry real tokens — keep them.
		const measured = projectCostUsd(inputTokens, outputTokens);
		const costUsd = inputTokens + outputTokens === 0 ? env.maxCostUsd : measured;
		await finalizeFailure(db, runId, token, code, message, deps.observability.status, {
			inputTokens: inputTokens + contextResult.inputTokens + policyResult.inputTokens,
			outputTokens: outputTokens + contextResult.outputTokens + policyResult.outputTokens,
			toolCalls: agentTools + judgeCalls + contextResult.toolCalls,
			searches: agentSearches,
			extracts: agentExtracts,
			judgeCalls,
			repairCalls,
			costUsd: costUsd + contextResult.costUsd + policyResult.costUsd,
			durationMs: Date.now() - startedAt,
		}).catch((finalizeErr: unknown) => {
			deps.logger.error(
				{
					runId,
					err: finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr),
				},
				"research finalize failed",
			);
		});
	} finally {
		if (timer !== undefined) clearInterval(timer);
	}
}

interface ExternalSuccess {
	ok: true;
	usage: {
		inputTokens: number;
		outputTokens: number;
		toolCalls: number;
		searches: number;
		extracts: number;
		judgeCalls: number;
		repairCalls: number;
		costUsd: number;
	};
	brief: Record<string, unknown>;
	findings: ValidatedFinding[];
}

interface ExternalFailure {
	ok: false;
	code: RunErrorCode;
	message: string;
}

type ExternalOutcome = ExternalSuccess | ExternalFailure;

/** Structured validated claims for the context tool — never raw web text. */
function externalSummaryOf(external: ExternalSuccess): unknown {
	const brief = external.brief as { summary?: unknown };
	return {
		summary: typeof brief.summary === "string" ? brief.summary : null,
		findings: external.findings.map((f) => ({
			claim: f.claim,
			category: f.category,
			confidence: f.confidence,
		})),
	};
}

interface FailureUsageBase {
	inputTokens: number;
	outputTokens: number;
	toolCalls: number;
	searches: number;
	extracts: number;
	judgeCalls: number;
	repairCalls: number;
	durationMs: number;
}

/** Failed-run ledger: external partial spend (with its floor) plus context. */
function mergeFailureUsage(
	env: ResearchEnv,
	base: FailureUsageBase,
	context: StageResult,
	policy: PolicyExecResult,
): Record<string, unknown> {
	const measured = projectCostUsd(base.inputTokens, base.outputTokens);
	const externalCost = base.inputTokens + base.outputTokens === 0 ? env.maxCostUsd : measured;
	return {
		...base,
		inputTokens: base.inputTokens + context.inputTokens + policy.inputTokens,
		outputTokens: base.outputTokens + context.outputTokens + policy.outputTokens,
		toolCalls: base.toolCalls + context.toolCalls,
		costUsd: externalCost + context.costUsd + policy.costUsd,
	};
}

export interface StageResult {
	status: "succeeded" | "failed" | "skipped" | "not_applicable";
	inputTokens: number;
	outputTokens: number;
	toolCalls: number;
	costUsd: number;
	attempted: boolean;
}

/** Narrow deps for the context stage: no external agent/judge/repair. */
export type ContextExecDeps = Pick<
	ExecDeps,
	"db" | "env" | "logger" | "observability" | "fetchContextConsent"
> & {
	/** Optional: absent fails the context stage closed (never the external brief). */
	contextRunner?: ContextAgentRunner;
};

const ZERO_STAGE: StageResult = {
	status: "not_applicable",
	inputTokens: 0,
	outputTokens: 0,
	toolCalls: 0,
	costUsd: 0,
	attempted: false,
};

function mapContextError(err: unknown): string {
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
		applicantUserId?: string | null;
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
	const fetchConsent =
		deps.fetchContextConsent ?? ((id: string) => fetchContextConsentOverHttp(env, id));
	let consent = false;
	try {
		consent = await fetchConsent(applicationId);
	} catch (err) {
		deps.logger.error(
			{ runId, err: err instanceof Error ? err.message : String(err) },
			"context consent probe failed",
		);
		consent = false;
	}
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
			applicantUserId: opts.applicantUserId ?? null,
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
		const probe =
			deps.fetchContextConsent ?? ((id: string) => fetchContextConsentOverHttp(env, id));
		let persistConsent = false;
		try {
			persistConsent = await probe(applicationId);
		} catch (err) {
			deps.logger.error(
				{ runId, err: err instanceof Error ? err.message : String(err) },
				"context persist consent recheck failed",
			);
			persistConsent = false;
		}
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
		const brief = run.brief as { summary?: unknown };
		externalSummary = {
			summary: typeof brief.summary === "string" ? brief.summary : null,
			findings: findings.map((f) => ({
				claim: f.claim,
				category: f.category,
				confidence: f.confidence,
			})),
		};
	}
	const asOf = asOfDate(run.asOf.toISOString());
	const result = await runContextStage(deps, {
		runId,
		stageToken,
		applicationId: run.applicationId,
		applicantUserId: run.applicantUserId,
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

function mapError(err: unknown): [RunErrorCode, string] {
	if (err instanceof AgentTimeoutError) return ["timeout", "research run timed out"];
	if (err instanceof ValidationFailure) return ["validation_failed", err.message];
	if (err instanceof CostExceededError) return ["internal_error", "research exceeded its cost cap"];
	if (err instanceof ModelUnavailableError) {
		return /not configured/i.test(err.message)
			? ["config_error", "research model is not configured"]
			: ["model_unavailable", "research model unavailable"];
	}
	if (err instanceof TavilyError) {
		return /not configured/i.test(err.message)
			? ["config_error", "research sources are not configured"]
			: ["tool_error", "research sources unavailable"];
	}
	return ["internal_error", "research failed"];
}

function checkBudget(
	env: ResearchEnv,
	result: AgentResult,
	judge: { usage: JudgeUsage; calls: number },
	repair: { usage: RepairUsage; calls: number },
): {
	inputTokens: number;
	outputTokens: number;
	toolCalls: number;
	searches: number;
	extracts: number;
	judgeCalls: number;
	repairCalls: number;
	costUsd: number;
} {
	let { inputTokens } = result.usage;
	const { outputTokens } = result.usage;
	if (inputTokens + outputTokens === 0) {
		// Backstop estimate when the runner reports no usage (chars/4).
		const chars =
			JSON.stringify(result.brief).length +
			result.fetched.reduce((n, f) => n + f.rawContent.length, 0);
		inputTokens = Math.ceil(chars / 4);
	}
	// End-to-end cap: agent cost plus accumulated judge and repair cost.
	const costUsd =
		projectCostUsd(inputTokens, outputTokens) +
		projectCostUsd(judge.usage.inputTokens, judge.usage.outputTokens) +
		projectCostUsd(repair.usage.inputTokens, repair.usage.outputTokens);
	if (costUsd > env.maxCostUsd) throw new CostExceededError(`projected $${costUsd}`);
	return {
		inputTokens: inputTokens + judge.usage.inputTokens + repair.usage.inputTokens,
		outputTokens: outputTokens + judge.usage.outputTokens + repair.usage.outputTokens,
		toolCalls: result.usage.toolCalls + judge.calls,
		searches: result.usage.searches,
		extracts: result.usage.extracts,
		judgeCalls: judge.calls,
		repairCalls: repair.calls,
		costUsd,
	};
}

interface StoredFacts {
	prompt: PromptCaseFacts;
	entity: QueryEntity;
	caseEntity: CaseEntity;
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function strNull(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}

function numNull(v: unknown): number | null {
	return typeof v === "number" ? v : null;
}

function readStoredFacts(stored: unknown): StoredFacts {
	const f = stored as Record<string, unknown>;
	const applicantName = str(f.applicantName);
	const companyName = strNull(f.companyName);
	const city = strNull(f.city);
	if (!applicantName) throw new ValidationFailure("stored case facts are incomplete");
	const name = companyName ?? applicantName;
	return {
		prompt: {
			applicantName,
			companyName,
			registrationNumber: strNull(f.registrationNumber),
			city,
			industry: strNull(f.industry),
			yearsTrading: numNull(f.yearsTrading),
			product: str(f.product),
			amountCents: typeof f.amountCents === "number" ? f.amountCents : 0,
			termMonths: typeof f.termMonths === "number" ? f.termMonths : 0,
			asOf: str(f.asOf),
		},
		entity: { name, city, registrationNumber: strNull(f.registrationNumber) },
		caseEntity: {
			kind: companyName ? "sme" : "individual",
			applicantName,
			companyName,
			registrationNumber: strNull(f.registrationNumber),
			city,
		},
	};
}

interface ValidatedFinding {
	id: string;
	claim: string;
	category: string;
	whyItMatters: string;
	allegationStatus: string;
	confidence: Confidence;
	confidenceBasis: Record<string, unknown>;
	entityMatch: { identifierType: string; value: string; confidence: Confidence };
}

interface ValidatedOutput {
	brief: Record<string, unknown>;
	validation: Record<string, unknown>;
	evidence: ProcessedEvidence[];
	findings: ValidatedFinding[];
	links: Array<{ findingId: string; evidenceId: string }>;
	judgeUsage: { usage: JudgeUsage; calls: number };
	repairUsage: { usage: RepairUsage; calls: number };
}

/** Generated text only (never exact quotes) for forbidden/PII scans. */
function generatedTexts(brief: ModelBrief): Array<[string, string]> {
	return [
		["summary", brief.summary],
		...brief.findings.flatMap((f, i): Array<[string, string]> => [
			[`findings[${i}].claim`, f.claim],
			[`findings[${i}].whyItMatters`, f.whyItMatters],
		]),
		...brief.contradictions.map((c, i): [string, string] => [
			`contradictions[${i}]`,
			c.description,
		]),
		...brief.unknowns.map((u, i): [string, string] => [`unknowns[${i}]`, u]),
		...brief.questionsForOfficer.map((q, i): [string, string] => [`questions[${i}]`, q]),
	];
}

function firstForbiddenHit(brief: ModelBrief): string | null {
	for (const [label, text] of generatedTexts(brief)) {
		if (scanForbidden(text).length > 0) return label;
	}
	return null;
}

function firstProtectedHit(brief: ModelBrief): string | null {
	for (const [label, text] of generatedTexts(brief)) {
		if (scanProtected(text).length > 0 && !piiExceptionApplies(text, [])) return label;
	}
	return null;
}

/** Dirty summary/findings need the repair pass; dirty non-findings
 * (contradictions/unknowns/questions) are droppable without it. */
function hasDirtySummaryOrFindings(brief: ModelBrief): boolean {
	return (
		scanForbidden(brief.summary).length > 0 ||
		brief.findings.some(
			(f) => scanForbidden(f.claim).length > 0 || scanForbidden(f.whyItMatters).length > 0,
		)
	);
}

/** Drop non-finding entries that still carry decision language after the
 * single repair pass. Findings/summary stay strict: dirty there still fails.
 * Returns the cleaned brief, or null when a finding/summary is dirty. */
function dropForbiddenNonFindings(brief: ModelBrief): ModelBrief | null {
	if (hasDirtySummaryOrFindings(brief)) {
		return null;
	}
	return {
		...brief,
		contradictions: brief.contradictions.filter((c) => scanForbidden(c.description).length === 0),
		unknowns: brief.unknowns.filter((u) => scanForbidden(u).length === 0),
		questionsForOfficer: brief.questionsForOfficer.filter((q) => scanForbidden(q).length === 0),
	};
}

/** The repaired brief must keep finding/evidence counts, local IDs, and links. */
function checkRepairStructure(before: ModelBrief, after: ModelBrief): void {
	const mismatch = (): ValidationFailure =>
		new ValidationFailure("language repair changed the brief structure");
	if (after.findings.length !== before.findings.length) throw mismatch();
	if (after.evidence.length !== before.evidence.length) throw mismatch();
	if (
		after.evidence.map((e) => e.localId).join("\n") !==
		before.evidence.map((e) => e.localId).join("\n")
	) {
		throw mismatch();
	}
	for (const [i, f] of after.findings.entries()) {
		if (f.evidenceLocalIds.join("\n") !== before.findings[i].evidenceLocalIds.join("\n")) {
			throw mismatch();
		}
	}
}

async function validateAndBuild(opts: {
	brief: unknown;
	fetched: FetchedEvidence[];
	entity: CaseEntity;
	asOf: string;
	judge: SupportJudge;
	repair: LanguageRepair;
	signal?: AbortSignal;
	runId: string;
}): Promise<ValidatedOutput> {
	const parsed = modelBriefSchema.safeParse(opts.brief);
	if (!parsed.success) throw new ValidationFailure("model brief failed schema validation");
	let brief: ModelBrief = parsed.data;

	// 1. Protected attributes fail immediately: rewording cannot fix a leak.
	const leaked = firstProtectedHit(brief);
	if (leaked) {
		throw new ValidationFailure(`model brief contains a protected attribute (${leaked})`);
	}

	// 2. One bounded language-repair pass for decision language, before
	// support judging. At most one model call; its usage counts toward the
	// run budget. A still-dirty or restructured reply fails safely with
	// zero persisted findings.
	let repairCalls = 0;
	let repairInputTokens = 0;
	let repairOutputTokens = 0;
	// Repair only when summary/findings carry decision language. Dirty
	// non-findings alone are dropped directly: no repair call is spent,
	// and a repair transport failure cannot fail the run for them.
	if (!hasDirtySummaryOrFindings(brief)) {
		brief = dropForbiddenNonFindings(brief) ?? brief;
	} else {
		let repaired: unknown;
		try {
			const out = await opts.repair(brief, { signal: opts.signal, runId: opts.runId });
			repaired = out.brief;
			repairInputTokens += out.usage?.inputTokens ?? Math.ceil(JSON.stringify(brief).length / 4);
			repairOutputTokens += out.usage?.outputTokens ?? 0;
			repairCalls = 1;
		} catch (err) {
			if (err instanceof RepairRejectedError) throw new ValidationFailure(err.message);
			if (opts.signal?.aborted) throw new AgentTimeoutError("language repair aborted");
			throw new ModelUnavailableError(
				err instanceof Error ? err.message : "language repair failed",
			);
		}
		const reparse = modelBriefSchema.safeParse(repaired);
		if (!reparse.success) throw new ValidationFailure("language repair failed schema validation");
		checkRepairStructure(brief, reparse.data);
		brief = reparse.data;
		const dirty = firstForbiddenHit(brief);
		if (dirty) {
			// The repair pass rewrites summary/findings only: drop dirty
			// non-finding entries instead of failing the run for a field
			// repair could not touch. Dirty summary/findings still fail.
			const cleaned = dropForbiddenNonFindings(brief);
			if (!cleaned)
				throw new ValidationFailure(`model brief contains decision language (${dirty})`);
			brief = cleaned;
			const stillDirty = firstForbiddenHit(brief);
			if (stillDirty)
				throw new ValidationFailure(`model brief contains decision language (${stillDirty})`);
		}
		const stillLeaked = firstProtectedHit(brief);
		if (stillLeaked) {
			throw new ValidationFailure(`model brief contains a protected attribute (${stillLeaked})`);
		}
	}
	// The judge is a model call: any transport failure is model_unavailable;
	// an aborted deadline is a timeout. Usage accumulates for the end-to-end
	// cost cap (estimated by chars when the judge reports none).
	let judgeInputTokens = 0;
	let judgeOutputTokens = 0;
	let judgeCalls = 0;
	const judge: SupportJudge = async (claim, quote, innerOpts) => {
		judgeCalls += 1;
		try {
			const judgment = await opts.judge(claim, quote, {
				signal: innerOpts?.signal ?? opts.signal,
				runId: innerOpts?.runId ?? opts.runId,
				repair: innerOpts?.repair,
			});
			judgeInputTokens +=
				judgment.usage?.inputTokens ?? Math.ceil((claim.length + quote.length) / 4);
			judgeOutputTokens += judgment.usage?.outputTokens ?? 0;
			return judgment;
		} catch (err) {
			if (opts.signal?.aborted) throw new AgentTimeoutError("support judge aborted");
			throw new ModelUnavailableError(err instanceof Error ? err.message : "support judge failed");
		}
	};
	// 3. Evidence: server-side snapshot, hash, offsets, dates, tiers.
	const fetchedByUrl = new Map<string, FetchedEvidence>();
	for (const f of opts.fetched) {
		fetchedByUrl.set(f.requestedUrl, f);
		fetchedByUrl.set(f.returnedUrl, f);
	}
	const processed: ProcessedEvidence[] = [];
	let droppedQuotes = 0;
	let droppedPii = 0;
	for (const ev of brief.evidence) {
		const raw = fetchedByUrl.get(ev.url);
		if (!raw) {
			droppedQuotes += 1;
			continue;
		}
		const finalUrl = raw.returnedUrl || raw.requestedUrl;
		if (
			raw.returnedUrl &&
			registrableDomain(new URL(raw.returnedUrl).hostname) !==
				registrableDomain(new URL(raw.requestedUrl).hostname)
		) {
			droppedQuotes += 1; // redirect off-allowlist
			continue;
		}
		const verdict = validateFinalUrl(finalUrl);
		if (!verdict.ok) {
			droppedQuotes += 1;
			continue;
		}
		let snap: {
			snapshotText: string;
			quoteStart: number;
			quoteEnd: number;
			snapshotHash: string;
			rawContentSha256: string;
		};
		try {
			snap = buildSnapshot(raw.rawContent, ev.quote);
		} catch {
			droppedQuotes += 1;
			continue;
		}
		if (!verifyQuote(snap.snapshotText, ev.quote, snap.quoteStart, snap.quoteEnd)) {
			droppedQuotes += 1;
			continue;
		}
		const tier = tierForHost(verdict.host);
		// Protected-attribute quotes are quarantined unless the documented
		// fraud-record exception applies (official/registry tier + fraud text).
		if (scanProtected(ev.quote).length > 0 && !piiExceptionApplies(ev.quote, [tier])) {
			droppedPii += 1;
			continue;
		}
		// The model date counts only when verified in the fetched page;
		// otherwise the Tavily estimate, otherwise undated.
		const { publishedAt, dateBasis } = resolvePublishedDate({
			modelDate: ev.publishedAt,
			rawContent: raw.rawContent,
			tavilyDate: raw.searchPublishedDate,
		});
		if (publishedAt && publishedAt > opts.asOf) {
			droppedQuotes += 1; // after asOf: reject
			continue;
		}
		processed.push({
			localId: ev.localId,
			id: randomUUID(),
			url: raw.requestedUrl,
			finalUrl: verdict.finalUrl,
			host: verdict.host,
			title: typeof ev.title === "string" && ev.title ? ev.title : null,
			publisher:
				typeof ev.publisher === "string" && ev.publisher.trim()
					? ev.publisher.trim()
					: verdict.host,
			publishedAt,
			dateBasis,
			quote: ev.quote,
			quoteStart: snap.quoteStart,
			quoteEnd: snap.quoteEnd,
			snapshotText: snap.snapshotText,
			snapshotHash: snap.snapshotHash,
			rawContentSha256: snap.rawContentSha256,
			sourceTier: tier,
		});
	}
	// Dedupe by the stored unique key: two quotes from one small page share
	// a snapshot window, and the second row would 23505 on insert. The later
	// quote is dropped with an explicit reason — never remapped to the first
	// row, so a finding always cites its exact quoted passage.
	const deduped: ProcessedEvidence[] = [];
	const rowByKey = new Map<string, ProcessedEvidence>();
	const byLocalId = new Map<string, ProcessedEvidence>();
	const droppedDuplicateLocalIds = new Set<string>();
	let dedupedQuotes = 0;
	for (const e of processed) {
		const key = `${e.finalUrl}\n${e.snapshotHash}`;
		if (rowByKey.has(key)) {
			droppedDuplicateLocalIds.add(e.localId);
			dedupedQuotes += 1;
			continue;
		}
		rowByKey.set(key, e);
		deduped.push(e);
		byLocalId.set(e.localId, e);
	}

	// 4. Findings: each judged only against its own linked evidence (the
	// model's evidenceLocalIds, or every surviving row when it cites none),
	// capped per finding with an explicit skip reason. Entity, PII, and
	// confidence derive from the *supported* evidence only — never from all
	// run evidence and never from the model's self-reported confidence.
	const findings: ValidatedOutput["findings"] = [];
	const links: ValidatedOutput["links"] = [];
	const discarded: Array<{ findingIndex: number; reason: string; claimHash: string }> = [];
	const supportLog: Array<{ findingId: string; evidenceIds: string[]; repaired: boolean }> = [];
	const findingLimitations: string[] = [];
	let unsupportedClaims = 0;
	let piiClaimDiscards = 0;
	let pairCapSkipped = 0;
	const entityScores: number[] = [];

	for (const [findingIndex, f] of brief.findings.entries()) {
		const hash = { findingIndex, claimHash: sha256Hex(f.claim) };
		if (f.entityMatch.identifierType === "name_only" && f.category === "adverse_media") {
			unsupportedClaims += 1;
			discarded.push({
				...hash,
				reason: "name_only never supports an adverse-media finding",
			});
			continue;
		}
		const linked =
			f.evidenceLocalIds.length > 0
				? f.evidenceLocalIds.flatMap((lid) => {
						const e = byLocalId.get(lid);
						return e ? [e] : [];
					})
				: [...deduped];
		const seenLink = new Set<string>();
		const candidates = linked.filter((e) => {
			if (seenLink.has(e.id)) return false;
			seenLink.add(e.id);
			return true;
		});
		if (candidates.length > PER_FINDING_PAIR_CAP) {
			pairCapSkipped += candidates.length - PER_FINDING_PAIR_CAP;
		}
		const capped = candidates.slice(0, PER_FINDING_PAIR_CAP);
		const supportedIds: string[] = [];
		let repaired = false;
		// No surviving evidence for the cited passages: the localIds were
		// hallucinated or their quotes were dropped as page duplicates above
		// — never judged against another passage's quote.
		if (capped.length === 0 && f.evidenceLocalIds.length > 0) {
			unsupportedClaims += 1;
			const allDuplicates = f.evidenceLocalIds.every((lid) => droppedDuplicateLocalIds.has(lid));
			discarded.push({
				...hash,
				reason: allDuplicates
					? "quoted passage was a duplicate of another passage from the same page and was dropped"
					: "cited evidence did not survive validation",
			});
			continue;
		}
		for (const e of capped) {
			// A verbatim claim is supported without spending a judge call; this
			// is the safest path for registry facts and keeps citations exact.
			const normalize = (v: string): string => v.replace(/\s+/g, " ").trim().toLowerCase();
			const claimText = normalize(f.claim);
			if (claimText.length >= 20 && normalize(e.quote).includes(claimText)) {
				supportedIds.push(e.id);
				continue;
			}
			// One initial verdict plus at most one repair (max 2 calls).
			const { verdict, repaired: fixed } = await judgeWithRepair(f.claim, e.quote, judge);
			if (fixed) repaired = true;
			if (verdict === "supported") supportedIds.push(e.id);
		}
		if (supportedIds.length === 0) {
			unsupportedClaims += 1;
			discarded.push({
				...hash,
				reason:
					capped.length < candidates.length
						? `no supporting quote in the first ${PER_FINDING_PAIR_CAP} linked passages (judge verdict)`
						: "no supporting quote (judge verdict)",
			});
			continue;
		}
		const cited = deduped.filter((e) => supportedIds.includes(e.id));
		if (
			scanProtected(f.claim).length > 0 &&
			!piiExceptionApplies(
				f.claim,
				cited.map((e) => e.sourceTier),
			)
		) {
			unsupportedClaims += 1;
			piiClaimDiscards += 1;
			discarded.push({
				...hash,
				reason: "protected attribute without a fraud-record exception",
			});
			continue;
		}
		const assessed = assessEntityMatch(
			opts.entity,
			{
				identifierType: f.entityMatch.identifierType,
				value: f.entityMatch.value,
				confidence: f.entityMatch.confidence,
			},
			{ officialSourceCited: cited.some((e) => e.sourceTier === "official") },
		);
		const counting = cited.filter((e) => countsTowardTwoSourceRule(e.sourceTier));
		// Greedy independent set: an item counts only when independent of
		// every counted item (domain + hash + no syndication marker).
		const counted: ProcessedEvidence[] = [];
		for (const e of counting) {
			if (counted.every((c) => isIndependent(c, e))) counted.push(e);
		}
		const independentCount = counted.length;
		const decided = decideConfidence({
			category: f.category,
			independentCount,
			hasOfficial: cited.some((e) => e.sourceTier === "official"),
			reviewPlatformOnly:
				cited.length > 0 && cited.every((e) => e.sourceTier === "review_platform"),
			undatedNews: cited.some(
				(e) =>
					e.publishedAt === null &&
					(e.sourceTier === "reputable_news" ||
						e.sourceTier === "review_platform" ||
						e.sourceTier === "other"),
			),
			entityConfidence: assessed.confidence,
		});
		const id = randomUUID();
		const scoreOf: Record<Confidence, number> = { low: 0, medium: 0.5, high: 1 };
		entityScores.push(scoreOf[assessed.confidence]);
		for (const limitation of [...assessed.reasons, ...decided.limitations]) {
			findingLimitations.push(`finding #${findingIndex + 1}: ${limitation}`);
		}
		findings.push({
			id,
			claim: f.claim,
			category: f.category,
			whyItMatters: f.whyItMatters,
			allegationStatus: f.allegationStatus,
			confidence: decided.confidence,
			confidenceBasis: {
				...decided.basis,
				limitations: decided.limitations,
				entityMatch: {
					identifierType: assessed.identifierType,
					confidence: assessed.confidence,
					reasons: assessed.reasons,
				},
				entityMatchCapped: assessed.capped,
			},
			entityMatch: {
				identifierType: assessed.identifierType,
				value: assessed.value,
				confidence: assessed.confidence,
			},
		});
		for (const eid of supportedIds) links.push({ findingId: id, evidenceId: eid });
		supportLog.push({ findingId: id, evidenceIds: supportedIds, repaired });
	}

	// 5. Contradictions keep only resolvable refs; limitation notes join unknowns.
	const contradictions = brief.contradictions.flatMap((c) => {
		const ids = c.evidenceLocalIds.flatMap((lid) => {
			const e = byLocalId.get(lid);
			return e ? [e.id] : [];
		});
		return ids.length > 0 ? [{ description: c.description, evidenceIds: ids }] : [];
	});
	const limitationNotes =
		findings.length > 0 ? [] : ["no supported findings remained after validation"];
	const unknowns = [...brief.unknowns, ...findingLimitations, ...limitationNotes];

	const totalFindings = brief.findings.length;
	const scores: ValidationScores = {
		citation_valid: brief.evidence.length === 0 ? 1 : deduped.length / brief.evidence.length,
		evidence_coverage: totalFindings === 0 ? 1 : findings.length / totalFindings,
		unsupported_claims: unsupportedClaims,
		entity_match_confidence:
			entityScores.length === 0 ? 0 : entityScores.reduce((a, b) => a + b, 0) / entityScores.length,
		// Actual leak checks: PII quotes quarantined plus PII claims dropped.
		pii_leak: droppedPii + piiClaimDiscards,
		support_pass_rate: totalFindings === 0 ? 1 : findings.length / totalFindings,
	};

	return {
		brief: {
			// A fully-discarded brief must not assert unsupported claims.
			summary:
				findings.length === 0 ? "No supported findings remained after validation." : brief.summary,
			contradictions,
			unknowns,
			questionsForOfficer: brief.questionsForOfficer,
		},
		validation: {
			validatorVersion: VALIDATOR_VERSION,
			scores,
			unsupportedClaims,
			droppedQuotes,
			droppedPii,
			dedupedQuotes,
			pairCapSkipped,
			discarded,
			support: supportLog,
		},
		evidence: deduped,
		findings,
		links,
		judgeUsage: {
			usage: { inputTokens: judgeInputTokens, outputTokens: judgeOutputTokens },
			calls: judgeCalls,
		},
		repairUsage: {
			usage: { inputTokens: repairInputTokens, outputTokens: repairOutputTokens },
			calls: repairCalls,
		},
	};
}

/**
 * Persist a validated external result while the run stays `running` for the
 * context stage. Stale token (reaped mid-flight) throws StaleRunError with
 * zero writes — the outer catch returns without touching the reaped row.
 */
async function persistExternalSuccess(
	db: Db,
	runId: string,
	token: string,
	data: {
		brief: Record<string, unknown>;
		validation: Record<string, unknown>;
		evidence: ProcessedEvidence[];
		findings: ValidatedFinding[];
		links: Array<{ findingId: string; evidenceId: string }>;
	},
): Promise<void> {
	await withTx(db, async (tx) => {
		const guard = (await tx.execute(
			sql`SELECT status, run_token FROM agent_runs WHERE id = ${runId} FOR UPDATE`,
		)) as unknown as Array<{ status: string; run_token: string | null }>;
		const row = guard[0];
		if (!row || row.status !== "running" || row.run_token !== token) throw new StaleRunError();
		if (data.evidence.length > 0) {
			await tx.insert(agentEvidence).values(
				data.evidence.map((e) => ({
					id: e.id,
					runId,
					url: e.url,
					finalUrl: e.finalUrl,
					title: e.title,
					publisher: e.publisher,
					publishedAt: e.publishedAt,
					dateBasis: e.dateBasis,
					quote: e.quote,
					quoteStart: e.quoteStart,
					quoteEnd: e.quoteEnd,
					snapshotText: e.snapshotText,
					snapshotHash: e.snapshotHash,
					rawContentSha256: e.rawContentSha256,
					sourceTier: e.sourceTier,
					metadata: { localId: e.localId },
				})),
			);
		}
		if (data.findings.length > 0) {
			await tx.insert(agentFindings).values(
				data.findings.map((f) => ({
					id: f.id,
					runId,
					claim: f.claim,
					category: f.category,
					whyItMatters: f.whyItMatters,
					allegationStatus: f.allegationStatus,
					support: "verified" as const,
					confidence: f.confidence,
					confidenceBasis: f.confidenceBasis,
					entityMatch: f.entityMatch,
				})),
			);
		}
		if (data.links.length > 0) {
			await tx.insert(findingEvidence).values(data.links);
		}
		await tx
			.update(agentRuns)
			.set({
				brief: data.brief,
				validation: data.validation,
			})
			.where(eq(agentRuns.id, runId));
	});
}

/**
 * Retain an external failure (code/message) while the run stays `running`
 * for the context stage. Finalization follows the retained outcome.
 */
async function persistExternalFailure(
	db: Db,
	runId: string,
	token: string,
	code: RunErrorCode,
	message: string,
): Promise<void> {
	const rows = await db
		.update(agentRuns)
		.set({ errorCode: code, error: message })
		.where(
			and(eq(agentRuns.id, runId), eq(agentRuns.status, "running"), eq(agentRuns.runToken, token)),
		)
		.returning({ id: agentRuns.id });
	if (rows.length === 0) throw new StaleRunError();
}

/**
 * Finalize after both stages persisted: status follows the external result
 * only; context fields/signals are already stored. Stale token throws.
 */
async function finalizeRunSuccess(
	db: Db,
	runId: string,
	token: string,
	data: { usage: Record<string, unknown>; observability: "ok" | "degraded" },
): Promise<void> {
	const rows = await db
		.update(agentRuns)
		.set({
			status: "succeeded",
			usage: data.usage,
			observability: data.observability,
			finishedAt: new Date(),
			runToken: null,
		})
		.where(
			and(eq(agentRuns.id, runId), eq(agentRuns.status, "running"), eq(agentRuns.runToken, token)),
		)
		.returning({ id: agentRuns.id });
	if (rows.length === 0) throw new StaleRunError();
}
