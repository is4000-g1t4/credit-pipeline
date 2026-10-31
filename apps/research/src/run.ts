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
import { type Logger } from "@credit/service-kit";
import { and, eq, sql } from "drizzle-orm";
import {
	AgentTimeoutError,
	ModelUnavailableError,
	projectCostUsd,
	type AgentResult,
	type AgentRunner,
	PROMPT_VERSION,
	type PromptCaseFacts,
	type LanguageRepair,
	type RepairUsage,
	type JudgeUsage,
	type SupportJudge,
	TavilyError,
	type QueryEntity,
	asOfDate,
	type CaseEntity,
	validateAndBuild,
	ValidationFailure,
	VALIDATOR_VERSION,
	type ProcessedEvidence,
	type ValidatedFinding,
} from "./agents/case-brief/index.js";
import type { ContextAgentRunner } from "./agents/context-analyst/index.js";
import type { CaseFacts } from "@credit/core";
import type { ResearchEnv } from "./env.js";
import {
	runPolicyStage,
	type PolicyExecResult,
	type PolicyRunner,
} from "./agents/policy-review/index.js";
import {
	claimRun,
	finalizeFailure,
	getRun,
	heartbeatRun,
	persistContextFailure,
	StaleRunError,
	type RunErrorCode,
} from "./lifecycle.js";
import type { Observability } from "./observability.js";
import {
	contextConsentProbe,
	externalSummaryOf,
	runContextStage,
	CostExceededError,
	ZERO_STAGE,
	type StageResult,
} from "./context-stage.js";

// eval/brief-eval.ts imports these from run.js; the implementation moved.
export { validateAndBuild, VALIDATOR_VERSION };

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
					fetchConsent: contextConsentProbe(deps, env),
				},
				{
					runId,
					runToken: token,
					applicationId: run.applicationId,
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
