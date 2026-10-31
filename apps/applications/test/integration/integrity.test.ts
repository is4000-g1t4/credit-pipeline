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
	auditLog,
	documentFieldCandidates,
	documentFiles,
	documentFingerprints,
	documentIntegrityRuns,
	fraudReviews,
	generatedArtifacts,
} from "@credit/db/applications";
import { createAgentRunStarter, type AgentRunStarter } from "@credit/agent-kit/temporal/client";
import { createAgentWorker } from "@credit/agent-kit/temporal/worker";
import type { AgentRunInput } from "@credit/agent-kit/temporal/types";
import { createLogger } from "@credit/service-kit";
import { and, eq, lt } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtractionResult, OcrAdapter } from "../../src/documents/ocr.js";
import type { ScannerAdapter } from "../../src/documents/scanner.js";
import { runDocumentRetention } from "../../src/documents/retention.js";
import { createIntegrityActivities } from "../../src/integrity/activities.js";
import {
	claimIntegrityRunById,
	createIntegrityRun,
	executeIntegrityRun,
	failIntegrityRun,
	INTEGRITY_RUN_KIND,
	INTEGRITY_START_TIMEOUT_MS,
	IntegrityAttemptFailed,
	startIntegrityRun,
} from "../../src/integrity/runs.js";
import {
	integrityRunHorizonMs,
	SWEEP_ABANDON_AFTER_MS,
	sweepQueuedIntegrityRuns,
} from "../../src/integrity/sweep.js";
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

// Delegating starter: tests swap `startImpl` (record, throw, or real Temporal).
const startCalls: AgentRunInput[] = [];
let startImpl: AgentRunStarter["start"] = async (input) => {
	startCalls.push(input);
	return { started: true, workflowId: `${input.kind}:${input.runId}:${input.token}` };
};
const testStarter: AgentRunStarter = {
	start: (input) => startImpl(input),
	close: async () => {},
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
			starter: testStarter,
		},
	});
}

function runDeps(context: TestContext, config: Partial<IntegrityConfig> = {}) {
	return {
		db: context.db,
		config: { ...integrityConfig, ...config },
		runner,
		logger: createLogger("integrity-test"),
		starter: testStarter,
	};
}

/** Claims and executes one specific run, as the agent-worker activity does. */
async function executeRun(context: TestContext, runId: string): Promise<void> {
	const claim = await claimIntegrityRunById(runDeps(context), runId, 1);
	if (claim.kind !== "claimed") throw new Error(`run not claimable: ${claim.kind}`);
	await executeIntegrityRun(runDeps(context), claim.row);
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
		await executeRun(ctx, run.id);
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
		const [queuedRun] = await ctx.db
			.select()
			.from(documentIntegrityRuns)
			.where(eq(documentIntegrityRuns.fraudReviewId, review.id));
		expect(queuedRun?.status).toBe("queued");
		await executeRun(ctx, queuedRun!.id);
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

// --- Run dispatch: claim by id, fencing, cleanup, sweep, API start ---------

async function queueAnalysis(
	officer: TestUser,
	appId: string,
): Promise<{ status: number; runId: string }> {
	const res = await api(officer, "POST", `/api/applications/${appId}/integrity/analyses`);
	const body = (await res.json()) as { run: { id: string } };
	return { status: res.status, runId: body.run.id };
}

async function analysisCase(): Promise<{ appId: string; officer: TestUser; runId: string }> {
	const { appId, officer } = await newCase();
	expect((await upload(officer, appId, randomUUID())).status).toBe(201);
	const { status, runId } = await queueAnalysis(officer, appId);
	expect(status).toBe(202);
	return { appId, officer, runId };
}

async function runRow(runId: string) {
	const [row] = await ctx.db
		.select()
		.from(documentIntegrityRuns)
		.where(eq(documentIntegrityRuns.id, runId));
	return row!;
}

async function waitTerminal(runId: string, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const row = await runRow(runId);
		if (["succeeded", "failed", "cancelled"].includes(row.status)) return row;
		if (Date.now() > deadline) throw new Error(`run stuck in ${row.status}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/** Wraps a runner so its first call fails like a transient model error. */
function failingOnce(inner: IntegrityAgentRunner): IntegrityAgentRunner {
	let failed = false;
	return {
		async run(input) {
			if (!failed) {
				failed = true;
				throw new Error("upstream 503");
			}
			return inner.run(input);
		},
	};
}

async function failedAudits(appId: string) {
	return ctx.db
		.select()
		.from(auditLog)
		.where(
			and(eq(auditLog.applicationId, appId), eq(auditLog.action, "integrity.analysis_failed")),
		);
}

async function insertQueuedRun(appId: string, ageMs: number): Promise<string> {
	const { run } = await createIntegrityRun(runDeps(ctx), {
		applicationId: appId,
		inputHash: randomUUID(),
		documentSha256: [],
		requestedBy: randomUUID(),
		now: new Date(Date.now() - ageMs),
	});
	return run.id;
}

/**
 * The sweep is global and batched oldest-first, and it leaves startable
 * backlog queued, so queued rows earlier runs of this suite left behind would
 * crowd out the rows a sweep test creates. Cancel this suite's leftovers.
 */
async function clearQueuedBacklog(): Promise<void> {
	await ctx.db
		.update(documentIntegrityRuns)
		.set({ status: "cancelled", errorCode: "TEST_CLEANUP", finishedAt: new Date() })
		.where(
			and(
				eq(documentIntegrityRuns.status, "queued"),
				eq(documentIntegrityRuns.model, integrityConfig.model),
				lt(documentIntegrityRuns.createdAt, new Date(Date.now() - 10_000)),
			),
		);
}

describe("integrity run dispatch", () => {
	it("starts the workflow after insert, once, and tolerates Temporal being down", async () => {
		startCalls.length = 0;
		const { appId, officer, runId } = await analysisCase();
		expect(startCalls).toHaveLength(1);
		expect(startCalls[0]).toMatchObject({
			kind: INTEGRITY_RUN_KIND,
			runId,
			token: runId,
			timeoutMs: 30_000,
			// The workflow's attempt loop matches the row's claim limit.
			maxAttempts: (await runRow(runId)).maxAttempts,
		});
		expect(startCalls[0]?.maxAttempts).toBe(2);
		expect((await runRow(runId)).status).toBe("queued");

		// A replayed request does not start a second workflow.
		const replay = await queueAnalysis(officer, appId);
		expect(replay).toEqual({ status: 200, runId });
		expect(startCalls).toHaveLength(1);

		// Temporal down: the request still succeeds and the row stays queued.
		const previous = startImpl;
		startImpl = async () => {
			throw new Error("temporal unavailable");
		};
		try {
			const down = await newCase();
			expect((await upload(down.officer, down.appId, randomUUID())).status).toBe(201);
			const queued = await queueAnalysis(down.officer, down.appId);
			expect(queued.status).toBe(202);
			expect((await runRow(queued.runId)).status).toBe("queued");
		} finally {
			startImpl = previous;
		}
	});

	it("bounds a hanging workflow start on the request path and leaves the row queued", async () => {
		const previous = startImpl;
		startImpl = () => new Promise(() => {});
		try {
			const { appId, officer } = await newCase();
			expect((await upload(officer, appId, randomUUID())).status).toBe(201);
			const began = Date.now();
			const queued = await queueAnalysis(officer, appId);
			expect(Date.now() - began).toBeLessThan(INTEGRITY_START_TIMEOUT_MS + 2_000);
			expect(queued.status).toBe(202);
			expect((await runRow(queued.runId)).status).toBe("queued");
		} finally {
			startImpl = previous;
		}
	});

	it("claims by id: attempt 1 takes queued, attempt 2 re-leases and fences the zombie", async () => {
		const { runId } = await analysisCase();
		const deps = runDeps(ctx);
		const first = await claimIntegrityRunById(deps, runId, 1);
		if (first.kind !== "claimed") throw new Error("expected claim");
		expect(first.row.attempts).toBe(1);
		// A second attempt-1 claim finds a running row and does nothing.
		expect(await claimIntegrityRunById(deps, runId, 1)).toEqual({
			kind: "skip",
			status: "running",
		});

		const second = await claimIntegrityRunById(deps, runId, 2);
		if (second.kind !== "claimed") throw new Error("expected re-lease");
		expect(second.row.attempts).toBe(2);
		expect(second.row.lease_token).not.toBe(first.row.lease_token);

		// The dead attempt's late write is rejected by the lease-token guard.
		await executeIntegrityRun(deps, first.row);
		const afterZombie = await runRow(runId);
		expect(afterZombie.status).toBe("running");
		expect(afterZombie.leaseToken).toBe(second.row.lease_token);
		const zombieCandidates = await ctx.db
			.select()
			.from(documentFieldCandidates)
			.where(eq(documentFieldCandidates.runId, runId));
		expect(zombieCandidates).toHaveLength(0);

		await executeIntegrityRun(deps, second.row);
		expect((await runRow(runId)).status).toBe("succeeded");
	});

	it("respects max_attempts and reports missing or terminal rows", async () => {
		const { runId } = await analysisCase();
		const deps = runDeps(ctx);
		expect((await claimIntegrityRunById(deps, runId, 1)).kind).toBe("claimed");
		expect((await claimIntegrityRunById(deps, runId, 2)).kind).toBe("claimed");
		expect((await runRow(runId)).attempts).toBe(2);
		expect((await claimIntegrityRunById(deps, runId, 3)).kind).toBe("exhausted");
		const exhausted = await runRow(runId);
		expect(exhausted).toMatchObject({ status: "failed", errorCode: "LEASE_EXPIRED", attempts: 2 });
		expect(exhausted.leaseToken).toBeNull();
		// Terminal now: nothing to claim.
		expect(await claimIntegrityRunById(deps, runId, 2)).toEqual({
			kind: "skip",
			status: "failed",
		});
		expect(await claimIntegrityRunById(deps, randomUUID(), 1)).toEqual({ kind: "missing" });
	});

	it("cancels with FEATURE_DISABLED when the flag is off at execution time", async () => {
		const { runId } = await analysisCase();
		const deps = runDeps(ctx, { enabled: false });
		const claim = await claimIntegrityRunById(deps, runId, 1);
		if (claim.kind !== "claimed") throw new Error("expected claim");
		await executeIntegrityRun(deps, claim.row);
		expect(await runRow(runId)).toMatchObject({
			status: "cancelled",
			errorCode: "FEATURE_DISABLED",
		});
	});

	it("failAgentRun fails an active run idempotently and never touches terminal rows", async () => {
		const { runId } = await analysisCase();
		const deps = runDeps(ctx);
		const activities = createIntegrityActivities(deps);
		const input: AgentRunInput = {
			kind: INTEGRITY_RUN_KIND,
			runId,
			token: runId,
			timeoutMs: 30_000,
		};
		await claimIntegrityRunById(deps, runId, 1);
		await activities.failAgentRun(input, { code: "timeout", message: "activity timeout" });
		const failed = await runRow(runId);
		expect(failed).toMatchObject({ status: "failed", errorCode: "LEASE_EXPIRED" });
		expect(failed.leaseToken).toBeNull();
		expect(failed.finishedAt).not.toBeNull();

		await activities.failAgentRun(input, { code: "error", message: "again" });
		const again = await runRow(runId);
		expect(again.errorCode).toBe("LEASE_EXPIRED");
		expect(again.finishedAt).toEqual(failed.finishedAt);

		const done = await analysisCase();
		const claim = await claimIntegrityRunById(deps, done.runId, 1);
		if (claim.kind !== "claimed") throw new Error("expected claim");
		await executeIntegrityRun(deps, claim.row);
		expect(await failIntegrityRun(deps, done.runId, "INTERNAL_ERROR", "late")).toBe(false);
		expect((await runRow(done.runId)).status).toBe("succeeded");
	});

	it("retries a transient failure: keeps the row running, then succeeds without a failed audit", async () => {
		const { appId, runId } = await analysisCase();
		const deps = { ...runDeps(ctx), runner: failingOnce(runner) };
		const first = await claimIntegrityRunById(deps, runId, 1);
		if (first.kind !== "claimed") throw new Error("expected claim");
		await expect(executeIntegrityRun(deps, first.row)).rejects.toBeInstanceOf(
			IntegrityAttemptFailed,
		);
		const between = await runRow(runId);
		expect(between).toMatchObject({ status: "running", errorCode: "MODEL_ERROR", attempts: 1 });
		expect(between.finishedAt).toBeNull();

		const second = await claimIntegrityRunById(deps, runId, 2);
		if (second.kind !== "claimed") throw new Error("expected re-lease");
		await executeIntegrityRun(deps, second.row);
		expect(await runRow(runId)).toMatchObject({
			status: "succeeded",
			attempts: 2,
			errorCode: null,
		});
		expect(await failedAudits(appId)).toHaveLength(0);
	});

	it("finalizes AGENT_UNAVAILABLE on the first attempt", async () => {
		const { appId, runId } = await analysisCase();
		const deps = { ...runDeps(ctx), runner: null };
		const claim = await claimIntegrityRunById(deps, runId, 1);
		if (claim.kind !== "claimed") throw new Error("expected claim");
		await executeIntegrityRun(deps, claim.row);
		expect(await runRow(runId)).toMatchObject({
			status: "failed",
			errorCode: "AGENT_UNAVAILABLE",
			attempts: 1,
		});
		expect(await failedAudits(appId)).toHaveLength(1);
	});

	it("finalizes a transient failure on the workflow's last attempt", async () => {
		const { appId, runId } = await analysisCase();
		const deps = { ...runDeps(ctx), runner: failingOnce(runner) };
		const claim = await claimIntegrityRunById(deps, runId, 1);
		if (claim.kind !== "claimed") throw new Error("expected claim");
		await executeIntegrityRun(deps, claim.row, { finalAttempt: true });
		expect(await runRow(runId)).toMatchObject({ status: "failed", errorCode: "MODEL_ERROR" });
		expect(await failedAudits(appId)).toHaveLength(1);
	});

	it("leaves the row to the next attempt when the attempt is cancelled", async () => {
		const { appId, runId } = await analysisCase();
		const cancel = new AbortController();
		const deps = {
			...runDeps(ctx),
			runner: {
				async run() {
					// Worker shutdown / heartbeat-timeout cancel mid model call.
					cancel.abort();
					throw new Error("aborted");
				},
			} satisfies IntegrityAgentRunner,
		};
		const claim = await claimIntegrityRunById(deps, runId, 1);
		if (claim.kind !== "claimed") throw new Error("expected claim");
		await expect(
			executeIntegrityRun(deps, claim.row, { signal: cancel.signal, finalAttempt: true }),
		).rejects.toThrow();
		const after = await runRow(runId);
		expect(after).toMatchObject({ status: "running", errorCode: null, attempts: 1 });
		expect(after.leaseToken).toBe(claim.row.lease_token);
		expect(await failedAudits(appId)).toHaveLength(0);

		const next = await claimIntegrityRunById(runDeps(ctx), runId, 2);
		if (next.kind !== "claimed") throw new Error("expected re-lease");
		await executeIntegrityRun(runDeps(ctx), next.row);
		expect((await runRow(runId)).status).toBe("succeeded");
	});

	it("sweep restarts stale queued rows and never fails a backlog it can start", async () => {
		await clearQueuedBacklog();
		const { appId } = await newCase();
		const deps = runDeps(ctx);
		const fresh = await insertQueuedRun(appId, 1_000);
		const stale = await insertQueuedRun(appId, 20_000);
		// Past the run horizon, but its workflow exists: waiting for a worker slot.
		const backlogged = await insertQueuedRun(appId, 10 * 60_000);
		expect(10 * 60_000).toBeGreaterThan(integrityRunHorizonMs(integrityConfig, 2));
		startCalls.length = 0;
		const previous = startImpl;
		startImpl = async (input) => {
			startCalls.push(input);
			return { started: false, workflowId: `${input.kind}:${input.runId}:${input.token}` };
		};
		try {
			await sweepQueuedIntegrityRuns(deps, { dispatch: true });
		} finally {
			startImpl = previous;
		}
		const started = startCalls.map((call) => call.runId);
		expect(started).toContain(stale);
		expect(started).toContain(backlogged);
		expect(started).not.toContain(fresh);
		for (const id of [fresh, stale, backlogged]) {
			expect((await runRow(id)).status).toBe("queued");
		}

		// Re-issued starts are idempotent for the same row (same workflow id).
		startCalls.length = 0;
		await sweepQueuedIntegrityRuns(deps, { dispatch: true });
		expect(startCalls.map((call) => call.runId)).toContain(stale);
		await clearQueuedBacklog();
	});

	it("sweep fails overdue queued rows only when their workflow cannot be started", async () => {
		await clearQueuedBacklog();
		const { appId } = await newCase();
		const deps = runDeps(ctx);
		const stale = await insertQueuedRun(appId, 20_000);
		const overdue = await insertQueuedRun(appId, 10 * 60_000);
		const abandoned = await insertQueuedRun(appId, SWEEP_ABANDON_AFTER_MS + 60_000);
		const previous = startImpl;
		startImpl = async () => {
			throw new Error("temporal unavailable");
		};
		try {
			const result = await sweepQueuedIntegrityRuns(deps, { dispatch: true });
			expect(result.failed).toBeGreaterThanOrEqual(2);
		} finally {
			startImpl = previous;
		}
		expect(await runRow(overdue)).toMatchObject({ status: "failed", errorCode: "LEASE_EXPIRED" });
		expect((await runRow(abandoned)).status).toBe("failed");
		expect((await runRow(stale)).status).toBe("queued");

		// A worker that does not dispatch cannot start it either.
		const undispatched = await insertQueuedRun(appId, 10 * 60_000);
		await sweepQueuedIntegrityRuns(deps, { dispatch: false });
		expect((await runRow(undispatched)).status).toBe("failed");

		// A day-old backlog is failed even though its workflow exists.
		const ancient = await insertQueuedRun(appId, SWEEP_ABANDON_AFTER_MS + 60_000);
		await sweepQueuedIntegrityRuns(deps, { dispatch: true });
		expect((await runRow(ancient)).status).toBe("failed");
		await clearQueuedBacklog();
	});

	it("the queued-overdue path never fails a row claimed after selection", async () => {
		const { appId } = await newCase();
		const deps = runDeps(ctx);
		const runId = await insertQueuedRun(appId, 10 * 60_000);
		expect((await claimIntegrityRunById(deps, runId, 1)).kind).toBe("claimed");
		expect(
			await failIntegrityRun(deps, runId, "LEASE_EXPIRED", "queued too long", {
				onlyStatus: "queued",
			}),
		).toBe(false);
		expect((await runRow(runId)).status).toBe("running");
	});

	it("sweep fails running rows orphaned past the run horizon, fenced on the lease", async () => {
		const { appId } = await newCase();
		const deps = runDeps(ctx);
		const horizonMs = integrityRunHorizonMs(integrityConfig, 2);
		const claimRunning = async (leaseAgeMs: number) => {
			const runId = await insertQueuedRun(appId, 1_000);
			const claim = await claimIntegrityRunById(deps, runId, 1);
			if (claim.kind !== "claimed") throw new Error("expected claim");
			await ctx.db
				.update(documentIntegrityRuns)
				.set({ leaseExpiresAt: new Date(Date.now() - leaseAgeMs) })
				.where(eq(documentIntegrityRuns.id, runId));
			return runId;
		};
		const orphan = await claimRunning(horizonMs + 60_000);
		// Lease expired, but still within the workflow's retry window.
		const retrying = await claimRunning(60_000);

		await sweepQueuedIntegrityRuns(deps, { dispatch: false });
		const failed = await runRow(orphan);
		expect(failed).toMatchObject({ status: "failed", errorCode: "LEASE_EXPIRED" });
		expect(failed.leaseToken).toBeNull();
		expect((await runRow(retrying)).status).toBe("running");

		// A stale lease that was re-leased meanwhile is not failed.
		const releasedStale = await claimRunning(horizonMs + 60_000);
		const stale = await runRow(releasedStale);
		await claimIntegrityRunById(deps, releasedStale, 2);
		expect(
			await failIntegrityRun(deps, releasedStale, "LEASE_EXPIRED", "lease abandoned", {
				onlyStatus: "running",
				leaseToken: stale.leaseToken!,
			}),
		).toBe(false);
		expect((await runRow(releasedStale)).status).toBe("running");
	});
});

// --- Real Temporal: the actual activities on a unique task queue ------------

describe("integrity runs on Temporal", () => {
	const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
	const taskQueue = `applications-agents-test-${randomUUID()}`;
	let crashUntilAttempt = 0;
	let workerRunner: IntegrityAgentRunner = runner;
	let shutdown: (() => Promise<void>) | null = null;
	let previousStart: AgentRunStarter["start"];
	const realStarter = createAgentRunStarter({ address, taskQueue });

	beforeAll(async () => {
		const delegating: IntegrityAgentRunner = { run: (input) => workerRunner.run(input) };
		const activities = createIntegrityActivities(
			{ ...runDeps(ctx), runner: delegating },
			{
				afterClaim(_claimed, attempt) {
					if (attempt <= crashUntilAttempt) throw new Error("worker crashed after claim");
				},
			},
		);
		const { worker, connection } = await createAgentWorker({ address, taskQueue, activities });
		const running = worker.run();
		shutdown = async () => {
			worker.shutdown();
			await running;
			await connection.close();
		};
		previousStart = startImpl;
		startImpl = (input) => realStarter.start(input);
	});

	afterAll(async () => {
		startImpl = previousStart;
		await shutdown?.();
		await realStarter.close();
	});

	it("runs a queued analysis to success", async () => {
		crashUntilAttempt = 0;
		const { runId } = await analysisCase();
		const row = await waitTerminal(runId);
		expect(row).toMatchObject({ status: "succeeded", attempts: 1 });
	});

	it("re-leases after an attempt-1 crash and succeeds on attempt 2", async () => {
		crashUntilAttempt = 1;
		try {
			const { runId } = await analysisCase();
			const row = await waitTerminal(runId);
			expect(row).toMatchObject({ status: "succeeded", attempts: 2 });
		} finally {
			crashUntilAttempt = 0;
		}
	});

	it("retries a transient model failure and succeeds on attempt 2", async () => {
		workerRunner = failingOnce(runner);
		try {
			const { appId, runId } = await analysisCase();
			const row = await waitTerminal(runId);
			expect(row).toMatchObject({ status: "succeeded", attempts: 2, errorCode: null });
			expect(await failedAudits(appId)).toHaveLength(0);
		} finally {
			workerRunner = runner;
		}
	});

	it("fails the run through failAgentRun once every attempt crashed", async () => {
		crashUntilAttempt = 99;
		try {
			const { appId } = await newCase();
			const { run } = await createIntegrityRun(runDeps(ctx), {
				applicationId: appId,
				inputHash: randomUUID(),
				documentSha256: [],
				requestedBy: randomUUID(),
			});
			// The production start path: attempts come from the row (DB default).
			await startIntegrityRun(runDeps(ctx), run);
			const row = await waitTerminal(run.id, 45_000);
			expect(row).toMatchObject({ status: "failed", errorCode: "INTERNAL_ERROR", attempts: 2 });
			expect(row.leaseToken).toBeNull();
		} finally {
			crashUntilAttempt = 0;
		}
	});
});
