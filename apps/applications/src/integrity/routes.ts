// E2/EN-05 HTTP surface.
//
// Integrity routes are assigned-officer only; fraud routes are officer-gated at
// the gateway and reviewer-granted for resolution/brief content. Every nested
// id is scoped by application id. Responses are no-store; logs/audits carry
// ids/codes/counts only.

import { randomUUID } from "node:crypto";
import {
	applications,
	documentConsistencyCandidates,
	documentFieldCandidates,
	documentFiles,
	documentIntegrityRuns,
	documentPages,
	withTx,
	type Db,
} from "@credit/db/applications";
import { hashCanonical } from "@credit/core";
import {
	HttpError,
	readJson,
	requireOfficer,
	requireService,
	writeAudit,
	type Logger,
	type ServiceApp,
	type ServiceVariables,
} from "@credit/service-kit";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import {
	actorOf,
	isUuid,
	requireFraudOfficer,
	requireIntegrityCaseAccess,
	type IntegrityActor,
} from "./access.js";
import { analysisInputHash, createIntegrityRun, drainIntegrityRunsSafely } from "./runs.js";
import { queueTriageForReview, reevaluateIntegrity } from "./evaluate.js";
import {
	assignFraudReview,
	buildResolutionDraft,
	createFraudReview,
	explainDuplicate,
	getFraudReviewRow,
	grantFraudReviewer,
	canViewFraudReview,
	isFraudReviewer,
	listFraudQueue,
	resolveFraudReview,
	revokeFraudReviewer,
	runFraudReviewRetention,
} from "./fraud.js";
import { countDuplicateDocuments, findDuplicateDocuments } from "./duplicates.js";
import { getBriefArtifact, loadIntegrityPanel, runTraceDto } from "./store.js";
import { loadIntegritySource } from "./source.js";
import type { IntegrityConfig, IntegrityRuntime, IntegritySeverity } from "./types.js";

export interface IntegrityRouteDeps {
	db: Db;
	runtime: IntegrityRuntime;
	logger: Logger;
}

const candidateActionSchema = z.object({ action: z.enum(["confirm", "reject"]) }).strict();
const escalateSchema = z.object({ note: z.string().min(5).max(500).optional() }).strict();
const flagSchema = z
	.object({
		reasonCode: z.enum([
			"document_integrity",
			"duplicate_document",
			"metadata_inconsistency",
			"other",
		]),
		note: z.string().min(5).max(2_000),
		documentFileIds: z.array(z.uuid()).max(20).optional(),
		severity: z.enum(["low", "medium", "high"]).optional(),
	})
	.strict();
const assignSchema = z
	.object({ assigneeUserId: z.uuid(), expectedVersion: z.number().int().min(1) })
	.strict();
const resolveSchema = z
	.object({
		status: z.enum(["cleared", "confirmed", "needs_info"]),
		note: z.string().min(10).max(2_000),
		expectedVersion: z.number().int().min(1),
	})
	.strict();
const duplicateLookupSchema = z
	.object({
		sha256: z.string().regex(/^[a-f0-9]{64}$/i),
		applicationId: z.uuid().optional(),
	})
	.strict();
const duplicateExplainSchema = z
	.object({
		sha256: z.string().regex(/^[a-f0-9]{64}$/i),
		applicationId: z.uuid(),
		note: z.string().min(5).max(500),
	})
	.strict();
const reviewerGrantSchema = z
	.object({ userId: z.uuid(), action: z.enum(["grant", "revoke"]) })
	.strict();

function invalidBody(error: z.ZodError): HttpError {
	return new HttpError(
		400,
		"VALIDATION_ERROR",
		error.issues
			.map((issue) => issue.message)
			.join("; ")
			.slice(0, 300),
	);
}

function requireConfig(deps: IntegrityRouteDeps): IntegrityConfig {
	return deps.runtime.config;
}

function featureEnabled(deps: IntegrityRouteDeps): boolean {
	return deps.runtime.config.enabled && deps.runtime.documentsEnabled;
}

function fraudEnabled(deps: IntegrityRouteDeps): boolean {
	return deps.runtime.config.fraudReviewEnabled && deps.runtime.documentsEnabled;
}

function runDeps(deps: IntegrityRouteDeps) {
	return {
		db: deps.db,
		config: deps.runtime.config,
		runner: deps.runtime.agentRunner,
		logger: deps.logger,
		now: deps.runtime.now,
	};
}

async function loadCase(
	deps: IntegrityRouteDeps,
	applicationId: string,
	actor: IntegrityActor,
): Promise<typeof applications.$inferSelect> {
	if (!isUuid(applicationId)) throw new HttpError(404, "NOT_FOUND", "not found");
	return requireIntegrityCaseAccess(deps.db, applicationId, actor);
}

async function audit(
	deps: IntegrityRouteDeps,
	input: {
		applicationId: string | null;
		actor: IntegrityActor;
		action: string;
		entity: string;
		payload: Record<string, unknown>;
	},
): Promise<void> {
	await withTx(deps.db, async (tx) => {
		await writeAudit(tx, {
			...(input.applicationId ? { applicationId: input.applicationId } : {}),
			actor: input.actor.id,
			action: input.action,
			entity: input.entity,
			payload: {
				feature: "document_integrity",
				actorRole: input.actor.role,
				...input.payload,
			},
		});
	});
}

function reviewSummary(row: {
	id: string;
	applicationId: string;
	status: string;
	severity: IntegritySeverity;
	reasonCode: string;
	createdAt: Date;
	updatedAt: Date;
	version: number;
}): Record<string, unknown> {
	return {
		id: row.id,
		applicationId: row.applicationId,
		status: row.status,
		severity: row.severity,
		reasonCode: row.reasonCode,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		version: row.version,
	};
}

export function integrityRoutes(deps: IntegrityRouteDeps): ServiceApp {
	const app: ServiceApp = new Hono<{ Variables: ServiceVariables }>();
	const config = requireConfig(deps);
	const sensitiveResponse = createMiddleware<{ Variables: ServiceVariables }>(async (c, next) => {
		c.header("Cache-Control", "no-store");
		c.header("X-Content-Type-Options", "nosniff");
		await next();
	});
	app.use("/api/applications/:id/integrity", requireOfficer, sensitiveResponse);
	app.use("/api/applications/:id/integrity/*", requireOfficer, sensitiveResponse);
	app.use("/api/fraud-review/*", requireOfficer, sensitiveResponse);
	app.use("/api/fraud-review", requireOfficer, sensitiveResponse);

	async function queueTriageBestEffort(input: {
		applicationId: string;
		actor: IntegrityActor;
		review: Parameters<typeof queueTriageForReview>[1]["review"];
	}): Promise<void> {
		try {
			await queueTriageForReview(runDeps(deps), {
				applicationId: input.applicationId,
				review: input.review,
				requestedBy: input.actor.id,
				now: deps.runtime.now(),
			});
		} catch (err) {
			const errorCode =
				err !== null && typeof err === "object" && "code" in err
					? String((err as { code: unknown }).code)
					: "unknown";
			deps.logger.warn(
				{ applicationId: input.applicationId, reviewId: input.review.id, errorCode },
				"triage enqueue failed",
			);
			await audit(deps, {
				applicationId: input.applicationId,
				actor: { id: deps.runtime.config.systemUserId, role: "service" },
				action: "integrity.triage_enqueue_failed",
				entity: "fraud_review",
				payload: { reviewId: input.review.id, errorCode },
			}).catch(() => {});
		}
	}

	// --- Integrity panel + analysis ---

	app.get("/api/applications/:id/integrity", async (c) => {
		if (!featureEnabled(deps)) throw new HttpError(404, "NOT_FOUND", "not found");
		const applicationId = c.req.param("id");
		const actor = actorOf(c);
		await loadCase(deps, applicationId, actor);
		const panel = await loadIntegrityPanel(deps.db, applicationId, config, deps.runtime.now());
		return c.json({ panel });
	});

	app.post("/api/applications/:id/integrity/analyses", async (c) => {
		if (!featureEnabled(deps)) throw new HttpError(404, "NOT_FOUND", "not found");
		if (!config.agentEnabled || !deps.runtime.agentRunner) {
			throw new HttpError(503, "INTEGRITY_AGENT_UNAVAILABLE", "integrity agent is unavailable");
		}
		const applicationId = c.req.param("id");
		const actor = actorOf(c);
		await loadCase(deps, applicationId, actor);
		const source = await loadIntegritySource(deps.db, applicationId, {
			includeCustomerEvidence: false,
			now: deps.runtime.now(),
		});
		const inputHash = analysisInputHash(source, config);
		const { run, replayed } = await createIntegrityRun(runDeps(deps), {
			applicationId,
			feature: "document_analysis",
			inputHash,
			documentSha256: source.documents.map((doc) => doc.sha256).sort(),
			requestedBy: actor.id,
			now: deps.runtime.now(),
		});
		await audit(deps, {
			applicationId,
			actor,
			action: "integrity.analysis_requested",
			entity: "document_integrity_run",
			payload: {
				runId: run.id,
				replayed,
				model: config.model,
				promptVersion: config.promptVersion,
				agentVersion: config.agentVersion,
			},
		});
		void drainIntegrityRunsSafely(runDeps(deps));
		return c.json({ run: runTraceDto(run) }, replayed ? 200 : 202);
	});

	app.get("/api/applications/:id/integrity/analyses/:runId", async (c) => {
		if (!featureEnabled(deps)) throw new HttpError(404, "NOT_FOUND", "not found");
		const applicationId = c.req.param("id");
		const runId = c.req.param("runId");
		const actor = actorOf(c);
		await loadCase(deps, applicationId, actor);
		if (!isUuid(runId)) throw new HttpError(404, "NOT_FOUND", "not found");
		const [run] = await deps.db
			.select()
			.from(documentIntegrityRuns)
			.where(
				and(
					eq(documentIntegrityRuns.id, runId),
					eq(documentIntegrityRuns.applicationId, applicationId),
					eq(documentIntegrityRuns.feature, "document_analysis"),
				),
			)
			.limit(1);
		if (!run) throw new HttpError(404, "NOT_FOUND", "not found");
		return c.json({ run: runTraceDto(run) });
	});

	app.patch("/api/applications/:id/integrity/candidates/:candidateId", async (c) => {
		if (!featureEnabled(deps)) throw new HttpError(404, "NOT_FOUND", "not found");
		const applicationId = c.req.param("id");
		const candidateId = c.req.param("candidateId");
		const actor = actorOf(c);
		await loadCase(deps, applicationId, actor);
		if (!isUuid(candidateId)) throw new HttpError(404, "NOT_FOUND", "not found");
		const parsed = candidateActionSchema.safeParse(await readJson(c));
		if (!parsed.success) throw invalidBody(parsed.error);
		const [candidate] = await deps.db
			.select()
			.from(documentFieldCandidates)
			.where(
				and(
					eq(documentFieldCandidates.id, candidateId),
					eq(documentFieldCandidates.applicationId, applicationId),
				),
			)
			.limit(1);
		if (!candidate) throw new HttpError(404, "NOT_FOUND", "not found");
		if (!["candidate", "validated"].includes(candidate.status)) {
			throw new HttpError(409, "CANDIDATE_NOT_ACTIVE", "candidate is already decided");
		}
		const [page] = await deps.db
			.select({ text: documentPages.text })
			.from(documentPages)
			.where(
				and(
					eq(documentPages.documentFileId, candidate.documentFileId),
					eq(documentPages.pageNumber, candidate.pageNumber),
				),
			)
			.limit(1);
		// Re-verify on confirmation so a retry-OCR rewrite cannot be confirmed
		// against a stale offset.
		if (!page) throw new HttpError(409, "CANDIDATE_STALE", "candidate source is unavailable");
		const slice = [...page.text].slice(candidate.offsetStart, candidate.offsetEnd).join("");
		if (slice !== candidate.quote) {
			throw new HttpError(409, "CANDIDATE_STALE", "candidate source changed");
		}
		const now = deps.runtime.now();
		const updated = await withTx(deps.db, async (tx) => {
			const [row] = await tx
				.update(documentFieldCandidates)
				.set({
					status: parsed.data.action === "confirm" ? "confirmed" : "rejected",
					confirmedBy: actor.id,
					confirmedAt: now,
				})
				.where(
					and(
						eq(documentFieldCandidates.id, candidate.id),
						inArray(documentFieldCandidates.status, ["candidate", "validated"]),
					),
				)
				.returning();
			if (!row) throw new HttpError(409, "CANDIDATE_NOT_ACTIVE", "candidate was decided");
			await writeAudit(tx, {
				applicationId,
				actor: actor.id,
				action:
					parsed.data.action === "confirm"
						? "integrity.candidate_confirmed"
						: "integrity.candidate_rejected",
				entity: "document_field_candidate",
				payload: {
					feature: "document_integrity",
					actorRole: actor.role,
					candidateId: candidate.id,
					documentFileId: candidate.documentFileId,
					field: candidate.field,
				},
			});
			return row;
		});
		return c.json({
			candidate: {
				id: updated.id,
				status: updated.status,
				confirmedAt: updated.confirmedAt?.toISOString() ?? null,
			},
		});
	});

	app.post("/api/applications/:id/integrity/consistency/:candidateId/escalate", async (c) => {
		if (!featureEnabled(deps) || !fraudEnabled(deps)) {
			throw new HttpError(404, "NOT_FOUND", "not found");
		}
		const applicationId = c.req.param("id");
		const candidateId = c.req.param("candidateId");
		const actor = actorOf(c);
		await loadCase(deps, applicationId, actor);
		if (!isUuid(candidateId)) throw new HttpError(404, "NOT_FOUND", "not found");
		const parsed = escalateSchema.safeParse(await readJson(c));
		if (!parsed.success) throw invalidBody(parsed.error);
		const [row] = await deps.db
			.select()
			.from(documentConsistencyCandidates)
			.where(
				and(
					eq(documentConsistencyCandidates.id, candidateId),
					eq(documentConsistencyCandidates.applicationId, applicationId),
				),
			)
			.limit(1);
		if (!row) throw new HttpError(404, "NOT_FOUND", "not found");
		if (row.status !== "confirmed" || row.kind !== "mismatch" || row.redactedAt !== null) {
			throw new HttpError(
				409,
				"NOT_CONFIRMED_MISMATCH",
				"only a confirmed mismatch can be escalated",
			);
		}
		const { review } = await createReviewForCase(deps, {
			applicationId,
			actor,
			reasonCode: "document_integrity",
			note: parsed.data.note ?? null,
			severity: row.severity,
			signalCodes: ["consistency_candidate"],
			documentRefs: [row.leftDocumentFileId, row.rightDocumentFileId],
			sourceHash: hashCanonical({
				consistencyId: row.id,
				left: row.leftQuoteHash,
				right: row.rightQuoteHash,
			}),
		});
		await queueTriageBestEffort({ applicationId, actor, review });
		await audit(deps, {
			applicationId,
			actor,
			action: "integrity.consistency_escalated",
			entity: "fraud_review",
			payload: {
				reviewId: review.id,
				consistencyId: row.id,
				field: row.field,
				severity: row.severity,
			},
		});
		return c.json({ review: reviewSummary(review) });
	});

	app.post("/api/applications/:id/integrity/flags", async (c) => {
		if (!featureEnabled(deps) || !fraudEnabled(deps)) {
			throw new HttpError(404, "NOT_FOUND", "not found");
		}
		const applicationId = c.req.param("id");
		const actor = actorOf(c);
		await loadCase(deps, applicationId, actor);
		const parsed = flagSchema.safeParse(await readJson(c));
		if (!parsed.success) throw invalidBody(parsed.error);
		const documentFileIds = parsed.data.documentFileIds ?? [];
		if (documentFileIds.length > 0) {
			const rows = await deps.db
				.select({ id: documentFiles.id, sha256: documentFiles.sha256 })
				.from(documentFiles)
				.where(
					and(
						eq(documentFiles.applicationId, applicationId),
						inArray(documentFiles.id, documentFileIds),
						eq(documentFiles.status, "ready"),
					),
				);
			if (rows.length !== new Set(documentFileIds).size) {
				throw new HttpError(
					422,
					"DOCUMENT_NOT_AVAILABLE",
					"document is not available in this case",
				);
			}
		}
		const { review } = await createReviewForCase(deps, {
			applicationId,
			actor,
			reasonCode: parsed.data.reasonCode,
			note: parsed.data.note,
			severity: parsed.data.severity ?? "medium",
			signalCodes: [],
			documentRefs: documentFileIds,
			sourceHash: hashCanonical({ reasonCode: parsed.data.reasonCode, documentFileIds }),
		});
		await queueTriageBestEffort({ applicationId, actor, review });
		return c.json({ review: reviewSummary(review) });
	});

	app.post("/api/applications/:id/integrity/evaluate", async (c) => {
		if (!featureEnabled(deps) || !fraudEnabled(deps)) {
			throw new HttpError(404, "NOT_FOUND", "not found");
		}
		const applicationId = c.req.param("id");
		const actor = actorOf(c);
		await loadCase(deps, applicationId, actor);
		const result = await reevaluateIntegrity(runDeps(deps), {
			applicationId,
			actor,
			actorRole: actor.role,
			now: deps.runtime.now(),
		});
		await audit(deps, {
			applicationId,
			actor,
			action: "integrity.evaluate_requested",
			entity: "document_integrity_run",
			payload: {
				flagged: result.flagged,
				reviewId: result.reviewId,
				severity: result.severity,
				signalCodes: result.signals.map((signal) => signal.code),
			},
		});
		return c.json({ result: { ...result, signals: undefined } });
	});

	// --- Fraud review ---

	app.get("/api/fraud-review/me", async (c) => {
		if (!fraudEnabled(deps)) throw new HttpError(404, "NOT_FOUND", "not found");
		const actor = actorOf(c);
		if (actor.role !== "officer") throw new HttpError(403, "FORBIDDEN", "officer role required");
		const reviewer = await isFraudReviewer(deps.db, actor.id);
		return c.json({ reviewer, canViewQueue: true });
	});

	app.get("/api/fraud-review/queue", async (c) => {
		if (!fraudEnabled(deps)) throw new HttpError(404, "NOT_FOUND", "not found");
		const actor = actorOf(c);
		const { reviewer } = await requireFraudOfficer(deps.db, actor);
		const status = c.req.query("status") === "all" ? "all" : "active";
		const items = await listFraudQueue(
			deps.db,
			{ id: actor.id, role: actor.role as "officer" },
			status,
		);
		return c.json({ items, reviewer });
	});

	app.get("/api/fraud-review/:id", async (c) => {
		if (!fraudEnabled(deps)) throw new HttpError(404, "NOT_FOUND", "not found");
		const reviewId = c.req.param("id");
		if (!isUuid(reviewId)) throw new HttpError(404, "NOT_FOUND", "not found");
		const actor = actorOf(c);
		const row = await getFraudReviewRow(deps.db, reviewId);
		if (!row) throw new HttpError(404, "NOT_FOUND", "not found");
		const access = await canViewFraudReview(deps.db, row, {
			id: actor.id,
			role: actor.role as "officer",
		});
		await audit(deps, {
			applicationId: row.applicationId,
			actor,
			action: "fraud_review.viewed",
			entity: "fraud_review",
			payload: { reviewId: row.id, reviewer: access.reviewer },
		});
		if (!access.reviewer) {
			return c.json({
				review: {
					...reviewSummary(row),
					applicationId: row.applicationId,
					reasonCode: row.reasonCode,
					briefAvailable: row.briefArtifactId !== null,
					briefStale: row.briefStaleAt !== null,
				},
			});
		}
		const brief =
			row.briefArtifactId && row.briefStaleAt === null
				? await getBriefForReview(deps, row.briefArtifactId, row.applicationId)
				: null;
		const [consentApp] = await deps.db
			.select({ consent: applications.documentProcessingConsent })
			.from(applications)
			.where(eq(applications.id, row.applicationId))
			.limit(1);
		const briefVisible = consentApp?.consent === true;
		return c.json({
			review: {
				...reviewSummary(row),
				note: row.note,
				assigneeUserId: row.assigneeUserId,
				signalCodes: row.signalCodes,
				documentRefs: row.documentRefs,
				briefArtifactId: row.briefArtifactId,
				briefStale: row.briefStaleAt !== null,
				briefUnavailable: briefVisible
					? row.briefStaleAt !== null
						? "stale"
						: row.briefArtifactId === null
							? "missing"
							: null
					: "consent_withdrawn",
				agentRunId: row.agentRunId,
				model: row.model,
				promptVersion: row.promptVersion,
				agentVersion: row.agentVersion,
				resolvedBy: row.resolvedBy,
				resolvedAt: row.resolvedAt?.toISOString() ?? null,
				resolutionNote: row.resolutionNote,
				brief: briefVisible ? brief : null,
			},
		});
	});

	app.patch("/api/fraud-review/:id/assign", async (c) => {
		if (!fraudEnabled(deps)) throw new HttpError(404, "NOT_FOUND", "not found");
		const reviewId = c.req.param("id");
		if (!isUuid(reviewId)) throw new HttpError(404, "NOT_FOUND", "not found");
		const actor = actorOf(c);
		const { reviewer } = await requireFraudOfficer(deps.db, actor);
		if (!reviewer) throw new HttpError(403, "REVIEWER_REQUIRED", "fraud reviewer required");
		const parsed = assignSchema.safeParse(await readJson(c));
		if (!parsed.success) throw invalidBody(parsed.error);
		const updated = await assignFraudReview(deps.db, {
			reviewId,
			assigneeUserId: parsed.data.assigneeUserId,
			actor: { id: actor.id, role: "officer" },
			expectedVersion: parsed.data.expectedVersion,
			now: deps.runtime.now(),
		});
		return c.json({ review: reviewSummary(updated) });
	});

	app.post("/api/fraud-review/:id/resolve", async (c) => {
		if (!fraudEnabled(deps)) throw new HttpError(404, "NOT_FOUND", "not found");
		const reviewId = c.req.param("id");
		if (!isUuid(reviewId)) throw new HttpError(404, "NOT_FOUND", "not found");
		const actor = actorOf(c);
		const { reviewer } = await requireFraudOfficer(deps.db, actor);
		if (!reviewer) throw new HttpError(403, "REVIEWER_REQUIRED", "fraud reviewer required");
		const parsed = resolveSchema.safeParse(await readJson(c));
		if (!parsed.success) throw invalidBody(parsed.error);
		const updated = await resolveFraudReview(deps.db, {
			reviewId,
			status: parsed.data.status,
			note: parsed.data.note,
			actor: { id: actor.id, role: "officer" },
			expectedVersion: parsed.data.expectedVersion,
			now: deps.runtime.now(),
		});
		return c.json({
			review: reviewSummary(updated),
			decisionPath: `/officer/review/${updated.applicationId}`,
		});
	});

	app.get("/api/fraud-review/:id/resolution-draft", async (c) => {
		if (!fraudEnabled(deps)) throw new HttpError(404, "NOT_FOUND", "not found");
		const reviewId = c.req.param("id");
		if (!isUuid(reviewId)) throw new HttpError(404, "NOT_FOUND", "not found");
		const actor = actorOf(c);
		const { reviewer } = await requireFraudOfficer(deps.db, actor);
		if (!reviewer) throw new HttpError(403, "REVIEWER_REQUIRED", "fraud reviewer required");
		const draft = await buildResolutionDraft(deps.db, {
			reviewId,
			actor: { id: actor.id, role: "officer" },
		});
		return c.json(draft);
	});

	app.post("/api/fraud-review/duplicates/lookup", async (c) => {
		if (!fraudEnabled(deps)) throw new HttpError(404, "NOT_FOUND", "not found");
		const actor = actorOf(c);
		const { reviewer } = await requireFraudOfficer(deps.db, actor);
		if (!reviewer) throw new HttpError(403, "REVIEWER_REQUIRED", "fraud reviewer required");
		const parsed = duplicateLookupSchema.safeParse(await readJson(c));
		if (!parsed.success) throw invalidBody(parsed.error);
		const rows = await findDuplicateDocuments(deps.db, parsed.data.sha256);
		let counts = null;
		if (parsed.data.applicationId) {
			const [application] = await deps.db
				.select()
				.from(applications)
				.where(eq(applications.id, parsed.data.applicationId))
				.limit(1);
			if (!application) throw new HttpError(404, "NOT_FOUND", "not found");
			counts = await countDuplicateDocuments(
				deps.db,
				parsed.data.sha256,
				application.id,
				application.applicantUserId,
			);
		}
		await audit(deps, {
			applicationId: parsed.data.applicationId ?? rows[0]?.applicationId ?? null,
			actor,
			action: "fraud.duplicate_lookup",
			entity: "document_files",
			payload: {
				sha256Prefix: parsed.data.sha256.slice(0, 12),
				count: rows.length,
				counts,
			},
		});
		return c.json({
			sha256Prefix: parsed.data.sha256.slice(0, 12),
			count: rows.length,
			counts,
			rows: rows.map((row) => ({
				applicationReference: row.reference,
				documentFileId: row.documentFileId,
				kind: row.kind,
				uploadedAt: row.uploadedAt.toISOString(),
				explanationNote: row.explanationNote,
			})),
		});
	});

	app.post("/api/fraud-review/duplicates/explain", async (c) => {
		if (!fraudEnabled(deps)) throw new HttpError(404, "NOT_FOUND", "not found");
		const actor = actorOf(c);
		const { reviewer } = await requireFraudOfficer(deps.db, actor);
		if (!reviewer) throw new HttpError(403, "REVIEWER_REQUIRED", "fraud reviewer required");
		const parsed = duplicateExplainSchema.safeParse(await readJson(c));
		if (!parsed.success) throw invalidBody(parsed.error);
		await explainDuplicate(deps.db, {
			sha256: parsed.data.sha256,
			applicationId: parsed.data.applicationId,
			note: parsed.data.note,
			actor: { id: actor.id, role: "officer" },
			retentionDays: config.retentionDays,
			now: deps.runtime.now(),
		});
		return c.json({ ok: true });
	});

	// --- Service-only admin ---

	app.post("/internal/fraud-review/reviewers", requireService, async (c) => {
		const parsed = reviewerGrantSchema.safeParse(await readJson(c));
		if (!parsed.success) throw invalidBody(parsed.error);
		if (parsed.data.action === "grant") {
			await grantFraudReviewer(deps.db, {
				userId: parsed.data.userId,
				grantedBy: c.var.user.id,
				now: deps.runtime.now(),
			});
		} else {
			await revokeFraudReviewer(deps.db, {
				userId: parsed.data.userId,
				revokedBy: c.var.user.id,
				now: deps.runtime.now(),
			});
		}
		return c.json({ ok: true });
	});

	app.post("/internal/fraud-review/retention/run", requireService, async (c) => {
		const result = await runFraudReviewRetention(deps.db, { now: deps.runtime.now() });
		deps.logger.info(result, "fraud review retention");
		return c.json(result);
	});

	return app;
}

async function createReviewForCase(
	deps: IntegrityRouteDeps,
	input: {
		applicationId: string;
		actor: IntegrityActor;
		reasonCode: string;
		note: string | null;
		severity: IntegritySeverity;
		signalCodes: string[];
		documentRefs: string[];
		sourceHash: string;
	},
) {
	return createFraudReview(deps.db, {
		applicationId: input.applicationId,
		reasonCode: input.reasonCode,
		note: input.note,
		severity: input.severity,
		signalCodes: input.signalCodes,
		documentRefs: input.documentRefs,
		sourceHash: input.sourceHash,
		createdBy: input.actor.id,
		actorRole: input.actor.role,
		retentionDays: deps.runtime.config.retentionDays,
		now: deps.runtime.now(),
	});
}

async function getBriefForReview(
	deps: IntegrityRouteDeps,
	artifactId: string,
	applicationId: string,
): Promise<Record<string, unknown> | null> {
	const brief = await getBriefArtifact(deps.db, artifactId);
	if (!brief || brief.applicationId !== applicationId || brief.status !== "draft") return null;
	return {
		id: brief.id,
		status: brief.status,
		content: brief.content,
		citations: brief.citations,
		agentTrace: brief.agentTrace,
		model: brief.model,
		promptVersion: brief.promptVersion,
		createdAt: brief.createdAt.toISOString(),
	};
}

// `randomUUID` is reserved for future run idempotency keys; no side effects.
void randomUUID;
