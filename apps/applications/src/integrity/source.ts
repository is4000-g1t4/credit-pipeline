// US-INT-1/2/3 bounded source snapshot.
//
// One read assembles the case documents, same-customer evidence (brief runs
// only), the latest succeeded deterministic cross-check, fingerprints,
// duplicates, and deterministic signals. Tools read this snapshot only; they
// never accept a model-supplied id that is not in the map. Page text is capped
// and never logged or traced.

import {
	applications,
	customerDocumentPages,
	customerDocuments,
	customerLegalHolds,
	customerProfiles,
	documentConsistencyCandidates,
	documentCrosschecks,
	documentFiles,
	documentFindings,
	documentFingerprints,
	documentIntegrityRuns,
	documentPages,
} from "@credit/db/applications";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@credit/db/applications";
import { HttpError } from "@credit/service-kit";
import { sha256Hex } from "../documents/crypto.js";
import type { OcrStatus, TextSource } from "../documents/ocr.js";
import type { DocumentKind } from "../documents/pipeline.js";
import { findDuplicateMatches } from "./duplicates.js";
import { buildIntegritySignals } from "./signals.js";
import { quoteMatchesOffset } from "./validators.js";
import type {
	DeterministicSignal,
	IntegrityCrosscheckFinding,
	IntegrityCustomerDocument,
	IntegrityDocumentSnapshot,
	IntegrityPage,
	IntegritySource,
	IntegrityUnavailableSource,
} from "./types.js";

const MAX_DOCUMENTS = 20;
const MAX_PAGES_PER_DOCUMENT = 20;
const MAX_CUSTOMER_DOCUMENTS = 10;
const MAX_CUSTOMER_PAGES_PER_DOCUMENT = 10;
const MAX_PAGE_CHARS = 262_144;
const MAX_TOTAL_CHARS = 2_097_152;

export interface LoadIntegritySourceOptions {
	includeCustomerEvidence: boolean;
	now?: Date;
	minOcrConfidence?: number;
}

function capText(text: string): string {
	return text.length > MAX_PAGE_CHARS ? text.slice(0, MAX_PAGE_CHARS) : text;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function stringValue(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function pageRows(
	rows: Array<{
		pageNumber: number;
		text: string;
		source: TextSource;
		confidence: number;
		textSha256: string;
	}>,
	limit: number,
	budget: { remaining: number },
): IntegrityPage[] {
	const pages: IntegrityPage[] = [];
	for (const row of rows.slice(0, limit)) {
		const text = capText(row.text);
		if (budget.remaining <= 0) break;
		const sliced = text.slice(0, budget.remaining);
		budget.remaining -= sliced.length;
		pages.push({
			pageNumber: row.pageNumber,
			text: sliced,
			source: row.source,
			confidence: row.confidence,
			textSha256: row.textSha256,
		});
		if (sliced.length < text.length) break;
	}
	return pages;
}

function sortPages<T extends { pageNumber: number }>(rows: T[]): T[] {
	return [...rows].sort((a, b) => a.pageNumber - b.pageNumber);
}

export async function loadIntegritySource(
	db: Db,
	applicationId: string,
	options: LoadIntegritySourceOptions,
): Promise<IntegritySource> {
	const now = options.now ?? new Date();
	const [application] = await db
		.select()
		.from(applications)
		.where(eq(applications.id, applicationId))
		.limit(1);
	if (!application) throw new HttpError(404, "NOT_FOUND", "not found");

	const unavailable: IntegrityUnavailableSource[] = [];
	const documentRows = await db
		.select()
		.from(documentFiles)
		.where(eq(documentFiles.applicationId, applicationId))
		.orderBy(desc(documentFiles.uploadedAt))
		.limit(MAX_DOCUMENTS + 20);

	const readableRows = documentRows.filter((row) => {
		if (row.status !== "ready") {
			unavailable.push({ code: "missing", label: `document ${row.kind}` });
			return false;
		}
		if (
			!application.documentProcessingConsent ||
			row.blobPurgedAt !== null ||
			row.retentionUntil.getTime() <= now.getTime()
		) {
			unavailable.push({
				code: application.documentProcessingConsent ? "retention_expired" : "access_denied",
				label: `document ${row.kind}`,
			});
			return false;
		}
		return true;
	});
	const selected = readableRows.slice(0, MAX_DOCUMENTS);
	if (readableRows.length > selected.length) {
		unavailable.push({
			code: "unavailable",
			label: "additional documents omitted from the snapshot",
		});
	}

	const budget = { remaining: MAX_TOTAL_CHARS };
	const pagesByDocument = new Map<string, IntegrityPage[]>();
	if (selected.length > 0) {
		const pageRowsAll = await db
			.select()
			.from(documentPages)
			.where(
				inArray(
					documentPages.documentFileId,
					selected.map((row) => row.id),
				),
			)
			.orderBy(documentPages.documentFileId, documentPages.pageNumber);
		for (const row of pageRowsAll) {
			const list = pagesByDocument.get(row.documentFileId) ?? [];
			list.push({
				pageNumber: row.pageNumber,
				text: row.text,
				source: row.textSource,
				confidence: row.confidence,
				textSha256: row.textSha256,
			});
			pagesByDocument.set(row.documentFileId, list);
		}
	}

	const fingerprintRows =
		selected.length === 0
			? []
			: await db
					.select()
					.from(documentFingerprints)
					.where(
						inArray(
							documentFingerprints.documentFileId,
							selected.map((row) => row.id),
						),
					);
	const fingerprints = new Map(fingerprintRows.map((row) => [row.documentFileId, row]));

	const documents: IntegrityDocumentSnapshot[] = selected.map((row) => {
		const rawPages = sortPages(pagesByDocument.get(row.id) ?? []).slice(0, MAX_PAGES_PER_DOCUMENT);
		const pages = pageRows(rawPages, MAX_PAGES_PER_DOCUMENT, budget);
		if (
			rawPages.length > pages.length ||
			pages.some((page) => page.text.length >= MAX_PAGE_CHARS)
		) {
			unavailable.push({
				code: "unavailable",
				label: `document ${row.kind} pages were truncated`,
			});
		}
		return {
			documentFileId: row.id,
			kind: row.kind as DocumentKind,
			pageCount: row.pageCount,
			ocrStatus: row.ocrStatus as OcrStatus,
			textLayerRisk: row.textLayerRisk,
			sha256: row.sha256,
			sizeBytes: row.sizeBytes,
			mimeType: row.mimeType,
			ocrConfidence: row.ocrConfidence,
			documentDate: row.documentDate,
			periodEnd: row.periodEnd,
			source: row.source,
			uploadedAt: row.uploadedAt,
			pages,
			readable: true,
		};
	});

	// Latest succeeded cross-check only. A later failed/redacted run never hides
	// an earlier succeeded mismatch.
	const [crosscheck] = await db
		.select()
		.from(documentCrosschecks)
		.where(
			and(
				eq(documentCrosschecks.applicationId, applicationId),
				eq(documentCrosschecks.status, "succeeded"),
			),
		)
		.orderBy(desc(documentCrosschecks.startedAt))
		.limit(1);

	let crosscheckFindings: IntegrityCrosscheckFinding[] | null = null;
	if (crosscheck) {
		const findings = await db
			.select()
			.from(documentFindings)
			.where(eq(documentFindings.crosscheckId, crosscheck.id))
			.orderBy(documentFindings.createdAt);
		const pageText = new Map<string, Map<number, string>>();
		for (const doc of documents) {
			pageText.set(doc.documentFileId, new Map(doc.pages.map((p) => [p.pageNumber, p.text])));
		}
		crosscheckFindings = [];
		for (const finding of findings) {
			if (
				finding.status === "mismatch" &&
				finding.documentFileId &&
				finding.pageNumber !== null &&
				finding.quote !== null &&
				finding.quoteStart !== null &&
				finding.quoteEnd !== null &&
				finding.quoteHash !== null
			) {
				const text = pageText.get(finding.documentFileId)?.get(finding.pageNumber);
				if (
					text === undefined ||
					!quoteMatchesOffset(text, finding.quoteStart, finding.quoteEnd, finding.quote) ||
					sha256Hex(Buffer.from(finding.quote, "utf8")) !== finding.quoteHash
				) {
					continue;
				}
			}
			crosscheckFindings.push({
				id: finding.id,
				field: finding.field,
				status: finding.status,
				confidence: finding.confidence,
				expected: finding.expected,
				observed: finding.observed,
				documentFileId: finding.documentFileId,
				pageNumber: finding.pageNumber,
				quote: finding.quote,
				quoteStart: finding.quoteStart,
				quoteEnd: finding.quoteEnd,
				quoteHash: finding.quoteHash,
				reason: finding.reason,
			});
		}
	} else {
		unavailable.push({ code: "missing", label: "deterministic cross-check" });
	}

	const [latestAnalysis] = await db
		.select({ id: documentIntegrityRuns.id })
		.from(documentIntegrityRuns)
		.where(
			and(
				eq(documentIntegrityRuns.applicationId, applicationId),
				eq(documentIntegrityRuns.feature, "document_analysis"),
				eq(documentIntegrityRuns.status, "succeeded"),
			),
		)
		.orderBy(desc(documentIntegrityRuns.createdAt))
		.limit(1);
	let unconfirmedConsistencyCount = 0;
	if (latestAnalysis) {
		const consistency = await db
			.select({ id: documentConsistencyCandidates.id })
			.from(documentConsistencyCandidates)
			.where(
				and(
					eq(documentConsistencyCandidates.runId, latestAnalysis.id),
					eq(documentConsistencyCandidates.status, "candidate"),
					eq(documentConsistencyCandidates.proposedKind, "mismatch"),
				),
			);
		unconfirmedConsistencyCount = consistency.length;
	}

	const duplicateMatches = await findDuplicateMatches(
		db,
		documents.map((doc) => ({ documentFileId: doc.documentFileId, sha256: doc.sha256 })),
		applicationId,
		application.applicantUserId,
		now,
	);
	const sameApplicationIds = new Set<string>();
	const sameApplicantIds = new Set<string>();
	const crossApplicantIds = new Set<string>();
	for (const match of duplicateMatches) {
		if (match.relation === "same_application") sameApplicationIds.add(match.matchingDocumentFileId);
		else if (match.relation === "same_applicant")
			sameApplicantIds.add(match.matchingDocumentFileId);
		else crossApplicantIds.add(match.matchingDocumentFileId);
	}
	const duplicateCounts = {
		sameApplication: sameApplicationIds.size,
		sameApplicantOther: sameApplicantIds.size,
		crossApplicant: crossApplicantIds.size,
	};

	const signals = buildIntegritySignals({
		documents: documents.map((doc) => ({
			documentFileId: doc.documentFileId,
			textLayerRisk: doc.textLayerRisk,
			ocrStatus: doc.ocrStatus,
			ocrConfidence: doc.ocrConfidence,
			editSignal: fingerprints.get(doc.documentFileId)?.editSignal ?? "unknown",
			editCodes: fingerprints.get(doc.documentFileId)?.editCodes ?? [],
		})),
		crosscheckFindings,
		duplicateCounts,
		unconfirmedConsistencyCount,
		minOcrConfidence: options.minOcrConfidence ?? 0.7,
	});

	const identity = asRecord(application.identity);
	const business = asRecord(application.business);
	const caseFacts: IntegritySource["caseFacts"] = [];
	const pushFact = (field: string, label: string, value: string | null): void => {
		if (value !== null && value !== "") caseFacts.push({ field, label, value });
	};
	pushFact("applicationReference", "application reference", application.reference);
	pushFact("applicantName", "applicant name", stringValue(identity, "fullName"));
	pushFact("companyName", "company name", stringValue(business, "companyName"));
	pushFact(
		"registrationNumber",
		"registration number",
		stringValue(business, "registrationNumber"),
	);
	pushFact("product", "product", application.product);
	if (application.amountCents !== null) {
		pushFact("requestedAmount", "requested amount", (application.amountCents / 100).toFixed(2));
	}
	pushFact("termMonths", "term months", String(application.termMonths));

	let customerProfileId: string | null = null;
	const customerDocumentsOut: IntegrityCustomerDocument[] = [];
	if (options.includeCustomerEvidence && application.contextAnalysisConsent) {
		const [profile] = await db
			.select()
			.from(customerProfiles)
			.where(eq(customerProfiles.userId, application.applicantUserId))
			.limit(1);
		if (profile) {
			customerProfileId = profile.id;
			const profileIdentity = asRecord(profile.identity);
			const profileBusiness = asRecord(profile.business);
			pushFact("customerSegment", "customer segment", profile.segment);
			pushFact("customerSince", "customer since", profile.customerSince);
			pushFact("kycStatus", "KYC status", profile.kycStatus);
			pushFact(
				"customerCompanyName",
				"customer company name",
				stringValue(profileBusiness, "companyName") ?? stringValue(profileIdentity, "companyName"),
			);
			pushFact(
				"customerRegistrationNumber",
				"customer registration number",
				stringValue(profileBusiness, "registrationNumber"),
			);

			const holds = await db
				.select()
				.from(customerLegalHolds)
				.where(
					and(eq(customerLegalHolds.customerId, profile.id), isNull(customerLegalHolds.releasedAt)),
				);
			const heldDocumentIds = new Set(
				holds.map((hold) => hold.customerDocumentId).filter((id): id is string => id !== null),
			);
			const allHeld = holds.some((hold) => hold.customerDocumentId === null);

			const customerDocRows = await db
				.select()
				.from(customerDocuments)
				.where(eq(customerDocuments.customerId, profile.id))
				.orderBy(desc(customerDocuments.uploadedAt))
				.limit(MAX_CUSTOMER_DOCUMENTS + 10);
			const visibleCustomerDocs = customerDocRows
				.filter(
					(row) =>
						row.status === "ready" &&
						row.blobPurgedAt === null &&
						row.retentionUntil.getTime() > now.getTime(),
				)
				.slice(0, MAX_CUSTOMER_DOCUMENTS);
			if (customerDocRows.length > visibleCustomerDocs.length) {
				unavailable.push({
					code: "unavailable",
					label: "additional customer documents omitted from the snapshot",
				});
			}

			const customerPages =
				visibleCustomerDocs.length === 0
					? []
					: await db
							.select()
							.from(customerDocumentPages)
							.where(
								inArray(
									customerDocumentPages.customerDocumentId,
									visibleCustomerDocs.map((row) => row.id),
								),
							)
							.orderBy(customerDocumentPages.customerDocumentId, customerDocumentPages.pageNumber);
			const customerPagesByDoc = new Map<string, IntegrityPage[]>();
			for (const row of customerPages) {
				const list = customerPagesByDoc.get(row.customerDocumentId) ?? [];
				list.push({
					pageNumber: row.pageNumber,
					text: row.text,
					source: row.textSource,
					confidence: row.confidence,
					textSha256: row.textSha256,
				});
				customerPagesByDoc.set(row.customerDocumentId, list);
			}
			for (const row of visibleCustomerDocs) {
				const held = allHeld || heldDocumentIds.has(row.id);
				customerDocumentsOut.push({
					customerDocumentId: row.id,
					kind: row.kind as DocumentKind,
					pageCount: row.pageCount,
					ocrStatus: row.ocrStatus as OcrStatus,
					sha256Prefix: row.sha256.slice(0, 16),
					documentDate: row.documentDate,
					periodEnd: row.periodEnd,
					readable: !held,
					pages: held
						? []
						: pageRows(
								sortPages(customerPagesByDoc.get(row.id) ?? []).slice(
									0,
									MAX_CUSTOMER_PAGES_PER_DOCUMENT,
								),
								MAX_CUSTOMER_PAGES_PER_DOCUMENT,
								budget,
							),
				});
			}
		} else {
			unavailable.push({ code: "missing", label: "customer profile" });
		}
	} else if (options.includeCustomerEvidence) {
		unavailable.push({ code: "access_denied", label: "customer evidence consent" });
	}

	return {
		applicationId: application.id,
		applicationReference: application.reference,
		applicationType: application.type,
		product: application.product,
		applicantUserId: application.applicantUserId,
		customerProfileId,
		documentConsent: application.documentProcessingConsent,
		contextConsent: application.contextAnalysisConsent,
		caseFacts,
		documents,
		customerDocuments: customerDocumentsOut,
		crosscheck: crosscheck ? { id: crosscheck.id, findings: crosscheckFindings ?? [] } : null,
		signals,
		duplicateCounts,
		duplicateMatches,
		unavailable,
		includeCustomerEvidence: options.includeCustomerEvidence,
	};
}

export type { DeterministicSignal };
