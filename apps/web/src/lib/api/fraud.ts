// --- EN-05 fraud review (officer-only; every officer sees only assigned
// cases). ---

import { api, nullOn404 } from "./client";
import type { IntegritySeverity } from "./integrity";

export interface FraudQueueItem {
	id: string;
	applicationId: string;
	applicationReference: string;
	status: string;
	severity: IntegritySeverity;
	reasonCode: string;
	briefAvailable: boolean;
	briefStale: boolean;
	briefState: "ready" | "stale" | "pending" | "failed" | "missing";
	createdAt: string;
	updatedAt: string;
	version: number;
}

export interface FraudBriefCitation {
	ref: string;
	quote: string;
}

export interface FraudBriefClaim {
	text: string;
	citations: FraudBriefCitation[];
}

export interface FraudBriefContent {
	title: string;
	summary: FraudBriefClaim;
	candidateContradictions: FraudBriefClaim[];
	alternativeExplanations: FraudBriefClaim[];
	missingEvidence: Array<{ text: string; code: string; sourceRef?: string }>;
	questionsForReviewer: string[];
	suggestedPriority: string;
}

export interface FraudBrief {
	id: string;
	status: string;
	content: FraudBriefContent;
	citations: FraudBriefCitation[];
	agentTrace: unknown;
	model: string;
	promptVersion: string;
	createdAt: string;
}

export interface FraudReview {
	id: string;
	applicationId: string;
	status: string;
	severity: IntegritySeverity;
	reasonCode: string;
	createdAt: string;
	updatedAt: string;
	version: number;
	/** Combined integrity run/brief state. */
	briefAvailable?: boolean;
	briefStale?: boolean;
	briefState?:
		| "queued"
		| "running"
		| "succeeded"
		| "failed"
		| "cancelled"
		| "ready"
		| "pending"
		| "stale"
		| "missing";
	briefUnavailable?: "pending" | "stale" | "missing" | "failed" | "consent_withdrawn" | null;
	note?: string | null;
	assigneeUserId?: string | null;
	signalCodes?: string[];
	documentRefs?: string[];
	briefArtifactId?: string | null;
	agentRunId?: string | null;
	model?: string | null;
	promptVersion?: string | null;
	agentVersion?: string | null;
	resolvedBy?: string | null;
	resolvedAt?: string | null;
	resolutionNote?: string | null;
	brief?: FraudBrief | null;
}

/** 404 → null (feature off); every other error throws. */
export function fetchFraudMe(): Promise<{ canViewQueue: boolean } | null> {
	return nullOn404(() => api<{ canViewQueue: boolean }>("/api/fraud-review/me"));
}

export function fetchFraudQueue(): Promise<{ items: FraudQueueItem[] }> {
	return api<{ items: FraudQueueItem[] }>("/api/fraud-review/queue");
}

export function fetchFraudReview(id: string): Promise<{ review: FraudReview }> {
	return api<{ review: FraudReview }>(`/api/fraud-review/${id}`);
}

export function retryIntegrityBrief(id: string): Promise<{ ok: boolean }> {
	return api<{ ok: boolean }>(`/api/fraud-review/${id}/retry-brief`, { method: "POST", body: {} });
}

export function resolveFraudReview(
	id: string,
	body: { status: "cleared" | "confirmed" | "needs_info"; note: string; expectedVersion: number },
): Promise<{ review: FraudReview; decisionPath: string }> {
	return api<{ review: FraudReview; decisionPath: string }>(`/api/fraud-review/${id}/resolve`, {
		method: "POST",
		body,
	});
}

export function fetchResolutionDraft(
	id: string,
): Promise<{ note: string; citations: FraudBriefCitation[] }> {
	return api<{ note: string; citations: FraudBriefCitation[] }>(
		`/api/fraud-review/${id}/resolution-draft`,
	);
}

export interface DuplicateLookupRow {
	applicationReference: string;
	documentFileId: string;
	kind: string;
	uploadedAt: string;
	explanationNote: string | null;
}

export interface DuplicateLookupResult {
	sha256Prefix: string;
	count: number;
	counts: { sameApplication: number; sameApplicantOther: number; crossApplicant: number } | null;
	rows: DuplicateLookupRow[];
}

export function lookupDuplicateDocuments(body: {
	sha256: string;
	applicationId?: string;
}): Promise<DuplicateLookupResult> {
	return api<DuplicateLookupResult>("/api/fraud-review/duplicates/lookup", {
		method: "POST",
		body,
	});
}

export function explainDuplicateDocument(body: {
	sha256: string;
	applicationId: string;
	note: string;
}): Promise<{ ok: true }> {
	return api<{ ok: true }>("/api/fraud-review/duplicates/explain", { method: "POST", body });
}
