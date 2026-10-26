// E2/EN-05 integration (real Postgres, fake OCR/scanner/agent).
//
// Covers fingerprint persistence, panel access, async analysis + candidate
// confirmation, manual flag + combined extraction/brief run, assigned-officer
// resolution, cross-application duplicate lookup, and no decision mutation.

import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applications,
	documentFieldCandidates,
	documentFiles,
	documentFingerprints,
	documentIntegrityRuns,
	fraudReviews,
	generatedArtifacts,
} from "@credit/db/applications";
import { createLogger } from "@credit/service-kit";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtractionResult, OcrAdapter } from "../../src/documents/ocr.js";
import type { ScannerAdapter } from "../../src/documents/scanner.js";
import { runDocumentRetention } from "../../src/documents/retention.js";
import { drainIntegrityRuns } from "../../src/integrity/runs.js";
import type { IntegrityAgentRunner, IntegrityConfig } from "../../src/integrity/types.js";
import {
	createUser,
	individualPayload,
	multipart,
	pdfBytes,
	postApplication,
	setupApp,
	signed,
	type TestContext,
	type TestUser,
} from "../helper.js";
import { caseAccessGrants } from "@credit/db/applications";

process.env.LOG_LEVEL ??= "silent";

const ENCRYPTION_KEY = randomBytes(32).toString("base64");
const OCR_TEXT =
	"BANK STATEMENT\nAccount Holder: ACME PTE LTD\nStatement Period: 1 May 2026 to 31 May 2026\nTotal Amount: SGD 12,000.00";

const READY: ExtractionResult = {
	status: "ready",
	pages: [{ text: OCR_TEXT, source: "ocr", confidence: 0.95 }],
	textLayerRisk: false,
};

const integrityConfig: IntegrityConfig = {
	enabled: true,
	fraudReviewEnabled: true,
	agentEnabled: true,
	triageEnabled: true,
	model: "stub-integrity",
	promptVersion: "integrity-analysis-test",
	agentVersion: "integrity-agent-test",
	triagePromptVersion: "integrity-triage-test",
	maxSteps: 10,
	maxToolCalls: 10,
	timeoutMs: 5_000,
	maxCostUsd: 1,
	maxOutputTokens: 2_000,
	flagSeverity: "high",
	retentionDays: 365,
	systemUserId: randomUUID(),
	maxRunsPerHash: 3,
	openRouterApiKey: null,
	openRouterBaseUrl: "https://openrouter.ai/api/v1",
};

let calls: string[] = [];

function fakeRunner(): IntegrityAgentRunner {
	return {
		async run(input) {
			calls.push(input.generateBrief ? "triage" : "analysis");
			const doc = input.source.documents[0];
			if (!doc) throw new Error("no document");
			const page = doc.pages[0];
			if (!page) throw new Error("no page");
			const heading = page.text.split("\n")[0] ?? page.text;
			const toolCalls = [
				{
					step: 1,
					name: "get_page",
					resultCount: 1,
					sourceTypes: ["document"],
					refs: [`document:${doc.documentFileId}:p${page.pageNumber}:0-${heading.length}`],
				},
			];
			const candidates = [
				{
					documentFileId: doc.documentFileId,
					field: "document_type" as const,
					value: "bank_statement",
					pageNumber: page.pageNumber,
					quote: heading,
					confidence: 0.9,
				},
				{
					documentFileId: doc.documentFileId,
					field: "material_amount" as const,
					value: "SGD 12,000.00",
					pageNumber: page.pageNumber,
					quote: "Total Amount: SGD 12,000.00",
					confidence: 0.9,
				},
			];
			const brief = input.generateBrief
				? {
						title: "Document integrity triage",
						summary: {
							text: "One document page is available for review.",
							citations: [
								{
									kind: "document",
									documentFileId: doc.documentFileId,
									pageNumber: page.pageNumber,
									quote: heading,
								},
							],
						},
						candidateContradictions: [],
						missingEvidence: [],
						alternativeExplanations: [],
						questionsForReviewer: ["Could the reviewer confirm the statement period?"],
						suggestedPriority: "medium",
					}
				: undefined;
			return {
				rawOutput: JSON.stringify({
					candidates,
					consistency: [],
					...(brief ? { brief } : {}),
				}),
				toolCalls,
				sourceRefs: toolCalls[0]?.refs ?? [],
				steps: 2,
				usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.0001 },
			};
		},
	};
}

const cleanScanner: ScannerAdapter = {
	async scan() {
		return "clean";
	},
};

const fakeOcr: OcrAdapter = {
	async extractPdf() {
		return structuredClone(READY);
	},
	async extractImage() {
		return structuredClone(READY);
	},
};

let ctx: TestContext;
let storageDir: string;
let runner = fakeRunner();

function setupIntegrity(overrides: Partial<IntegrityConfig> = {}): TestContext {
	return setupApp({
		storageDir,
		documents: {
			config: {
				featureEnabled: true,
				encryptionKey: ENCRYPTION_KEY,
				keyId: "v1",
			},
			scanner: cleanScanner,
			ocr: fakeOcr,
		},
		integrity: {
			config: { ...integrityConfig, ...overrides },
			agentRunner: runner,
		},
	});
}

function runDeps(context: TestContext, config: Partial<IntegrityConfig> = {}) {
	return {
		db: context.db,
		config: { ...integrityConfig, ...config },
		runner,
		logger: createLogger("integrity-test"),
	};
}

async function newCase(): Promise<{ appId: string; owner: TestUser; officer: TestUser }> {
	const owner = await createUser(ctx);
	const officer = await createUser(ctx, "officer");
	const res = await postApplication(ctx, owner, "/api/applications", {
		...individualPayload(owner.email),
		documentProcessingConsent: true,
	});
	expect(res.status).toBe(201);
	const appId = ((await res.json()) as { id: string }).id;
	await ctx.db.insert(caseAccessGrants).values({
		applicationId: appId,
		userId: officer.id,
		accessRole: "assigned_officer",
	});
	return { appId, owner, officer };
}

async function upload(
	officer: TestUser,
	appId: string,
	tag = "integrity",
	bytes: Buffer = pdfBytes(tag),
): Promise<Response> {
	const boundary = `----integrity${randomUUID().replace(/-/g, "")}`;
	const body = multipart(boundary, [
		{ name: "kind", data: "bank_statement" },
		{ name: "file", filename: "statement.pdf", contentType: "application/pdf", data: bytes },
	]);
	const path = `/api/applications/${appId}/documents`;
	return ctx.app.request(path, {
		method: "POST",
		headers: {
			"content-type": `multipart/form-data; boundary=${boundary}`,
			...signed(ctx, officer, "POST", path, {}, body),
		},
		body,
	});
}

async function api(
	user: TestUser,
	method: string,
	path: string,
	body?: unknown,
): Promise<Response> {
	const raw = body === undefined ? undefined : JSON.stringify(body);
	return ctx.app.request(path, {
		method,
		headers: {
			...(raw === undefined ? {} : { "content-type": "application/json" }),
			...signed(ctx, user, method, path, {}, raw),
		},
		...(raw === undefined ? {} : { body: raw }),
	});
}

async function waitRun(runId: string): Promise<void> {
	for (let i = 0; i < 40; i++) {
		const [run] = await ctx.db
			.select()
			.from(documentIntegrityRuns)
			.where(eq(documentIntegrityRuns.id, runId));
		if (run && ["succeeded", "failed", "cancelled"].includes(run.status)) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("run did not finish");
}

beforeAll(async () => {
	storageDir = await mkdtemp(join(tmpdir(), "integrity-int-"));
	ctx = setupIntegrity();
});

afterAll(async () => {
	await rm(storageDir, { recursive: true, force: true });
	await ctx.sql.end();
});

describe("document integrity", () => {
	it("writes a text-free fingerprint and exposes the panel", async () => {
		const { appId, owner, officer } = await newCase();
		expect((await upload(officer, appId)).status).toBe(201);
		const [fingerprint] = await ctx.db
			.select()
			.from(documentFingerprints)
			.where(eq(documentFingerprints.applicationId, appId));
		expect(fingerprint).toBeDefined();
		expect(fingerprint?.producer).toBe("unknown");
		expect(fingerprint?.metadataSource).toBe("unknown");
		expect(fingerprint?.pageCount).toBe(1);
		expect(JSON.stringify(fingerprint)).not.toContain("BANK STATEMENT");
		expect(JSON.stringify(fingerprint)).not.toContain("statement.pdf");

		const panel = await api(officer, "GET", `/api/applications/${appId}/integrity`);
		expect(panel.status).toBe(200);
		expect(panel.headers.get("cache-control")).toBe("no-store");
		const body = (await panel.json()) as {
			panel: { documents: Array<{ fingerprint: { sha256: string } | null }> };
		};
		expect(body.panel.documents).toHaveLength(1);
		expect(body.panel.documents[0]?.fingerprint?.sha256).toMatch(/^[a-f0-9]{64}$/);

		expect((await api(owner, "GET", `/api/applications/${appId}/integrity`)).status).toBe(403);
		const stranger = await createUser(ctx, "officer");
		expect((await api(stranger, "GET", `/api/applications/${appId}/integrity`)).status).toBe(404);
	});

	it("runs analysis, validates candidates, and confirms one", async () => {
		calls = [];
		const { appId, officer } = await newCase();
		expect((await upload(officer, appId, "analysis")).status).toBe(201);

		const queued = await api(officer, "POST", `/api/applications/${appId}/integrity/analyses`);
		expect(queued.status).toBe(202);
		const { run } = (await queued.json()) as { run: { id: string } };
		await drainIntegrityRuns(runDeps(ctx));
		await waitRun(run.id);
		expect(calls).toContain("analysis");

		const panel = await api(officer, "GET", `/api/applications/${appId}/integrity`);
		const body = (await panel.json()) as {
			panel: {
				documents: Array<{
					candidates: Array<{ id: string; field: string; status: string }>;
				}>;
				latestAnalysis: { model: string; toolCalls: unknown[] } | null;
			};
		};
		const candidates = body.panel.documents[0]?.candidates ?? [];
		expect(candidates.map((item) => item.field).sort()).toEqual([
			"document_type",
			"material_amount",
		]);
		expect(candidates.every((item) => item.status === "validated")).toBe(true);
		expect(body.panel.latestAnalysis?.model).toBe("stub-integrity");
		expect(body.panel.latestAnalysis?.toolCalls.length).toBe(1);

		const candidate = candidates.find((item) => item.field === "material_amount")!;
		const confirmed = await api(
			officer,
			"PATCH",
			`/api/applications/${appId}/integrity/candidates/${candidate.id}`,
			{ action: "confirm" },
		);
		expect(confirmed.status).toBe(200);
		const [row] = await ctx.db
			.select()
			.from(documentFieldCandidates)
			.where(eq(documentFieldCandidates.id, candidate.id));
		expect(row?.status).toBe("confirmed");
	});

	it("flags, triages, and resolves without changing the application", async () => {
		calls = [];
		const { appId, owner, officer } = await newCase();
		expect((await upload(officer, appId, "triage")).status).toBe(201);
		const before = await ctx.db.select().from(applications).where(eq(applications.id, appId));
		const statusBefore = before[0]?.status;

		const flagged = await api(officer, "POST", `/api/applications/${appId}/integrity/flags`, {
			reasonCode: "document_integrity",
			note: "Manual integrity review requested for the statement set.",
			severity: "high",
		});
		expect(flagged.status).toBe(200);
		const { review } = (await flagged.json()) as { review: { id: string; version: number } };

		// The combined extraction+brief run is queued by the flag route.
		await drainIntegrityRuns(runDeps(ctx));
		for (let i = 0; i < 40; i++) {
			const [row] = await ctx.db
				.select()
				.from(documentIntegrityRuns)
				.where(
					and(
						eq(documentIntegrityRuns.fraudReviewId, review.id),
						eq(documentIntegrityRuns.feature, "document_analysis"),
					),
				);
			if (row && ["succeeded", "failed", "cancelled"].includes(row.status)) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(calls).toContain("triage");

		const queue = await api(officer, "GET", "/api/fraud-review/queue");
		const queueBody = (await queue.json()) as {
			items: Array<{ id: string; briefState: string }>;
		};
		expect(queueBody.items.find((item) => item.id === review.id)?.briefState).toBe("ready");

		const detail = await api(officer, "GET", `/api/fraud-review/${review.id}`);
		expect(detail.status).toBe(200);
		const detailBody = (await detail.json()) as {
			review: { brief: { content: unknown } | null; status: string };
		};
		expect(detailBody.review.brief).not.toBeNull();
		expect(detailBody.review.status).toBe("open");

		const resolved = await api(officer, "POST", `/api/fraud-review/${review.id}/resolve`, {
			status: "cleared",
			note: "Reviewed the statement and the cited page; no further action.",
			expectedVersion: review.version,
		});
		expect(resolved.status).toBe(200);
		const resolvedBody = (await resolved.json()) as { decisionPath: string };
		expect(resolvedBody.decisionPath).toBe(`/officer/review/${appId}`);

		const after = await ctx.db.select().from(applications).where(eq(applications.id, appId));
		expect(after[0]?.status).toBe(statusBefore);
		const [artifact] = await ctx.db
			.select()
			.from(generatedArtifacts)
			.where(
				and(
					eq(generatedArtifacts.applicationId, appId),
					eq(generatedArtifacts.type, "document_integrity_brief"),
				),
			);
		expect(artifact?.status).toBe("draft");

		// Withdrawing document consent hides the cited brief from the officer
		// even though the item row remains for audit.
		const withdrawn = await api(owner, "PATCH", `/api/applications/${appId}/document-consent`, {
			consent: false,
		});
		expect(withdrawn.status).toBe(200);
		const hidden = await api(officer, "GET", `/api/fraud-review/${review.id}`);
		expect(hidden.status).toBe(200);
		const hiddenBody = (await hidden.json()) as {
			review: { brief: unknown; briefUnavailable: string | null };
		};
		expect(hiddenBody.review.brief).toBeNull();
		expect(hiddenBody.review.briefUnavailable).toBe("consent_withdrawn");
	});

	it("blocks document retention while a review is active, then redacts", async () => {
		const { appId, officer } = await newCase();
		expect((await upload(officer, appId, "retention")).status).toBe(201);
		const flagged = await api(officer, "POST", `/api/applications/${appId}/integrity/flags`, {
			reasonCode: "document_integrity",
			note: "Retention interaction check for the statement.",
			severity: "high",
		});
		expect(flagged.status).toBe(200);
		const { review } = (await flagged.json()) as { review: { id: string } };
		await ctx.db
			.update(documentFiles)
			.set({ retentionUntil: new Date(Date.now() - 1_000) })
			.where(eq(documentFiles.applicationId, appId));
		const retained = await runDocumentRetention({
			db: ctx.db,
			lockTimeoutMs: 5_000,
			storageDir,
			applicationId: appId,
			fraudReviewEnabled: true,
		});
		expect(retained.deletedFiles).toBe(0);
		await ctx.db
			.update(fraudReviews)
			.set({ status: "cleared", resolvedAt: new Date() })
			.where(eq(fraudReviews.id, review.id));
		const swept = await runDocumentRetention({
			db: ctx.db,
			lockTimeoutMs: 5_000,
			storageDir,
			applicationId: appId,
			fraudReviewEnabled: true,
		});
		expect(swept.deletedFiles).toBe(1);
		const [fingerprint] = await ctx.db
			.select()
			.from(documentFingerprints)
			.where(eq(documentFingerprints.applicationId, appId));
		expect(fingerprint?.redactedAt).not.toBeNull();
	});

	it("scopes duplicate lookup to the assigned officer and returns no PII", async () => {
		const first = await newCase();
		const second = await newCase();
		const shared = pdfBytes("same-bytes");
		expect((await upload(first.officer, first.appId, "same-bytes", shared)).status).toBe(201);
		expect((await upload(second.officer, second.appId, "same-bytes", shared)).status).toBe(201);
		const [fp] = await ctx.db
			.select()
			.from(documentFingerprints)
			.where(eq(documentFingerprints.applicationId, first.appId));
		expect(fp).toBeDefined();

		const lookup = await api(first.officer, "POST", "/api/fraud-review/duplicates/lookup", {
			sha256: fp!.sha256,
			applicationId: first.appId,
		});
		expect(lookup.status).toBe(200);
		const body = (await lookup.json()) as {
			rows: Array<{ applicationReference: string }>;
			counts: { crossApplicant: number };
		};
		expect(body.rows.length).toBeGreaterThanOrEqual(2);
		expect(body.counts.crossApplicant).toBeGreaterThanOrEqual(1);
		expect(JSON.stringify(body)).not.toContain("Svc Applicant");

		const applicantLookup = await api(first.owner, "POST", "/api/fraud-review/duplicates/lookup", {
			sha256: fp!.sha256,
		});
		expect(applicantLookup.status).toBe(403);
	});

	it("creates a fraud item from a deterministic crosscheck mismatch", async () => {
		const { appId, officer } = await newCase();
		expect((await upload(officer, appId, "crosscheck")).status).toBe(201);
		const before = await ctx.db.select().from(applications).where(eq(applications.id, appId));
		const path = `/api/applications/${appId}/documents/crosscheck`;
		const crosscheck = await ctx.app.request(path, {
			method: "POST",
			headers: signed(ctx, officer, "POST", path),
		});
		expect(crosscheck.status).toBe(200);
		const [review] = await ctx.db
			.select()
			.from(fraudReviews)
			.where(eq(fraudReviews.applicationId, appId));
		expect(review).toBeDefined();
		expect(review?.status).toBe("open");
		expect(review?.severity).toBe("high");
		expect(review?.signalCodes).toContain("crosscheck_mismatch");
		const after = await ctx.db.select().from(applications).where(eq(applications.id, appId));
		expect(after[0]?.status).toBe(before[0]?.status);
	});

	it("hides fraud routes while the fraud flag is off", async () => {
		const off = setupIntegrity({ fraudReviewEnabled: false });
		const owner = await createUser(off);
		const officer = await createUser(off, "officer");
		const queue = await off.app.request("/api/fraud-review/queue", {
			method: "GET",
			headers: signed(off, officer, "GET", "/api/fraud-review/queue"),
		});
		expect(queue.status).toBe(404);
		const applicant = await off.app.request("/api/fraud-review/queue", {
			method: "GET",
			headers: signed(off, owner, "GET", "/api/fraud-review/queue"),
		});
		expect(applicant.status).toBe(403);
		await off.sql.end();
	});

	it("hides routes while the feature flag is off", async () => {
		const off = setupIntegrity({ enabled: false });
		const owner = await createUser(off);
		const officer = await createUser(off, "officer");
		const res = await postApplication(off, owner, "/api/applications", {
			...individualPayload(owner.email),
			documentProcessingConsent: true,
		});
		const appId = ((await res.json()) as { id: string }).id;
		await off.db.insert(caseAccessGrants).values({
			applicationId: appId,
			userId: officer.id,
			accessRole: "assigned_officer",
		});
		const panel = await off.app.request(`/api/applications/${appId}/integrity`, {
			method: "GET",
			headers: signed(off, officer, "GET", `/api/applications/${appId}/integrity`),
		});
		expect(panel.status).toBe(404);
		await off.sql.end();
	});
});
