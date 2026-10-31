// E2 document integrity — shared contracts (EN-04/EN-05, US-INT-1..5).
//
// Pure types only. The deterministic layer, the bounded agent, the store, and
// the routes all import this file so the DB rows, the agent trace, and the
// HTTP DTOs cannot drift. Nothing here carries raw document text into a log
// or a trace; page text lives only in the in-memory snapshot and citations.

import type { DocumentKind } from "../documents/pipeline.js";
import type { OcrStatus, TextSource } from "../documents/ocr.js";
import type { CitationRecord, DocumentIntegrityBriefContent, EvidenceBundle } from "@credit/core";

export type IntegritySeverity = "low" | "medium" | "high";

export const INTEGRITY_SIGNAL_CODES = [
	"duplicate_hash_cross_application",
	"duplicate_hash_same_applicant_other_case",
	"duplicate_hash_same_application",
	"crosscheck_mismatch",
	"crosscheck_confusable",
	"text_layer_risk",
	"ocr_low_confidence",
	"metadata_date_inversion",
	"incremental_update",
	"editor_producer",
	"recompression_editor",
	"ocr_unsupported",
	"consistency_candidate",
	"metadata_unknown",
] as const;

export type IntegritySignalCode = (typeof INTEGRITY_SIGNAL_CODES)[number];

/** Codes that never create a case-level flag on their own. */
export const NON_FLAGGING_SIGNAL_CODES: readonly IntegritySignalCode[] = [
	"metadata_unknown",
	"consistency_candidate",
];

export interface DeterministicSignal {
	code: IntegritySignalCode;
	severity: IntegritySeverity;
	/** Null for case-level signals (crosscheck/duplicate). */
	documentFileId: string | null;
	summary: string;
	/** `context_signal:integrity:<code>[:<documentFileId>]` */
	sourceRef: string;
	count?: number;
}

export interface IntegrityConfig {
	enabled: boolean;
	fraudReviewEnabled: boolean;
	agentEnabled: boolean;
	triageEnabled: boolean;
	model: string;
	promptVersion: string;
	agentVersion: string;
	triagePromptVersion: string;
	maxSteps: number;
	maxToolCalls: number;
	timeoutMs: number;
	maxCostUsd: number;
	maxOutputTokens: number;
	flagSeverity: IntegritySeverity;
	retentionDays: number;
	systemUserId: string;
	maxRunsPerHash: number;
	openRouterApiKey: string | null;
	openRouterBaseUrl: string;
}

export interface IntegrityRuntime {
	config: IntegrityConfig;
	documentsEnabled: boolean;
	agentRunner: IntegrityAgentRunner | null;
	now: () => Date;
	/** Starts the Temporal workflow for a queued run (null = no dispatch). */
	starter?: import("@credit/agent-kit/temporal/client").AgentRunStarter | null;
}

export interface IntegrityPage {
	pageNumber: number;
	text: string;
	source: TextSource;
	confidence: number;
	/** Stored page hash; part of the run input hash so retry-OCR invalidates. */
	textSha256: string;
}

export interface IntegrityDocumentSnapshot {
	documentFileId: string;
	kind: DocumentKind;
	pageCount: number;
	ocrStatus: OcrStatus;
	textLayerRisk: boolean;
	sha256: string;
	sizeBytes: number;
	mimeType: string;
	ocrConfidence: number | null;
	documentDate: string | null;
	periodEnd: string | null;
	source: string;
	uploadedAt: Date;
	pages: IntegrityPage[];
	/** Null when the file has been tombstoned or its blob purged. */
	readable: boolean;
	unavailableCode?: "missing" | "unavailable" | "retention_expired" | "access_denied";
}

export interface IntegrityCrosscheckFinding {
	id: string;
	field: string;
	status: "mismatch" | "needs_chase";
	confidence: "low" | "medium" | "high";
	expected: string | null;
	observed: string | null;
	documentFileId: string | null;
	pageNumber: number | null;
	quote: string | null;
	quoteStart: number | null;
	quoteEnd: number | null;
	quoteHash: string | null;
	reason: string;
}

export interface IntegrityCustomerDocument {
	customerDocumentId: string;
	kind: DocumentKind;
	pageCount: number;
	ocrStatus: OcrStatus;
	sha256Prefix: string;
	documentDate: string | null;
	periodEnd: string | null;
	readable: boolean;
	pages: IntegrityPage[];
}

export interface IntegrityDuplicateCounts {
	sameApplication: number;
	sameApplicantOther: number;
	crossApplicant: number;
}

export interface IntegrityDuplicateMatch {
	sourceDocumentFileId: string;
	matchingDocumentFileId: string;
	kind: string;
	relation: "same_application" | "same_applicant" | "cross_applicant";
}

export interface IntegrityUnavailableSource {
	code: "missing" | "unavailable" | "retention_expired" | "access_denied";
	label: string;
	ref?: string;
}

/** Immutable per-run snapshot. Tools read only this; they never query by a
 * model-supplied id. */
export interface IntegritySource {
	applicationId: string;
	applicationReference: string;
	applicationType: "individual" | "sme";
	product: string;
	applicantUserId: string;
	customerProfileId: string | null;
	documentConsent: boolean;
	contextConsent: boolean;
	caseFacts: Array<{ field: string; label: string; value: string }>;
	documents: IntegrityDocumentSnapshot[];
	customerDocuments: IntegrityCustomerDocument[];
	crosscheck: { id: string; findings: IntegrityCrosscheckFinding[] } | null;
	signals: DeterministicSignal[];
	duplicateCounts: IntegrityDuplicateCounts;
	duplicateMatches: IntegrityDuplicateMatch[];
	unavailable: IntegrityUnavailableSource[];
	/** True only for brief runs; extraction-only runs never register customer tools. */
	includeCustomerEvidence: boolean;
}

export interface IntegrityToolCall {
	step: number;
	name: string;
	resultCount: number;
	sourceTypes: string[];
	/** Metadata-only refs (never text). Max 20 per call. */
	refs: string[];
}

export interface IntegrityUsage {
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
}

export interface IntegrityAgentRunResult {
	rawOutput: string;
	toolCalls: IntegrityToolCall[];
	sourceRefs: string[];
	steps: number;
	usage: IntegrityUsage;
}

export interface IntegrityBriefResult {
	content: DocumentIntegrityBriefContent;
	citations: CitationRecord[];
	evidence: EvidenceBundle;
}

export type IntegrityAgentMode = "analysis" | "triage";

export interface IntegrityAgentRepair {
	previousOutput: string;
	issues: Array<{ code: string; path: string }>;
	requireTools: boolean;
}

export interface IntegrityAgentRunner {
	run(input: {
		mode: IntegrityAgentMode;
		/** One combined run: candidates always; brief only for a flagged case. */
		generateBrief?: boolean;
		source: IntegritySource;
		maxTurns: number;
		/** Grafana Agent Observability conversation id (metadata only). */
		conversationId?: string;
		repair?: IntegrityAgentRepair;
		signal?: AbortSignal;
	}): Promise<IntegrityAgentRunResult>;
}

export type IntegrityAgentErrorCode =
	| "AGENT_UNAVAILABLE"
	| "STEP_LIMIT"
	| "TOOL_CALL_LIMIT"
	| "TIMEOUT"
	| "BUDGET_EXCEEDED"
	| "NO_TOOL_USE"
	| "INVALID_OUTPUT"
	| "MODEL_ERROR";

export class IntegrityAgentError extends Error {
	constructor(
		readonly code: IntegrityAgentErrorCode,
		readonly issues: Array<{ code: string; path: string }> = [],
	) {
		super(code);
		this.name = "IntegrityAgentError";
	}
}

// --- Analysis output (model JSON, before deterministic validation) ---

export const INTEGRITY_CANDIDATE_FIELDS = [
	"document_type",
	"issuer",
	"document_date",
	"statement_period_start",
	"statement_period_end",
	"registration_number",
	"account_number",
	"account_holder_name",
	"material_amount",
	"other",
] as const;

export type IntegrityCandidateField = (typeof INTEGRITY_CANDIDATE_FIELDS)[number];

export const INTEGRITY_CONSISTENCY_FIELDS = [
	"company_name",
	"registration_number",
	"account_holder_name",
	"statement_period",
	"material_amount",
	"document_date",
	"other",
] as const;

export type IntegrityConsistencyField = (typeof INTEGRITY_CONSISTENCY_FIELDS)[number];

export interface IntegrityCandidateProposal {
	documentFileId: string;
	field: IntegrityCandidateField;
	value: string;
	pageNumber: number;
	quote: string;
	confidence: number;
}

export interface IntegrityConsistencySide {
	documentFileId: string;
	pageNumber: number;
	value: string;
	label: string;
	currency?: string;
	quote: string;
}

export interface IntegrityConsistencyProposal {
	field: IntegrityConsistencyField;
	proposedKind: "match" | "mismatch";
	left: IntegrityConsistencySide;
	right: IntegrityConsistencySide;
}

export interface IntegrityAnalysisOutput {
	candidates: IntegrityCandidateProposal[];
	consistency: IntegrityConsistencyProposal[];
	brief?: unknown;
}

// --- Validated candidates (ready for persistence) ---

export interface ValidatedCandidate {
	documentFileId: string;
	field: IntegrityCandidateField;
	value: string;
	normalizedValue: string;
	pageNumber: number;
	offsetStart: number;
	offsetEnd: number;
	quote: string;
	quoteHash: string;
	confidence: number;
	status: "candidate" | "validated" | "rejected";
	validationCodes: string[];
}

export interface ValidatedConsistency {
	field: IntegrityConsistencyField;
	proposedKind: "match" | "mismatch";
	kind: "match" | "mismatch" | null;
	severity: IntegritySeverity;
	comparisonBasis: string;
	left: {
		documentFileId: string;
		pageNumber: number;
		value: string;
		label: string;
		currency: string | null;
		quote: string;
		offsetStart: number;
		offsetEnd: number;
		quoteHash: string;
	};
	right: ValidatedConsistency["left"];
	explanation: string | null;
	explanationVerified: boolean;
	status: "candidate" | "confirmed" | "rejected";
	reason: string;
}

// --- Brief output (model JSON, before server citation resolution) ---

export interface IntegrityBriefCitationToken {
	kind: "document" | "customer_document" | "signal" | "duplicate_document";
	documentFileId?: string;
	customerDocumentId?: string;
	matchingDocumentFileId?: string;
	pageNumber?: number;
	quote?: string;
	signalCode?: string;
}

export interface IntegrityBriefClaim {
	text: string;
	citations: IntegrityBriefCitationToken[];
}

export interface IntegrityBriefOutput {
	title: string;
	summary: IntegrityBriefClaim;
	candidateContradictions: IntegrityBriefClaim[];
	missingEvidence: Array<{
		text: string;
		code:
			| "missing_document"
			| "stale_document"
			| "failed_rule"
			| "unsupported_claim"
			| "contradiction"
			| "financials_unavailable"
			| "other";
		sourceRef?: string;
	}>;
	alternativeExplanations: IntegrityBriefClaim[];
	questionsForReviewer: string[];
	suggestedPriority: IntegritySeverity;
}

// --- HTTP DTOs ---

export interface IntegrityFingerprintDto {
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

export interface IntegrityCandidateDto {
	id: string;
	documentFileId: string;
	field: IntegrityCandidateField;
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

export interface IntegrityConsistencyDto {
	id: string;
	field: IntegrityConsistencyField;
	proposedKind: "match" | "mismatch";
	findingState: "match" | "mismatch" | "needs_chase";
	severity: IntegritySeverity;
	left: {
		documentFileId: string;
		pageNumber: number;
		value: string;
		label: string;
		currency: string | null;
		quote: string;
		offsetStart: number;
		offsetEnd: number;
	};
	right: IntegrityConsistencyDto["left"];
	explanation: string | null;
	reason: string;
}

export interface IntegrityRunTraceDto {
	id: string;
	feature: "document_analysis";
	status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
	model: string;
	promptVersion: string;
	agentVersion: string;
	steps: number | null;
	toolCalls: IntegrityToolCall[];
	sourceRefs: string[];
	repairAttempted: boolean;
	repairSucceeded: boolean;
	usage: IntegrityUsage | null;
	errorCode: string | null;
	createdAt: string;
	finishedAt: string | null;
}

export interface IntegrityDocumentPanelDto {
	documentFileId: string;
	kind: DocumentKind;
	status: "ready" | "rejected" | "deleted";
	ocrStatus: OcrStatus;
	originalFilename: string | null;
	fingerprint: IntegrityFingerprintDto | null;
	signals: DeterministicSignal[];
	duplicateCount: number;
	crossApplicationRestricted: boolean;
	candidates: IntegrityCandidateDto[];
	consistency: IntegrityConsistencyDto[];
}

export interface IntegrityPanelDto {
	documents: IntegrityDocumentPanelDto[];
	caseSignals: DeterministicSignal[];
	latestAnalysis: IntegrityRunTraceDto | null;
	openReview: {
		id: string;
		status: "open" | "cleared" | "confirmed" | "needs_info";
		severity: IntegritySeverity;
		reasonCode: string;
		createdAt: string;
	} | null;
}
