// Shared contracts for the E3 case policy/exception navigator.
// Pure types only; no DB or network. The policy client, agent runner, and
// web response all use these shapes.

import type {
	EvidenceBundle,
	ExceptionState,
	PolicyExceptionPath,
	PolicyRuleEffect,
	PolicyRuleId,
	PolicySectionRef,
	PolicyApplicationKind,
} from "@credit/core";
import type { MemoAgentTrace } from "../shared/trace.js";

export interface PolicySectionDelivery {
	policyId: string;
	policyVersionId: string;
	policyKey: string;
	sectionId: string;
	version: string;
	heading: string;
	body: string;
	truncated: boolean;
	effectiveFrom: string;
	effectiveTo: string | null;
	contentHash: string;
	quoteHash: string;
	drawerToken: string;
}

export interface PolicySectionMissing {
	policyKey: string;
	sectionId: string;
	reason: "not_found" | "not_effective" | "forbidden" | "truncated";
}

export interface PolicySourceResponse {
	status: "ok" | "partial";
	sections: PolicySectionDelivery[];
	missing: PolicySectionMissing[];
}

export type PolicySourceErrorCode =
	| "POLICY_SOURCE_UNAVAILABLE"
	| "POLICY_SOURCE_BUDGET"
	| "POLICY_SOURCE_INVALID";

export class PolicySourceError extends Error {
	readonly code: PolicySourceErrorCode;
	readonly status: number | null;
	constructor(code: PolicySourceErrorCode, status: number | null = null) {
		super(
			code === "POLICY_SOURCE_BUDGET"
				? "policy source budget exceeded"
				: code === "POLICY_SOURCE_INVALID"
					? "policy source returned an invalid response"
					: "policy source is unavailable",
		);
		this.name = "PolicySourceError";
		this.code = code;
		this.status = status;
	}
}

export interface ResolveSectionsInput {
	applicationId: string;
	actorId: string;
	actorRole: string;
	policyAsOf: string;
	productScope: "individual" | "sme";
	refs: Array<{ policyKey: string; sectionId: string; versionId?: string }>;
}

export interface SearchSectionsInput {
	applicationId: string;
	actorId: string;
	actorRole: string;
	policyAsOf: string;
	productScope: "individual" | "sme";
	query: string;
	topK?: number;
}

export interface PolicyClient {
	resolveSections(
		input: ResolveSectionsInput,
		opts?: { signal?: AbortSignal },
	): Promise<PolicySourceResponse>;
	searchSections(
		input: SearchSectionsInput,
		opts?: { signal?: AbortSignal },
	): Promise<PolicySourceResponse>;
}

export interface CaseRuleFailure {
	ruleId: string;
	reasonCode: string;
	effect: "decline" | "refer" | "informational";
	product?: string;
	persisted: boolean;
	evaluated: boolean;
	decisionRelevant: boolean;
	observed: string;
	observedValue: number | string;
	threshold: string;
	scoreBand: string;
	ruleSectionRefs: PolicySectionRef[];
	exception: PolicyExceptionPath;
	mappingState: "mapped" | "mapping_unavailable";
	explanationLimitation: string | null;
}

export interface CaseRuleContext {
	applicationId: string;
	applicationReference: string | null;
	policyAsOf: string;
	product: "personal_loan" | "sme_term_loan";
	applicationKind: PolicyApplicationKind;
	outcome: "auto_approve" | "refer" | "decline" | "not_applicable";
	policyVersion: string | null;
	scorecardVersion: string;
	registryVersion: string;
	score: number | null;
	grade: string | null;
	scoreBand: string | null;
	amountCents: number;
	secured: boolean;
	securedQualifying: boolean;
	status: "ok" | "partial_mapping" | "mapping_unavailable" | "no_failed_rules" | "not_applicable";
	failedRules: CaseRuleFailure[];
	unmappedRuleIds: string[];
	unmappedExceptionRuleIds: string[];
	limitations: string[];
	/** Present on the deterministic EN-07 context. */
	caseStatus?: string;
	reasonCodes?: string[];
	failedRuleCount?: number;
	evaluationId?: string | null;
	decisionId?: string | null;
}

export interface PolicyExceptionArtifactSummary {
	id: string;
	version: number;
	revision: number;
	status: string;
	updatedAt: string;
	retentionUntil: string;
}

export interface PolicyExceptionView {
	context: CaseRuleContext;
	sections: PolicySectionDelivery[];
	sourceStatus: "ok" | "partial" | "unavailable";
	latestArtifact: PolicyExceptionArtifactSummary | null;
}

export interface RuleExplanation {
	ruleId: PolicyRuleId | string;
	segments: Array<{ text: string; citationIndexes: number[] }>;
	citations: Array<{
		policyKey: string;
		sectionId: string;
		version?: string;
		quote: string;
		policyVersionId?: string;
		heading?: string;
		effectiveFrom?: string;
		effectiveTo?: string | null;
		quoteStart?: number;
		quoteEnd?: number;
		contentHash?: string;
		drawerToken?: string;
	}>;
	confidence: "low" | "medium" | "high";
}

export interface PolicyExplanation {
	status: "succeeded" | "needs_policy_owner" | "no_match";
	rules: RuleExplanation[];
	limitations: string[];
	trace?: PolicyExceptionTraceSummary;
	registryVersion: string;
}

export interface PolicyFollowUp {
	status: "succeeded" | "needs_policy_owner" | "no_match";
	segments: Array<{ text: string; citationIndexes: number[] }>;
	citations: RuleExplanation["citations"];
	limitations: string[];
	trace?: PolicyExceptionTraceSummary;
	registryVersion: string;
}

export interface PolicyExceptionTraceSummary {
	agentVersion: string;
	model: string;
	promptVersion: string;
	validatorVersion: string;
	registryVersion: string;
	registryHash: string;
	steps: number;
	toolCalls: MemoAgentTrace["toolCalls"];
	sourceRefs: string[];
	repairAttempted: boolean;
	repairSucceeded: boolean | null;
	inputTokens: number;
	outputTokens: number;
	latencyMs: number;
	costUsd: number;
}

export type PolicyExceptionMode = "explain" | "followup" | "memo";

export interface PolicyExceptionAgentRunInput {
	mode: PolicyExceptionMode;
	question?: string;
	context: CaseRuleContext;
	evidence: EvidenceBundle;
	catalog: PolicySectionDelivery[];
	/** Requesting officer; policy tools use this for audit attribution. */
	actorId: string;
	actorRole: string;
	signal: AbortSignal;
	maxTurns: number;
	conversationId?: string;
	repair?: {
		previousOutput: string;
		issues: Array<{ code: string; path: string }>;
		requireTools: boolean;
	};
}

export interface PolicyExceptionAgentRunResult {
	rawOutput: string;
	toolCalls: MemoAgentTrace["toolCalls"];
	sourceRefs: string[];
	/** Sections returned by policy tools during this run, for citation
	 * validation. Bodies stay in memory; the trace stores refs only. */
	policySections: PolicySectionDelivery[];
	steps: number;
	usage: { inputTokens: number; outputTokens: number; costUsd: number };
}

export interface PolicyExceptionAgentRunner {
	run(input: PolicyExceptionAgentRunInput): Promise<PolicyExceptionAgentRunResult>;
}

export type PolicyExceptionErrorCode =
	| "POLICY_EXCEPTION_UNAVAILABLE"
	| "POLICY_EXCEPTION_TIMEOUT"
	| "POLICY_EXCEPTION_BUDGET"
	| "POLICY_EXCEPTION_INVALID"
	| "MAPPING_UNAVAILABLE"
	| "RULE_CONTEXT_UNAVAILABLE"
	| "UNSUPPORTED_POLICY_VERSION"
	| "POLICY_SOURCE_UNAVAILABLE";

export type { ExceptionState, PolicyExceptionPath, PolicyRuleEffect, PolicySectionRef };
