// EN-04 duplicate-hash lookup.
//
// Two surfaces, deliberately split:
// - countDuplicateDocuments: officer/system counts, no other-application refs.
// - findDuplicateDocuments: reviewer-only rows with internal application refs.
// Neither returns applicant names, emails, or document text.

import {
	applications,
	documentDuplicateExplanations,
	documentFiles,
	type Db,
} from "@credit/db/applications";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { IntegrityDuplicateCounts, IntegrityDuplicateMatch } from "./types.js";

export interface DuplicateDocumentRow {
	applicationId: string;
	reference: string;
	documentFileId: string;
	kind: string;
	uploadedAt: Date;
	explanationNote: string | null;
}

export async function countDuplicateDocuments(
	db: Db,
	sha256: string,
	applicationId: string,
	applicantUserId: string,
	now: Date = new Date(),
): Promise<IntegrityDuplicateCounts> {
	const rows = await db
		.select({
			applicationId: documentFiles.applicationId,
			applicantUserId: applications.applicantUserId,
			documentFileId: documentFiles.id,
		})
		.from(documentFiles)
		.innerJoin(applications, eq(applications.id, documentFiles.applicationId))
		.where(
			and(
				eq(documentFiles.sha256, sha256),
				eq(documentFiles.status, "ready"),
				gt(documentFiles.retentionUntil, now),
				isNull(documentFiles.blobPurgedAt),
				eq(applications.documentProcessingConsent, true),
			),
		);

	let sameApplication = 0;
	let sameApplicantOther = 0;
	let crossApplicant = 0;
	for (const row of rows) {
		if (row.applicantUserId !== applicantUserId) {
			crossApplicant += 1;
		} else if (row.applicationId === applicationId) {
			sameApplication += 1;
		} else {
			sameApplicantOther += 1;
		}
	}
	return {
		// The current row is included in its own application count.
		sameApplication: Math.max(0, sameApplication - 1),
		sameApplicantOther,
		crossApplicant,
	};
}

export async function findDuplicateDocuments(
	db: Db,
	sha256: string,
	now: Date = new Date(),
): Promise<DuplicateDocumentRow[]> {
	const rows = await db
		.select({
			applicationId: documentFiles.applicationId,
			reference: applications.reference,
			documentFileId: documentFiles.id,
			kind: documentFiles.kind,
			uploadedAt: documentFiles.uploadedAt,
			explanationNote: documentDuplicateExplanations.note,
		})
		.from(documentFiles)
		.innerJoin(applications, eq(applications.id, documentFiles.applicationId))
		.leftJoin(
			documentDuplicateExplanations,
			and(
				eq(documentDuplicateExplanations.applicationId, documentFiles.applicationId),
				eq(documentDuplicateExplanations.sha256, documentFiles.sha256),
				isNull(documentDuplicateExplanations.redactedAt),
			),
		)
		.where(
			and(
				eq(documentFiles.sha256, sha256),
				eq(documentFiles.status, "ready"),
				gt(documentFiles.retentionUntil, now),
				isNull(documentFiles.blobPurgedAt),
				eq(applications.documentProcessingConsent, true),
			),
		)
		.orderBy(sql`${documentFiles.uploadedAt} DESC`)
		.limit(50);
	return rows.map((row) => ({
		applicationId: row.applicationId,
		reference: row.reference,
		documentFileId: row.documentFileId,
		kind: row.kind,
		uploadedAt: row.uploadedAt,
		explanationNote: row.explanationNote ?? null,
	}));
}

/** Per-current-document duplicate matches. Used by the triage snapshot so the
 * agent can cite "matching document in another application" without ever
 * receiving an application reference or applicant identity. */
export async function findDuplicateMatches(
	db: Db,
	documents: Array<{ documentFileId: string; sha256: string }>,
	applicationId: string,
	applicantUserId: string,
	now: Date = new Date(),
): Promise<IntegrityDuplicateMatch[]> {
	if (documents.length === 0) return [];
	const hashes = [...new Set(documents.map((doc) => doc.sha256))];
	const rows = await db
		.select({
			applicationId: documentFiles.applicationId,
			applicantUserId: applications.applicantUserId,
			documentFileId: documentFiles.id,
			sha256: documentFiles.sha256,
			kind: documentFiles.kind,
		})
		.from(documentFiles)
		.innerJoin(applications, eq(applications.id, documentFiles.applicationId))
		.where(
			and(
				eq(documentFiles.status, "ready"),
				gt(documentFiles.retentionUntil, now),
				isNull(documentFiles.blobPurgedAt),
				eq(applications.documentProcessingConsent, true),
				inArray(documentFiles.sha256, hashes),
			),
		);

	const matches: IntegrityDuplicateMatch[] = [];
	for (const source of documents) {
		for (const row of rows) {
			if (row.sha256 !== source.sha256) continue;
			if (row.documentFileId === source.documentFileId) continue;
			const relation =
				row.applicationId === applicationId
					? "same_application"
					: row.applicantUserId === applicantUserId
						? "same_applicant"
						: "cross_applicant";
			matches.push({
				sourceDocumentFileId: source.documentFileId,
				matchingDocumentFileId: row.documentFileId,
				kind: row.kind,
				relation,
			});
		}
	}
	return matches;
}
