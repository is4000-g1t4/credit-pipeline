import { signInternalHeaders } from "@credit/service-kit";
import type { CaseFacts } from "@credit/core";
import { caseResponseSchema } from "./validator.js";
import {
	policyCaseContextSchema,
	signalRef,
	type PolicyCaseContext,
	type PolicyCaseSignal,
	signCaseToken,
} from "@credit/core";

export type PolicyStageStatus =
	| "not_applicable"
	| "running"
	| "succeeded"
	| "no_match"
	| "needs_policy_owner"
	| "budget_exceeded"
	| "failed"
	| "skipped";

export interface PolicyStageInput {
	applicationId: string;
	runId: string;
	authorisingActorId: string;
	authorisingActorRole: "officer" | "service";
	asOf: string;
	caseFacts: CaseFacts;
	signals: Array<{
		type: string;
		metric: string;
		periodStart: string;
		periodEnd: string;
		accountScope: string;
		status: "review" | "needs_chase" | "insufficient_data";
		confidence: "low" | "medium" | "high";
	}>;
	documentFindings?: Array<{
		field: string;
		status: string;
		confidence: string;
		index: number;
	}>;
}

export interface PolicyCaseResponse {
	status: "succeeded" | "no_match" | "needs_policy_owner" | "budget_exceeded" | "failed";
	summary?: string;
	items: Array<{
		ref: string;
		explanationSegments: Array<{ text: string; citationIndexes: number[] }>;
		citations: Array<{
			policyKey: string;
			policyVersionId: string;
			sectionId: string;
			heading: string;
			version: string;
			effectiveFrom: string;
			effectiveTo: string | null;
			quote: string;
			drawerToken: string;
		}>;
		confidence: "low" | "medium" | "high";
	}>;
	limitations: string[];
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		costUsd?: number;
		model?: string;
	};
}

export interface PolicyRunner {
	explainCase(input: {
		caseContext: PolicyCaseContext;
		caseToken: string;
	}): Promise<PolicyCaseResponse>;
}

export interface PolicyRunnerEnv {
	policyAssistEnabled: boolean;
	policyUrl: string;
	policyInternalSecret: string;
	policyCaseTokenSecret: string;
	policyCaseTokenTtlSeconds: number;
	policyCaseTimeoutMs: number;
	autoTriggerServiceUserId: string;
	autoTriggerServiceEmail: string;
}

function amountBand(amountCents: number): PolicyCaseContext["amountBand"] {
	if (amountCents < 1_000_000) return "lt_10k";
	if (amountCents < 5_000_000) return "10k_50k";
	if (amountCents < 25_000_000) return "50k_250k";
	return "gte_250k";
}

function termBand(termMonths: number): PolicyCaseContext["termBand"] {
	if (termMonths < 12) return "lt_12m";
	if (termMonths < 36) return "12_36m";
	if (termMonths < 60) return "36_60m";
	return "gte_60m";
}

/** Map T18 account UUIDs to per-run ordinals; never forward the UUID. The
 * two-pass map keeps one ordinal per account and preserves first-seen order. */
export function accountScopeMap(signals: Array<{ accountScope: string }>): Map<string, string> {
	const map = new Map<string, string>();
	for (const signal of signals) {
		if (signal.accountScope === "all") continue;
		if (!map.has(signal.accountScope) && map.size < 99) {
			map.set(signal.accountScope, `account_${map.size + 1}`);
		}
	}
	return map;
}

export function buildPolicyCaseContext(input: PolicyStageInput): PolicyCaseContext {
	const scopeMap = accountScopeMap(input.signals);
	const signals: PolicyCaseSignal[] = [];
	for (const raw of input.signals) {
		const accountScope =
			raw.accountScope === "all" ? "aggregate" : (scopeMap.get(raw.accountScope) ?? "aggregate");
		const ref = signalRef({
			type: raw.type,
			metric: raw.metric,
			periodStart: raw.periodStart,
			periodEnd: raw.periodEnd,
			accountScope,
		});
		signals.push({
			ref,
			type: raw.type as PolicyCaseSignal["type"],
			metric: raw.metric as PolicyCaseSignal["metric"],
			periodStart: raw.periodStart,
			periodEnd: raw.periodEnd,
			accountScope,
			status: raw.status,
			confidence: raw.confidence,
		});
	}
	const documentFindings = (input.documentFindings ?? []).map((finding, index) => ({
		field: finding.field as PolicyCaseContext["documentFindings"][number]["field"],
		status: finding.status as PolicyCaseContext["documentFindings"][number]["status"],
		confidence: finding.confidence as PolicyCaseContext["documentFindings"][number]["confidence"],
		index: finding.index ?? index,
	}));
	const type = input.caseFacts.type === "sme" ? "sme" : "individual";
	const product = input.caseFacts.product === "sme_term_loan" ? "sme_term_loan" : "personal_loan";
	return policyCaseContextSchema.parse({
		applicationId: input.applicationId,
		runId: input.runId,
		authorisingActorId: input.authorisingActorId,
		authorisingActorRole: input.authorisingActorRole,
		asOf: input.asOf.slice(0, 10),
		type,
		product,
		amountBand: amountBand(input.caseFacts.amountCents),
		termBand: termBand(input.caseFacts.termMonths),
		signals,
		documentFindings,
	});
}

export function createHttpPolicyRunner(
	env: PolicyRunnerEnv,
	fetchImpl: typeof fetch = fetch,
): PolicyRunner {
	return {
		async explainCase(input) {
			const path = "/internal/policy/explain-case";
			const body = JSON.stringify({
				caseContext: input.caseContext,
				caseToken: input.caseToken,
			});
			const headers = signInternalHeaders(env.policyInternalSecret, {
				userId: env.autoTriggerServiceUserId,
				role: "service",
				email: env.autoTriggerServiceEmail,
				method: "POST",
				path,
				body,
			});
			const res = await fetchImpl(`${env.policyUrl}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body,
				signal: AbortSignal.timeout(env.policyCaseTimeoutMs),
			});
			if (!res.ok) {
				let code = `HTTP_${res.status}`;
				try {
					const err = (await res.json()) as { error?: { code?: string } };
					if (err.error?.code) code = err.error.code;
				} catch {
					// keep the HTTP code
				}
				throw new Error(`policy case call failed: ${code}`);
			}
			const parsed = caseResponseSchema.safeParse(await res.json());
			if (!parsed.success) throw new Error("policy case response shape drift");
			return parsed.data;
		},
	};
}

export function createCaseTokenForInput(env: PolicyRunnerEnv, input: PolicyStageInput): string {
	return signCaseToken(
		env.policyCaseTokenSecret,
		{
			runId: input.runId,
			applicationId: input.applicationId,
			authorisingActorId: input.authorisingActorId,
			authorisingActorRole: input.authorisingActorRole,
			asOf: input.asOf.slice(0, 10),
		},
		env.policyCaseTokenTtlSeconds,
	);
}

export { amountBand, termBand };
