// --- E3 case policy/exception navigator (officer-only). Deterministic rule
// failures with observed/threshold plus the exception/approval path, a
// tool-grounded per-rule explanation, a case-scoped follow-up, and the
// policy exception memo. The panel hides while the flag is off (404).
// Advisory only — nothing here decides the case. ---

import { api } from "./client";
import type { PolicyAnswerSegment } from "./policy";
import type {
	AssistArtifact,
	MemoOpenItem,
	MemoSection,
	MemoTraceToolCall,
} from "./memo";

export interface PolicyExceptionSectionRef {
	policyKey: string;
	sectionId: string;
}

export interface PolicyExceptionMitigant {
	code: string;
	label: string;
	citations: PolicyExceptionSectionRef[];
}

export interface PolicyExceptionPathInfo {
	state: string;
	approver: string | null;
	approverBasis: string | null;
	approverVerification: string;
	committeeCheckRequired: boolean;
	dualSignoff: boolean;
	mitigants: PolicyExceptionMitigant[];
	citations: PolicyExceptionSectionRef[];
	conditions: string[];
	regularisationPlanMaxMonths: number | null;
	reason: string | null;
}

export interface PolicyExceptionFailure {
	ruleId: string;
	reasonCode: string;
	effect: string;
	persisted: boolean;
	evaluated: boolean;
	decisionRelevant: boolean;
	observed: string;
	threshold: string;
	scoreBand: string;
	mappingState: string;
	explanationLimitation: string | null;
	ruleSectionRefs: PolicyExceptionSectionRef[];
	exception: PolicyExceptionPathInfo;
}

export interface PolicyExceptionContext {
	outcome: string;
	policyVersion: string | null;
	scorecardVersion: string;
	registryVersion: string;
	score: number | null;
	grade: string | null;
	scoreBand: string | null;
	status: string;
	failedRules: PolicyExceptionFailure[];
	limitations: string[];
}

export interface PolicyExceptionSection {
	policyKey: string;
	sectionId: string;
	heading: string;
	body: string;
	policyVersionId?: string;
	version?: string;
	drawerToken?: string;
	truncated?: boolean;
	effectiveFrom?: string;
	effectiveTo?: string | null;
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
	context: PolicyExceptionContext;
	sections: PolicyExceptionSection[];
	sourceStatus: "ok" | "partial" | "unavailable";
	latestArtifact: PolicyExceptionArtifactSummary | null;
}

export interface PolicyExceptionCitation {
	policyKey: string;
	sectionId: string;
	quote: string;
	version?: string;
	heading?: string;
	policyVersionId?: string;
	drawerToken?: string;
	effectiveFrom?: string;
	effectiveTo?: string | null;
}

export interface PolicyExceptionRuleExplanation {
	ruleId: string;
	segments: PolicyAnswerSegment[];
	citations: PolicyExceptionCitation[];
	confidence: string;
}

export interface PolicyExceptionTrace {
	agentVersion: string;
	model: string;
	promptVersion: string;
	validatorVersion?: string;
	registryVersion: string;
	registryHash?: string;
	steps: number;
	toolCalls: MemoTraceToolCall[];
	sourceRefs: string[];
	repairAttempted?: boolean;
	repairSucceeded?: boolean | null;
	inputTokens: number;
	outputTokens: number;
	latencyMs: number;
	costUsd?: number;
}

export interface PolicyExceptionExplanation {
	status: "succeeded" | "needs_policy_owner" | "no_match";
	rules: PolicyExceptionRuleExplanation[];
	limitations: string[];
	trace?: PolicyExceptionTrace | null;
	registryVersion: string;
}

export interface PolicyExceptionFollowUp {
	status: "succeeded" | "needs_policy_owner" | "no_match";
	segments: PolicyAnswerSegment[];
	citations: PolicyExceptionCitation[];
	limitations: string[];
	trace?: PolicyExceptionTrace | null;
	registryVersion: string;
}

export interface PolicyExceptionMemoRule {
	ruleId: string;
	reasonCode: string;
	observed: string;
	threshold: string;
	effect: string;
	persisted: boolean;
	exceptionState: string;
	approver: string | null;
	mitigantCodes: string[];
	ruleSectionRefs: PolicyExceptionSectionRef[];
}

export interface PolicyExceptionMemoContent {
	title: string;
	sections: MemoSection[];
	openItems: MemoOpenItem[];
	rules: PolicyExceptionMemoRule[];
	regularisationPlanMonths: number | null;
}

export interface PolicyExceptionMemoArtifact extends Omit<AssistArtifact, "content"> {
	content: PolicyExceptionMemoContent;
}

export function fetchPolicyException(applicationId: string): Promise<PolicyExceptionView> {
	return api<PolicyExceptionView>(`/api/assist/cases/${applicationId}/policy-exception`);
}

export function explainPolicyException(applicationId: string): Promise<PolicyExceptionExplanation> {
	return api<PolicyExceptionExplanation>(
		`/api/assist/cases/${applicationId}/policy-exception/explain`,
		{ method: "POST" },
	);
}

export function askPolicyException(
	applicationId: string,
	question: string,
): Promise<PolicyExceptionFollowUp> {
	return api<PolicyExceptionFollowUp>(
		`/api/assist/cases/${applicationId}/policy-exception/followups`,
		{ method: "POST", body: { question } },
	);
}

/** 201 on a fresh draft, 200 `{ artifact, replayed: true }` on identical evidence. */
export function draftPolicyExceptionMemo(
	applicationId: string,
): Promise<{ artifact: PolicyExceptionMemoArtifact; replayed?: boolean }> {
	return api<{ artifact: PolicyExceptionMemoArtifact; replayed?: boolean }>(
		`/api/assist/cases/${applicationId}/policy-exception/memo`,
		{ method: "POST" },
	);
}

export function fetchPolicyExceptionMemo(
	id: string,
): Promise<{ artifact: PolicyExceptionMemoArtifact }> {
	return api<{ artifact: PolicyExceptionMemoArtifact }>(`/api/assist/artifacts/${id}`);
}

export function approvePolicyExceptionMemo(
	id: string,
	expectedRevision: number,
): Promise<{ artifact: PolicyExceptionMemoArtifact }> {
	return api<{ artifact: PolicyExceptionMemoArtifact }>(`/api/assist/artifacts/${id}/approve`, {
		method: "POST",
		body: { expectedRevision, confirm: true },
	});
}

export function updatePolicyExceptionMemo(
	id: string,
	expectedRevision: number,
	content: PolicyExceptionMemoContent,
): Promise<{ artifact: PolicyExceptionMemoArtifact; createdVersion: boolean }> {
	return api<{ artifact: PolicyExceptionMemoArtifact; createdVersion: boolean }>(
		`/api/assist/artifacts/${id}`,
		{ method: "PATCH", body: { expectedRevision, content } },
	);
}
