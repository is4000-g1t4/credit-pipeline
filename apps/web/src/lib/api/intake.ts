// --- T17 customer intake: drafts, requirements, reuse (SPEC-t17-t18 §2.3).
// Metadata only — masked numbers, freshness, ids. Never storage keys,
// page text, or full account numbers. ---

import { api, nullOn404 } from "./client";
import type { DocumentFile } from "./documents";

export interface CustomerAccountMeta {
	id: string;
	bankName: string;
	accountType: string;
	maskedNumber: string;
	currency: string;
	openedAt: string;
	status: string;
}

export interface CustomerDocMeta {
	id: string;
	kind: string;
	status: string;
	scanStatus: string;
	mimeType: string;
	sizeBytes: number;
	sha256: string;
	pageCount: number;
	ocrStatus: string;
	ocrConfidence: number | null;
	documentDate: string | null;
	periodEnd: string | null;
	freshness: string;
	reusable: boolean;
	reuseReason: string | null;
	retentionUntil: string;
	uploadedAt: string;
}

export interface CustomerProfileResponse {
	profile: {
		id: string;
		segment: string;
		customerSince: string;
		kycStatus: string;
		kycVerifiedAt: string | null;
		kycExpiresAt: string | null;
		kycFresh: boolean;
		identity: Record<string, unknown>;
		business: Record<string, unknown> | null;
		source: string;
	};
	accounts: CustomerAccountMeta[];
	documents: CustomerDocMeta[];
	asOf: string;
}

/** 404 (no profile — legacy demo users) → null; every other error throws. */
export function fetchCustomerProfile(): Promise<CustomerProfileResponse | null> {
	return nullOn404(() => api<CustomerProfileResponse>("/api/customer/profile"));
}

export interface RequirementsResponse {
	policyVersion: string;
	asOf: string;
	readyToSubmit: boolean;
	blockers: Record<string, string[]>;
	warnings: Array<{ code: string; kind?: string; field?: string }>;
	requiredDocuments: Array<{ kind: string; reason: string }>;
	reusableDocuments: Array<{
		customerDocumentId: string;
		kind: string;
		periodEnd: string | null;
		documentDate: string | null;
	}>;
	prefill: { reused: string[]; edited: string[]; unconfirmed: string[] };
	kyc: { status: string | null; expiresAt: string | null };
}

export function fetchRequirements(applicationId: string): Promise<RequirementsResponse> {
	return api<RequirementsResponse>(`/api/applications/${applicationId}/requirements`);
}

export function createDraft(
	body: unknown,
	idempotencyKey: string,
): Promise<{ id: string; reference: string }> {
	return api<{ id: string; reference: string }>("/api/applications/drafts", {
		method: "POST",
		body,
		headers: { "Idempotency-Key": idempotencyKey },
	});
}

export function submitDraft(
	applicationId: string,
	idempotencyKey: string,
): Promise<{ id: string; reference: string }> {
	return api<{ id: string; reference: string }>(`/api/applications/${applicationId}/submit`, {
		method: "POST",
		body: {},
		headers: { "Idempotency-Key": idempotencyKey },
	});
}

export function reuseCustomerDocuments(
	applicationId: string,
	customerDocumentIds: string[],
	kind?: string,
): Promise<{ files: DocumentFile[] }> {
	return api<{ files: DocumentFile[] }>(`/api/applications/${applicationId}/documents/reuse`, {
		method: "POST",
		body: kind === undefined ? { customerDocumentIds } : { customerDocumentIds, kind },
	});
}
