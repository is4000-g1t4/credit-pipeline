import type { CaseFacts } from "@credit/core";
import type { Logger } from "@credit/service-kit";
import type { Db } from "@credit/db/research";
import type { ResearchEnv } from "./env.js";
import {
	beginPolicyStage,
	heartbeatPolicyStage,
	loadPolicySignals,
	persistPolicyFailure,
	persistPolicySuccess,
	skipPolicyStage,
	StaleRunError,
} from "./lifecycle.js";
import {
	buildPolicyCaseContext,
	createCaseTokenForInput,
	type PolicyCaseResponse,
	type PolicyRunner,
	type PolicyRunnerEnv,
	type PolicyStageStatus,
} from "./policy-stage.js";

export const POLICY_PROMPT_VERSION = "policy-v1";

export interface PolicyExecResult {
	status: PolicyStageStatus;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	brief: Record<string, unknown> | null;
	validation: Record<string, unknown> | null;
	usage: Record<string, unknown> | null;
	attempted: boolean;
}

export interface PolicyExecDeps {
	db: Db;
	env: ResearchEnv;
	logger: Logger;
	policyRunner?: PolicyRunner;
	/** Fresh context-consent probe (same gate as the context stage). */
	fetchConsent: (applicationId: string) => Promise<boolean>;
}

const ZERO: PolicyExecResult = {
	status: "not_applicable",
	inputTokens: 0,
	outputTokens: 0,
	costUsd: 0,
	brief: null,
	validation: null,
	usage: null,
	attempted: false,
};

function sanitizeFindings(raw: unknown): Array<{
	field: string;
	status: string;
	confidence: string;
	index: number;
}> {
	if (!Array.isArray(raw)) return [];
	const fields = new Set([
		"company_name",
		"registration_number",
		"account_holder_name",
		"applicant_name",
		"other",
	]);
	const statuses = new Set(["mismatch", "needs_chase"]);
	const confidences = new Set(["low", "medium", "high"]);
	return raw
		.filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
		.map((row, index) => ({
			field: String(row.field ?? ""),
			status: String(row.status ?? ""),
			confidence: String(row.confidence ?? "low"),
			index: Number.isInteger(row.index) ? (row.index as number) : index,
		}))
		.filter(
			(row) =>
				fields.has(row.field) &&
				statuses.has(row.status) &&
				confidences.has(row.confidence) &&
				row.index >= 0 &&
				row.index < 100,
		);
}

function errorCode(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	if (/timeout|aborted/i.test(message)) return "timeout";
	if (/token|401|403/i.test(message)) return "policy_auth_failed";
	return "policy_call_failed";
}

/**
 * Synchronous, isolated policy stage. It extends the run lease before the
 * call and heartbeats while the policy service works; a policy failure never
 * changes the external/context outcome.
 */
export async function runPolicyStage(
	deps: PolicyExecDeps,
	opts: {
		runId: string;
		runToken: string;
		applicationId: string;
		applicantUserId?: string | null;
		requestedBy: string;
		requestedByRole: "officer" | "service";
		caseFacts: CaseFacts;
		asOfDate: string;
		documentFindings?: unknown;
	},
): Promise<PolicyExecResult> {
	const { db, env, logger } = deps;
	if (!env.policyAssistEnabled) return ZERO;

	let consent = false;
	try {
		consent = await deps.fetchConsent(opts.applicationId);
	} catch (err) {
		logger.warn(
			{ runId: opts.runId, err: err instanceof Error ? err.message : String(err) },
			"policy consent probe failed",
		);
		consent = false;
	}
	if (!consent) {
		await skipPolicyStage(db, opts.runId, opts.runToken, "consent_required");
		return { ...ZERO, status: "skipped", attempted: true };
	}

	const signals = await loadPolicySignals(db, opts.runId);
	const findings = sanitizeFindings(opts.documentFindings);
	const input = {
		applicationId: opts.applicationId,
		runId: opts.runId,
		authorisingActorId: opts.requestedBy,
		authorisingActorRole: opts.requestedByRole,
		asOf: opts.asOfDate,
		caseFacts: opts.caseFacts,
		signals,
		documentFindings: findings,
	};
	let caseContext;
	try {
		caseContext = buildPolicyCaseContext(input);
	} catch (err) {
		logger.warn(
			{ runId: opts.runId, err: err instanceof Error ? err.message : String(err) },
			"policy case context validation failed",
		);
		await beginPolicyStage(db, env, opts.runId, opts.runToken, {
			model: env.agentModel,
			promptVersion: POLICY_PROMPT_VERSION,
			documentFindings: findings,
		});
		await persistPolicyFailure(db, opts.runId, opts.runToken, "failed", "validation_failed");
		return { ...ZERO, status: "failed", attempted: true };
	}

	const started = await beginPolicyStage(db, env, opts.runId, opts.runToken, {
		model: env.agentModel,
		promptVersion: POLICY_PROMPT_VERSION,
		documentFindings: findings,
	});
	if (!started) throw new StaleRunError();
	if (!deps.policyRunner) {
		await persistPolicyFailure(db, opts.runId, opts.runToken, "failed", "config_error");
		return { ...ZERO, status: "failed", attempted: true };
	}

	const beat = setInterval(() => {
		void (async () => {
			try {
				await heartbeatPolicyStage(db, opts.runId, opts.runToken);
			} catch {
				// The reaper owns staleness.
			}
		})();
	}, 15_000);
	try {
		const token = createCaseTokenForInput(env as PolicyRunnerEnv, {
			...input,
			applicationId: opts.applicationId,
			runId: opts.runId,
			authorisingActorId: opts.requestedBy,
			authorisingActorRole: opts.requestedByRole,
			asOf: opts.asOfDate,
			caseFacts: opts.caseFacts,
			signals,
			documentFindings: findings,
		});
		const response: PolicyCaseResponse = await deps.policyRunner.explainCase({
			caseContext,
			caseToken: token,
		});
		const usage: Record<string, unknown> = response.usage ?? {};
		const inputTokens = Number(response.usage?.inputTokens ?? 0);
		const outputTokens = Number(response.usage?.outputTokens ?? 0);
		const costUsd = Number(response.usage?.costUsd ?? 0);
		const brief =
			response.status === "succeeded"
				? {
						summary: response.summary ?? null,
						items: response.items.map((item) => ({
							ref: item.ref,
							explanationSegments: item.explanationSegments,
							citations: item.citations,
							confidence: item.confidence,
						})),
						limitations: response.limitations,
					}
				: null;
		const validation = {
			promptVersion: POLICY_PROMPT_VERSION,
			status: response.status,
			itemCount: response.items.length,
			citationCount: response.items.reduce((n, item) => n + item.citations.length, 0),
		};
		if (response.status === "failed") {
			await persistPolicyFailure(db, opts.runId, opts.runToken, "failed", "policy_failed", usage);
			return {
				status: "failed",
				inputTokens,
				outputTokens,
				costUsd,
				brief: null,
				validation,
				usage,
				attempted: true,
			};
		}
		if (costUsd > env.policyCaseMaxCostUsd) {
			await persistPolicyFailure(db, opts.runId, opts.runToken, "failed", "cost_exceeded", usage);
			return {
				status: "failed",
				inputTokens,
				outputTokens,
				costUsd,
				brief: null,
				validation,
				usage,
				attempted: true,
			};
		}
		await persistPolicySuccess(db, opts.runId, opts.runToken, {
			status: response.status,
			brief,
			validation,
			usage,
		});
		return {
			status: response.status,
			inputTokens,
			outputTokens,
			costUsd,
			brief,
			validation,
			usage,
			attempted: true,
		};
	} catch (err) {
		const code = errorCode(err);
		logger.error(
			{ runId: opts.runId, code, err: err instanceof Error ? err.message : String(err) },
			"policy stage failed",
		);
		await persistPolicyFailure(db, opts.runId, opts.runToken, "failed", code);
		return { ...ZERO, status: "failed", attempted: true };
	} finally {
		clearInterval(beat);
	}
}
