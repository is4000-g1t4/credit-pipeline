// EN-01 evidence bundle integration (real Postgres, no network): seeded
// case + score/policy/docs/hold rows with an injected research fetch —
// all six source types, stable refs, assignment gating, documents-off,
// research outage, and cross-case scoping with retention_expired.
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({
	path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

import { randomUUID } from "node:crypto";
import { createDb } from "@credit/db";
import {
	applications,
	documentConsistencyCandidates,
	documentCrosschecks,
	documentFieldCandidates,
	documentFiles,
	documentFingerprints,
	documentFindings,
	documentIntegrityRuns,
	documentLegalHolds,
	documentPages,
	fraudReviews,
	generatedArtifacts,
	policyEvaluations,
	scores,
} from "@credit/db/applications";
import { evidenceBundleSchema } from "@credit/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assembleCaseEvidence, type EvidenceDeps } from "../../src/assist/evidence.js";

process.env.LOG_LEVEL ??= "silent";

const db = createDb(
	process.env.APPLICATIONS_DATABASE_URL ??
		"postgres://credit:credit@localhost:5432/credit_applications",
).db;

const NOW = new Date("2026-06-30T00:00:00Z");
const QUOTE = "QUOTE-SENTINEL-46210 Acme Pte Ltd";
const RESEARCH_QUOTE = "RESEARCH-QUOTE-SENTINEL-77310 adverse finding text";
const POLICY_QUOTE = "POLICY-QUOTE-SENTINEL-88410 lending standard text";

const tracked = { applications: [] as string[] };

async function seedApplication(
	over: Partial<typeof applications.$inferSelect> = {},
): Promise<typeof applications.$inferSelect> {
	const [row] = await db
		.insert(applications)
		.values({
			reference: `EV-${randomUUID().slice(0, 8)}`,
			applicantUserId: randomUUID(),
			type: "sme",
			product: "sme_term_loan",
			status: "pending_review",
			amountCents: 5_000_000,
			termMonths: 36,
			purpose: "evidence integration",
			identity: { fullName: "Evidence Case", city: "Singapore" },
			financial: { monthlyIncomeCents: 420_000, existingDebtCents: 61_000 },
			business: {
				companyName: "Evidence Pte Ltd",
				registrationNumber: "EV2026001",
				industry: "retail",
				yearsTrading: 4,
				annualRevenueCents: 1_200_000,
			},
			consents: [true, true, true],
			submittedAt: new Date("2026-06-01T00:00:00Z"),
			...over,
		})
		.returning();
	tracked.applications.push(row.id);
	return row;
}

interface SeededCase {
	application: typeof applications.$inferSelect;
	scoreId: string;
	policyId: string;
	fileId: string;
	evidenceId: string;
	policyVersionId: string;
}

async function seedFullCase(): Promise<SeededCase> {
	const application = await seedApplication();
	const [score] = await db
		.insert(scores)
		.values({
			applicationId: application.id,
			modelVersion: "v1",
			score: 720,
			grade: "B",
			factors: [
				{ code: "AFFORDABILITY_OK", label: "Affordability ok", points: 12, impact: "positive" },
			],
			affordability: {},
		})
		.returning();
	const [policy] = await db
		.insert(policyEvaluations)
		.values({
			applicationId: application.id,
			policyVersion: "policy-v1",
			outcome: "pass",
			reasons: [{ code: "POLICY_OK", text: "within policy" }],
			maxAmountCents: 5_000_000,
			inputs: {},
			inputHash: "test",
		})
		.returning();
	const [file] = await db
		.insert(documentFiles)
		.values({
			applicationId: application.id,
			kind: "bank_statement",
			status: "ready",
			ocrStatus: "ready",
			mimeType: "application/pdf",
			sizeBytes: 64,
			sha256: `ev-${randomUUID()}`,
			keyId: "v1",
			cryptoVersion: "v1",
			uploadedBy: randomUUID(),
			retentionUntil: new Date("2027-01-01T00:00:00Z"),
		})
		.returning();
	await db.insert(documentPages).values({
		documentFileId: file.id,
		pageNumber: 1,
		text: `page carrying ${QUOTE} verbatim`,
		textSource: "pdf_text",
		confidence: 0.99,
		textSha256: "pagesha",
	});
	const [crosscheck] = await db
		.insert(documentCrosschecks)
		.values({
			applicationId: application.id,
			status: "succeeded",
			validatorVersion: "document-crosscheck-v1",
			documentsChecked: [file.id],
			findingCount: 1,
			requestedBy: randomUUID(),
		})
		.returning();
	await db.insert(documentFindings).values({
		crosscheckId: crosscheck.id,
		applicationId: application.id,
		documentFileId: file.id,
		field: "company_name",
		expected: "Evidence Pte Ltd",
		observed: "Evidence Pte Ltd",
		pageNumber: 1,
		quote: QUOTE,
		quoteStart: 0,
		quoteEnd: [...QUOTE].length,
		quoteHash: "qh",
		confidence: "high",
		status: "mismatch",
		reason: "seeded",
	});
	await db.insert(documentLegalHolds).values({
		applicationId: application.id,
		documentFileId: null,
		reason: "litigation",
		createdBy: randomUUID(),
	});
	return {
		application,
		scoreId: score.id,
		policyId: policy.id,
		fileId: file.id,
		evidenceId: randomUUID(),
		policyVersionId: randomUUID(),
	};
}

function researchBody(seeded: SeededCase): unknown {
	return {
		evidence: [
			{
				id: seeded.evidenceId,
				url: "https://example.com/article",
				finalUrl: "https://example.com/article",
				publisher: "Example News",
				quote: RESEARCH_QUOTE,
				sourceTier: "tier1",
			},
		],
		findings: [
			{
				id: randomUUID(),
				claim: "adverse media claim",
				category: "adverse_media",
				confidence: "high",
				evidenceIds: [seeded.evidenceId],
				evidence: [{ id: seeded.evidenceId, quote: RESEARCH_QUOTE }],
			},
		],
		context: {
			signals: [
				{
					type: "negative_balance",
					metric: "negative_eod_days",
					periodStart: "2025-12-30",
					periodEnd: "2026-06-30",
					accountScope: "all",
					observed: 3,
					expected: 0,
					confidence: "high",
					status: "review",
					policyVersion: "context-metrics-v1",
				},
			],
		},
		policy: {
			brief: {
				items: [
					{
						ref: "item-1",
						citations: [
							{
								policyKey: "CREDIT",
								policyVersionId: seeded.policyVersionId,
								sectionId: "s1",
								heading: "Lending standard",
								version: "v1",
								effectiveFrom: "2025-01-01",
								effectiveTo: null,
								quote: POLICY_QUOTE,
							},
						],
					},
				],
			},
		},
	};
}

function depsFor(
	application: typeof applications.$inferSelect,
	seeded: SeededCase | null,
	over: Partial<EvidenceDeps> = {},
): EvidenceDeps {
	return {
		db,
		application,
		officer: { id: randomUUID(), email: "officer@example.com", role: "officer" },
		assignedToMe: true,
		documentsEnabled: true,
		now: NOW,
		research: {
			url: "http://research.test",
			secret: "test-secret",
			timeoutMs: 1000,
			fetchImpl: (async () => Response.json(researchBody(seeded as SeededCase))) as typeof fetch,
		},
		...over,
	};
}

let seeded: SeededCase;

beforeAll(async () => {
	seeded = await seedFullCase();
});

afterAll(async () => {
	for (const id of tracked.applications) {
		await db.delete(documentFindings).where(eq(documentFindings.applicationId, id));
		await db.delete(documentCrosschecks).where(eq(documentCrosschecks.applicationId, id));
		await db.delete(documentPages).where(eq(documentPages.documentFileId, id));
		await db.delete(documentLegalHolds).where(eq(documentLegalHolds.applicationId, id));
		await db.delete(documentFieldCandidates).where(eq(documentFieldCandidates.applicationId, id));
		await db
			.delete(documentConsistencyCandidates)
			.where(eq(documentConsistencyCandidates.applicationId, id));
		await db.delete(fraudReviews).where(eq(fraudReviews.applicationId, id));
		await db.delete(documentIntegrityRuns).where(eq(documentIntegrityRuns.applicationId, id));
		await db.delete(generatedArtifacts).where(eq(generatedArtifacts.applicationId, id));
		await db.delete(documentFingerprints).where(eq(documentFingerprints.applicationId, id));
		await db.delete(documentFiles).where(eq(documentFiles.applicationId, id));
		await db.delete(scores).where(eq(scores.applicationId, id));
		await db.delete(policyEvaluations).where(eq(policyEvaluations.applicationId, id));
		await db.delete(applications).where(eq(applications.id, id));
	}
});

describe("assembleCaseEvidence", () => {
	it("bundles all six source types with stable refs, held document quote exact", async () => {
		const bundle = await assembleCaseEvidence(depsFor(seeded.application, seeded));
		expect(evidenceBundleSchema.safeParse(bundle).success).toBe(true);
		expect(new Set(bundle.items.map((item) => item.sourceType))).toEqual(
			new Set([
				"case_fact",
				"score_reason",
				"document",
				"context_signal",
				"external_evidence",
				"policy_section",
			]),
		);
		const again = await assembleCaseEvidence(depsFor(seeded.application, seeded));
		expect(again.items).toEqual(bundle.items);
		expect(again.unavailable).toEqual(bundle.unavailable);
		expect(again.assembledAt).toBe(bundle.assembledAt);

		const document = bundle.items.find((item) => item.content === QUOTE);
		expect(document).toMatchObject({
			sourceType: "document",
			label: "company_name mismatch",
			access: { legalHold: true },
		});
		expect(typeof document?.access.retentionUntil).toBe("string");
		expect(bundle.items.find((item) => item.content === RESEARCH_QUOTE)).toMatchObject({
			sourceType: "external_evidence",
		});
		expect(bundle.items.find((item) => item.content === POLICY_QUOTE)).toMatchObject({
			sourceType: "policy_section",
		});
		expect(
			bundle.items.filter((item) => item.sourceType === "score_reason").map((item) => item.content),
		).toEqual(expect.arrayContaining(["AFFORDABILITY_OK", "POLICY_OK"]));
		expect(bundle.asOf).toBe("2026-06-01T00:00:00.000Z");
	});

	it("keeps held expired documents and types rejected/unready files", async () => {
		await db
			.update(documentFiles)
			.set({ retentionUntil: new Date("2020-01-01T00:00:00Z") })
			.where(eq(documentFiles.id, seeded.fileId));
		const rejectedId = randomUUID();
		await db.insert(documentFiles).values({
			id: rejectedId,
			applicationId: seeded.application.id,
			kind: "payslip",
			status: "rejected",
			ocrStatus: "failed",
			mimeType: "application/pdf",
			sizeBytes: 64,
			sha256: `rejected-${randomUUID()}`,
			keyId: "v1",
			cryptoVersion: "v1",
			uploadedBy: randomUUID(),
			retentionUntil: new Date("2027-01-01T00:00:00Z"),
		});
		const bundle = await assembleCaseEvidence(depsFor(seeded.application, seeded));
		expect(bundle.items.find((item) => item.content === QUOTE)).toMatchObject({
			sourceType: "document",
			access: { legalHold: true },
		});
		expect(
			bundle.unavailable.some(
				(item) =>
					item.sourceType === "document" &&
					item.ref === `document:${rejectedId}:p1:0-1` &&
					item.code === "unavailable",
			),
		).toBe(true);
	});

	it("does not cite older findings when the latest crosscheck failed", async () => {
		await db.insert(documentCrosschecks).values({
			applicationId: seeded.application.id,
			status: "failed",
			validatorVersion: "document-crosscheck-v1",
			documentsChecked: [],
			findingCount: 0,
			requestedBy: randomUUID(),
			startedAt: new Date(Date.now() + 60_000),
			finishedAt: new Date(Date.now() + 61_000),
		});
		const bundle = await assembleCaseEvidence(depsFor(seeded.application, seeded));
		expect(bundle.items.some((item) => item.sourceType === "document")).toBe(false);
		expect(
			bundle.unavailable.some(
				(item) =>
					item.sourceType === "document" &&
					item.code === "unavailable" &&
					item.detail === "latest document crosscheck is not available",
			),
		).toBe(true);
	});

	it("denies document content without assignment but keeps case facts", async () => {
		const bundle = await assembleCaseEvidence(
			depsFor(seeded.application, seeded, { assignedToMe: false }),
		);
		expect(evidenceBundleSchema.safeParse(bundle).success).toBe(true);
		expect(bundle.items.some((item) => item.sourceType === "document")).toBe(false);
		expect(
			bundle.unavailable.some(
				(item) => item.sourceType === "document" && item.code === "access_denied",
			),
		).toBe(true);
		expect(bundle.items.some((item) => item.sourceType === "case_fact")).toBe(true);
	});

	it("marks documents unavailable when the feature is off", async () => {
		const bundle = await assembleCaseEvidence(
			depsFor(seeded.application, seeded, { documentsEnabled: false }),
		);
		expect(bundle.items.some((item) => item.sourceType === "document")).toBe(false);
		expect(
			bundle.unavailable.some(
				(item) =>
					item.sourceType === "document" &&
					item.code === "unavailable" &&
					item.detail === "documents disabled",
			),
		).toBe(true);
	});

	it("survives research 404 and transport failure with typed unavailability", async () => {
		const notFound = (async () => new Response("nope", { status: 404 })) as typeof fetch;
		const missing = await assembleCaseEvidence(
			depsFor(seeded.application, seeded, {
				research: {
					url: "http://research.test",
					secret: "s",
					timeoutMs: 1000,
					fetchImpl: notFound,
				},
			}),
		);
		expect(evidenceBundleSchema.safeParse(missing).success).toBe(true);
		expect(
			missing.unavailable.some(
				(item) => item.sourceType === "external_evidence" && item.code === "missing",
			),
		).toBe(true);
		expect(
			missing.unavailable.some(
				(item) => item.sourceType === "policy_section" && item.code === "missing",
			),
		).toBe(true);
		expect(missing.items.some((item) => item.sourceType === "case_fact")).toBe(true);

		const failing = (async () => {
			throw new Error("connection refused");
		}) as typeof fetch;
		const down = await assembleCaseEvidence(
			depsFor(seeded.application, seeded, {
				research: { url: "http://research.test", secret: "s", timeoutMs: 1000, fetchImpl: failing },
			}),
		);
		expect(evidenceBundleSchema.safeParse(down).success).toBe(true);
		expect(
			down.unavailable.some(
				(item) => item.sourceType === "external_evidence" && item.code === "unavailable",
			),
		).toBe(true);
		expect(down.items.some((item) => item.sourceType === "case_fact")).toBe(true);
	});

	it("types a missing context stage instead of dropping it", async () => {
		const body = { ...(researchBody(seeded) as Record<string, unknown>), context: null };
		const fetchImpl = (async () => Response.json(body)) as typeof fetch;
		const bundle = await assembleCaseEvidence(
			depsFor(seeded.application, seeded, {
				research: { url: "http://research.test", secret: "s", timeoutMs: 1000, fetchImpl },
			}),
		);
		expect(
			bundle.unavailable.some(
				(item) => item.sourceType === "context_signal" && item.code === "missing",
			),
		).toBe(true);
	});

	it("scopes refs per case and types deleted documents retention_expired", async () => {
		const other = await seedApplication();
		const [dead] = await db
			.insert(documentFiles)
			.values({
				applicationId: other.id,
				kind: "id",
				status: "deleted",
				ocrStatus: "ready",
				mimeType: "application/pdf",
				sizeBytes: 64,
				sha256: `dead-${randomUUID()}`,
				keyId: "v1",
				cryptoVersion: "v1",
				uploadedBy: randomUUID(),
				retentionUntil: new Date("2027-01-01T00:00:00Z"),
			})
			.returning();
		const [first, second] = await Promise.all([
			assembleCaseEvidence(depsFor(seeded.application, seeded)),
			assembleCaseEvidence(
				depsFor(other, null, { research: { url: null, secret: "s", timeoutMs: 1000 } }),
			),
		]);
		const firstRefs = new Set(first.items.map((item) => item.ref));
		for (const item of second.items) {
			expect(firstRefs.has(item.ref)).toBe(false);
		}
		for (const item of second.items.filter((entry) => entry.sourceType === "case_fact")) {
			expect(item.ref.startsWith(`case_fact:${other.id}:`)).toBe(true);
		}
		expect(
			second.unavailable.some(
				(item) =>
					item.sourceType === "document" &&
					item.code === "retention_expired" &&
					item.ref === `document:${dead.id}:p1:0-1`,
			),
		).toBe(true);
		expect(
			second.unavailable.some(
				(item) => item.sourceType === "score_reason" && item.code === "missing",
			),
		).toBe(true);
	});
});
