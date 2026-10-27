// --- E2 document integrity + EN-05 fraud review (officer-only). Metadata
// and stored quotes only — page text travels via fetchDocumentPages and the
// original bytes via downloadDocument (blob, never logged). ---

import { api, nullOn404 } from "./client";
import type { FraudReview } from "./fraud";

export type IntegritySeverity = "low" | "medium" | "high";

export interface IntegritySignal {
	code: string;
	severity: IntegritySeverity;
	/** Null for case-level signals (cross-check/duplicate). */
	documentFileId: string | null;
	summary: string;
	sourceRef: string;
	count?: number;
}

export interface IntegrityFingerprint {
	sha256: string;
	sizeBytes: number;
	mimeType: string;
	pageCount: number;
	ocrConfidence: number | null;
	producer: string;
	creator: string;
	metadataCreatedAt: string | null;
	metadataModifiedAt: string | null;
	metadataSource: "pdf" | "image" | "unknown";
	editSignal: "detected" | "not_detected" | "unknown";
	editCodes: string[];
	fingerprintVersion: string;
}

export interface IntegrityCandidate {
	id: string;
	documentFileId: string;
	field: string;
	value: string;
	pageNumber: number;
	offsetStart: number;
	offsetEnd: number;
	confidence: number;
	status: "candidate" | "validated" | "confirmed" | "rejected";
	validationCodes: string[];
	confirmedAt: string | null;
	stale: boolean;
}

export interface IntegrityConsistencySide {
	documentFileId: string;
	pageNumber: number;
	value: string;
	label: string;
	currency: string | null;
	quote: string;
	offsetStart: number;
	offsetEnd: number;
}

export interface IntegrityConsistency {
	id: string;
	field: string;
	proposedKind: "match" | "mismatch";
	findingState: "match" | "mismatch" | "needs_chase";
	severity: IntegritySeverity;
	left: IntegrityConsistencySide;
	right: IntegrityConsistencySide;
	explanation: string | null;
	reason: string;
}

export interface IntegrityRunToolCall {
	step: number;
	name: string;
	resultCount: number;
	sourceTypes: string[];
	refs: string[];
}

export interface IntegrityRunTrace {
	id: string;
	feature: "document_analysis";
	status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
	model: string;
	promptVersion: string;
	agentVersion: string;
	steps: number | null;
	toolCalls: IntegrityRunToolCall[];
	sourceRefs: string[];
	repairAttempted: boolean;
	repairSucceeded: boolean;
	usage: { inputTokens: number; outputTokens: number; costUsd: number } | null;
	errorCode: string | null;
	createdAt: string;
	finishedAt: string | null;
}

export interface IntegrityDocumentPanel {
	documentFileId: string;
	kind: string;
	status: string;
	ocrStatus: string;
	originalFilename: string | null;
	fingerprint: IntegrityFingerprint | null;
	signals: IntegritySignal[];
	duplicateCount: number;
	crossApplicationRestricted: boolean;
	candidates: IntegrityCandidate[];
	consistency: IntegrityConsistency[];
}

export interface IntegrityPanel {
	documents: IntegrityDocumentPanel[];
	caseSignals: IntegritySignal[];
	latestAnalysis: IntegrityRunTrace | null;
	openReview: {
		id: string;
		status: string;
		severity: IntegritySeverity;
		reasonCode: string;
		createdAt: string;
	} | null;
}

/** 404 → null (feature off or caller not assigned); every other error throws. */
export function fetchIntegrityPanel(applicationId: string): Promise<IntegrityPanel | null> {
	return nullOn404(async () =>
		api<{ panel: IntegrityPanel }>(`/api/applications/${applicationId}/integrity`).then(
			(r) => r.panel,
		),
	);
}

export function requestIntegrityAnalysis(
	applicationId: string,
): Promise<{ run: IntegrityRunTrace }> {
	return api<{ run: IntegrityRunTrace }>(`/api/applications/${applicationId}/integrity/analyses`, {
		method: "POST",
	});
}

export function fetchIntegrityRun(
	applicationId: string,
	runId: string,
): Promise<{ run: IntegrityRunTrace }> {
	return api<{ run: IntegrityRunTrace }>(
		`/api/applications/${applicationId}/integrity/analyses/${runId}`,
	);
}

export function actOnIntegrityCandidate(
	applicationId: string,
	candidateId: string,
	action: "confirm" | "reject",
): Promise<{ candidate: { id: string; status: string; confirmedAt: string | null } }> {
	return api<{ candidate: { id: string; status: string; confirmedAt: string | null } }>(
		`/api/applications/${applicationId}/integrity/candidates/${candidateId}`,
		{ method: "PATCH", body: { action } },
	);
}

export function escalateIntegrityConsistency(
	applicationId: string,
	consistencyId: string,
	note?: string,
): Promise<{ review: FraudReview }> {
	return api<{ review: FraudReview }>(
		`/api/applications/${applicationId}/integrity/consistency/${consistencyId}/escalate`,
		{ method: "POST", body: note === undefined ? {} : { note } },
	);
}

export type IntegrityFlagReason =
	| "document_integrity"
	| "duplicate_document"
	| "metadata_inconsistency"
	| "other";

export function flagIntegrity(
	applicationId: string,
	body: {
		reasonCode: IntegrityFlagReason;
		note: string;
		severity?: IntegritySeverity;
		documentFileIds?: string[];
	},
): Promise<{ review: FraudReview }> {
	return api<{ review: FraudReview }>(`/api/applications/${applicationId}/integrity/flags`, {
		method: "POST",
		body,
	});
}

export function evaluateIntegrity(applicationId: string): Promise<{
	result: { flagged: boolean; severity: IntegritySeverity | null; reviewId: string | null };
}> {
	return api<{
		result: { flagged: boolean; severity: IntegritySeverity | null; reviewId: string | null };
	}>(`/api/applications/${applicationId}/integrity/evaluate`, { method: "POST" });
}
