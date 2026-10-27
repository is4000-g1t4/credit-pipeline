// --- T01/T02 document workflow (SPEC-t01-t02 §5, D3 UI only). ---
// Metadata only — page text travels via fetchDocumentPages and the
// original bytes via downloadDocument (blob, never logged).

import { api, nullOn404 } from "./client";

export type DocumentKind =
	| "id"
	| "business_registration"
	| "bank_statement"
	| "payslip"
	| "financial_statements"
	| "other";

export interface DocumentFile {
	id: string;
	applicationId: string;
	kind: string;
	status: "ready" | "rejected" | "deleted";
	ocrStatus: "not_applicable" | "ready" | "low_confidence" | "unsupported" | "failed";
	textLayerRisk: boolean;
	originalFilename: string | null;
	mimeType: string;
	sizeBytes: number;
	sha256: string;
	pageCount: number;
	ocrConfidence: number | null;
	uploadedBy: string;
	uploadedAt: string;
	retentionUntil: string;
	errorCode: string | null;
}

export interface DocumentsList {
	files: DocumentFile[];
}

export interface DocumentPageItem {
	pageNumber: number;
	text: string;
	source: string;
	confidence: number;
	charCount: number;
}

export interface DocumentPages {
	pages: DocumentPageItem[];
}

export interface DocumentCrosscheckSummary {
	id: string;
	applicationId: string;
	status: string;
	validatorVersion: string;
	documentsChecked: string[];
	findingCount: number;
	requestedBy: string;
	startedAt: string;
	finishedAt: string | null;
	errorCode: string | null;
}

export interface DocumentFinding {
	id: string;
	crosscheckId: string;
	applicationId: string;
	documentFileId: string | null;
	field: string;
	expected: string | null;
	observed: string | null;
	pageNumber: number | null;
	quote: string | null;
	quoteStart: number | null;
	quoteEnd: number | null;
	quoteHash: string | null;
	confidence: string;
	status: "mismatch" | "needs_chase";
	reason: string;
	createdAt: string;
}

export interface DocumentCrosscheck {
	crosscheck: DocumentCrosscheckSummary;
	findings: DocumentFinding[];
}

export interface ChaseDraft {
	chase: {
		id: string;
		applicationId: string;
		crosscheckId: string;
		status: string;
		body: string | null;
		createdBy: string;
		createdAt: string;
		sentAt: string | null;
		inspectedOriginalAt: string;
		findingIds: string[];
	};
	findings: DocumentFinding[];
}

export function fetchDocumentFiles(applicationId: string): Promise<DocumentsList> {
	return api<DocumentsList>(`/api/applications/${applicationId}/documents`);
}

export function fetchDocumentPages(applicationId: string, fileId: string): Promise<DocumentPages> {
	return api<DocumentPages>(`/api/applications/${applicationId}/documents/${fileId}/pages`);
}

/** 404 → null ("no crosscheck yet"); every other error throws. */
export function fetchCrosscheck(applicationId: string): Promise<DocumentCrosscheck | null> {
	return nullOn404(() =>
		api<DocumentCrosscheck>(`/api/applications/${applicationId}/documents/crosscheck`),
	);
}

export function runCrosscheck(applicationId: string): Promise<DocumentCrosscheck> {
	return api<DocumentCrosscheck>(`/api/applications/${applicationId}/documents/crosscheck`, {
		method: "POST",
	});
}

export function createChaseDraft(
	applicationId: string,
	crosscheckId: string,
	findingIds: string[],
): Promise<ChaseDraft> {
	return api<ChaseDraft>(
		`/api/applications/${applicationId}/documents/crosscheck/${crosscheckId}/chase`,
		{ method: "POST", body: { findingIds, inspectedOriginal: true } },
	);
}

export function claimDocuments(
	applicationId: string,
): Promise<{ assignment: unknown; idempotent: boolean }> {
	return api<{ assignment: unknown; idempotent: boolean }>(
		`/api/applications/${applicationId}/documents/claim`,
		{ method: "POST" },
	);
}

export function updateDocumentConsent(
	applicationId: string,
	consent: boolean,
): Promise<{ documentProcessingConsent: boolean }> {
	return api<{ documentProcessingConsent: boolean }>(
		`/api/applications/${applicationId}/document-consent`,
		{ method: "PATCH", body: { consent } },
	);
}

export function retryDocumentOcr(
	applicationId: string,
	fileId: string,
): Promise<{ file: DocumentFile }> {
	return api<{ file: DocumentFile }>(
		`/api/applications/${applicationId}/documents/${fileId}/retry-ocr`,
		{ method: "POST" },
	);
}
