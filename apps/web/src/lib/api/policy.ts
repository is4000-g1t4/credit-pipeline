// --- Officer credit-policy Q&A (policy service via gateway). Advisory only:
// answers cite exact policy sections; the drawer loads the full section body.
import type { Product } from "@credit/core/browser";

import { api } from "./client";

export type PolicyProduct = Product;

export interface PolicyCitation {
	policyKey: string;
	policyVersionId: string;
	sectionId: string;
	heading: string;
	version: string;
	effectiveFrom: string;
	quote: string;
	drawerToken: string;
}

export type PolicyAskStatus =
	| "succeeded"
	| "no_match"
	| "needs_policy_owner"
	| "out_of_scope"
	| "identifier_blocked"
	| "rate_limited"
	| "budget_exceeded"
	| "failed";

export interface PolicyAnswerSegment {
	text: string;
	citationIndexes: number[];
}

export interface PolicyAskResponse {
	status: PolicyAskStatus;
	segments: PolicyAnswerSegment[];
	citations: PolicyCitation[];
	limitations: string[];
	usage?: { costUsd?: number; latencyMs?: number };
}

export interface PolicySection {
	policyKey: string;
	sectionId: string;
	heading: string;
	version: string;
	effectiveFrom: string;
	effectiveTo: string | null;
	body: string;
	neighbours?: Array<{ sectionId: string; heading: string }>;
}

export function askPolicy(
	question: string,
	product: PolicyProduct,
	jurisdiction = "SG",
): Promise<PolicyAskResponse> {
	return api<PolicyAskResponse>("/api/policy/ask", {
		method: "POST",
		body: { question, product, jurisdiction },
	});
}

export function fetchPolicySection(
	versionId: string,
	sectionId: string,
	token: string,
): Promise<PolicySection> {
	return api<PolicySection>(
		`/api/policy/sections/${encodeURIComponent(versionId)}/${encodeURIComponent(sectionId)}?token=${encodeURIComponent(token)}`,
	);
}

// --- Policy review stage on the research aggregate (case-scoped, advisory).
// Renders inside ResearchPanel after internal context; never decides.

export type ResearchPolicyStatus =
	| "not_applicable"
	| "running"
	| "succeeded"
	| "no_match"
	| "needs_policy_owner"
	| "budget_exceeded"
	| "failed"
	| "skipped";

export interface PolicyReviewSegment {
	text: string;
	citationIndexes: number[];
}

export interface PolicyReviewItem {
	ref: string;
	explanationSegments: PolicyReviewSegment[];
	citations: PolicyCitation[];
	confidence: "low" | "medium" | "high";
}

export interface ResearchPolicy {
	status: ResearchPolicyStatus;
	errorCode?: string | null;
	brief?: {
		summary?: string;
		items: PolicyReviewItem[];
		limitations: string[];
	} | null;
	usage?: { costUsd?: number } | null;
}
