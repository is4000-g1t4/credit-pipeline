// EN-01/02/03 officer routes for the case-assist module.
//
// Wire format: every officer route is off (404) unless ASSIST_ENABLED=true;
// applicant callers are 403; another officer's assigned case is a non-leaking
// 404. Service-only hold/retention routes stay available while disabled.
// Artifact content never enters logs or telemetry — only ids, versions, and
// counts. Validation runs before persistence and again before approval.
import type { Db } from "@credit/db/applications";
import {
	ARTIFACT_TYPES,
	validateGeneratedText,
	type ArtifactType,
	type ValidationIssue,
} from "@credit/core";
import {
	HttpError,
	readJson,
	requireOfficer,
	requireService,
	zodFields,
	type Logger,
	type ServiceApp,
	type ServiceVariables,
} from "@credit/service-kit";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { isUuid } from "../ids.js";
import { requireAssistCaseAccess, requireMemoableCase, type AssistActor } from "./access.js";
import {
	approveArtifact,
	createArtifact,
	createArtifactHold,
	getArtifact,
	listArtifacts,
	releaseArtifactHold,
	runArtifactRetention,
	tombstoneArtifact,
	updateArtifact,
} from "./artifacts.js";
import { assembleCaseEvidence } from "./evidence.js";
import { buildCreditMemo } from "./memo.js";
import type { AssistRuntime } from "./types.js";

const artifactTypeSchema = z.enum(ARTIFACT_TYPES);

// Provenance is server-owned. Callers cannot inject a model/prompt string
// into the artifact row or the audit payload.
const createSchema = z
	.object({
		type: artifactTypeSchema,
		content: z.unknown(),
	})
	.strict();

const updateSchema = z
	.object({
		expectedRevision: z.number().int().min(1),
		content: z.unknown(),
	})
	.strict();

const approveSchema = z
	.object({
		expectedRevision: z.number().int().min(1),
		confirm: z.literal(true),
	})
	.strict();

const tombstoneSchema = z
	.object({
		expectedRevision: z.number().int().min(1),
		reason: z.string().min(1).max(500),
	})
	.strict();

const holdSchema = z.object({ reason: z.string().min(1).max(500) }).strict();

export interface AssistRouteDeps {
	db: Db;
	runtime: AssistRuntime;
	logger: Logger;
}

function actorOf(user: { id: string; email: string; role: string }): AssistActor {
	return { id: user.id, email: user.email, role: user.role as AssistActor["role"] };
}

function invalidBody(error: z.ZodError): HttpError {
	return new HttpError(400, "VALIDATION_ERROR", "invalid request", zodFields(error));
}

function validationFailure(issues: ValidationIssue[]): {
	error: { code: "GENERATED_TEXT_INVALID"; message: string; issues: ValidationIssue[] };
} {
	return {
		error: {
			code: "GENERATED_TEXT_INVALID",
			message: "generated text failed validation",
			issues: issues.slice(0, 100),
		},
	};
}

function caseIdParam(value: string): string {
	if (!isUuid(value)) throw new HttpError(404, "NOT_FOUND", "not found");
	return value;
}

function hasDocumentCitation(artifact: {
	documentDerived?: boolean;
	citations: Array<{ ref: string }>;
}): boolean {
	return (
		artifact.documentDerived === true ||
		artifact.citations.some((citation) => citation.ref.startsWith("document:"))
	);
}

export function assistRoutes(deps: AssistRouteDeps): ServiceApp {
	const app: ServiceApp = new Hono<{ Variables: ServiceVariables }>();
	const { db, runtime, logger } = deps;
	const config = runtime.config;

	const sensitiveResponse = createMiddleware<{ Variables: ServiceVariables }>(async (c, next) => {
		c.header("Cache-Control", "no-store");
		c.header("X-Content-Type-Options", "nosniff");
		await next();
	});
	const featureGate = createMiddleware<{ Variables: ServiceVariables }>(async (_c, next) => {
		if (!config.enabled) throw new HttpError(404, "NOT_FOUND", "not found");
		await next();
	});
	app.use("/api/assist/*", sensitiveResponse);
	// Applicant 403 before the flag-off 404 (G2 over G1), matching the other
	// officer routes. Scoped to the officer prefix only: mounting a `*`
	// middleware at "/" would also 404 every applications route while the
	// flag is off. Internal hold/retention routes stay available.
	app.use("/api/assist/*", requireOfficer);
	app.use("/api/assist/*", featureGate);

	const loadCase = (applicationId: string, actor: AssistActor) =>
		requireAssistCaseAccess(db, applicationId, actor);

	const assembleFor = (kase: Awaited<ReturnType<typeof loadCase>>, actor: AssistActor) =>
		assembleCaseEvidence({
			db,
			application: kase.application,
			officer: actor,
			assignedToMe: kase.assignedToMe,
			documentsEnabled: runtime.documentsEnabled,
			now: runtime.now(),
			research: {
				url: config.researchUrl,
				secret: config.internalSecret,
				timeoutMs: config.researchTimeoutMs,
				fetchImpl: runtime.researchFetchImpl,
			},
		});

	const requireArtifactContentAccess = (
		kase: Awaited<ReturnType<typeof loadCase>>,
		artifact: { documentDerived?: boolean; citations: Array<{ ref: string }> },
	): void => {
		if (hasDocumentCitation(artifact) && !kase.assignedToMe) {
			throw new HttpError(404, "NOT_FOUND", "not found");
		}
	};

	const loadArtifact = async (id: string) => {
		if (!isUuid(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const artifact = await getArtifact(db, id);
		if (!artifact) throw new HttpError(404, "NOT_FOUND", "not found");
		return artifact;
	};

	app.get("/api/assist/cases/:id/evidence", requireOfficer, async (c) => {
		const applicationId = caseIdParam(c.req.param("id"));
		const actor = actorOf(c.var.user);
		const kase = await loadCase(applicationId, actor);
		const evidence = await assembleFor(kase, actor);
		logger.info(
			{
				applicationId,
				itemCount: evidence.items.length,
				unavailableCount: evidence.unavailable.length,
			},
			"assist evidence assembled",
		);
		return c.json({ bundle: evidence, assignedToMe: kase.assignedToMe });
	});

	app.post("/api/assist/cases/:id/memos", requireOfficer, async (c) => {
		const applicationId = caseIdParam(c.req.param("id"));
		const actor = actorOf(c.var.user);
		const kase = await loadCase(applicationId, actor);
		requireMemoableCase(kase);
		const evidence = await assembleFor(kase, actor);
		const content = buildCreditMemo({ application: kase.application, evidence });
		const validation = validateGeneratedText({
			artifactType: "credit_memo",
			content,
			evidence,
		});
		if (!validation.ok) {
			// A builder bug must fail closed, never persist a partial memo.
			logger.warn(
				{ applicationId, issueCount: validation.issues.length },
				"assist memo validation failed",
			);
			return c.json(validationFailure(validation.issues), 422);
		}
		const artifact = await createArtifact(db, {
			applicationId,
			type: "credit_memo",
			content: validation.content,
			citations: validation.citations,
			documentDerived: evidence.items.some((item) => item.sourceType === "document"),
			createdBy: actor.id,
			actorRole: actor.role,
			model: config.model,
			promptVersion: config.promptVersion,
			retentionDays: config.retentionDays,
			now: runtime.now(),
		});
		logger.info(
			{ applicationId, artifactId: artifact.id, version: artifact.version },
			"assist memo drafted",
		);
		return c.json({ artifact }, 201);
	});

	app.post("/api/assist/cases/:id/artifacts", requireOfficer, async (c) => {
		const applicationId = caseIdParam(c.req.param("id"));
		const parsed = createSchema.safeParse(await readJson(c));
		if (!parsed.success) throw invalidBody(parsed.error);
		const actor = actorOf(c.var.user);
		const kase = await loadCase(applicationId, actor);
		if (parsed.data.type === "credit_memo") requireMemoableCase(kase);
		const evidence = await assembleFor(kase, actor);
		const validation = validateGeneratedText({
			artifactType: parsed.data.type,
			content: parsed.data.content,
			evidence,
		});
		if (!validation.ok) return c.json(validationFailure(validation.issues), 422);
		const artifact = await createArtifact(db, {
			applicationId,
			type: parsed.data.type,
			content: validation.content,
			citations: validation.citations,
			documentDerived: evidence.items.some((item) => item.sourceType === "document"),
			createdBy: actor.id,
			actorRole: actor.role,
			model: config.model,
			promptVersion: config.promptVersion,
			retentionDays: config.retentionDays,
			now: runtime.now(),
		});
		logger.info(
			{ applicationId, artifactId: artifact.id, type: artifact.type, version: artifact.version },
			"assist artifact created",
		);
		return c.json({ artifact }, 201);
	});

	app.get("/api/assist/cases/:id/artifacts", requireOfficer, async (c) => {
		const applicationId = caseIdParam(c.req.param("id"));
		const actor = actorOf(c.var.user);
		const kase = await loadCase(applicationId, actor);
		const rawType = c.req.query("type");
		if (rawType !== undefined && !(ARTIFACT_TYPES as readonly string[]).includes(rawType)) {
			throw new HttpError(400, "VALIDATION_ERROR", "invalid artifact type");
		}
		const items = await listArtifacts(
			db,
			applicationId,
			rawType === undefined ? undefined : (rawType as ArtifactType),
		);
		const visible = kase.assignedToMe
			? items
			: items.filter((artifact) => !hasDocumentCitation(artifact));
		return c.json({ items: visible });
	});

	app.get("/api/assist/artifacts/:id", requireOfficer, async (c) => {
		const artifact = await loadArtifact(c.req.param("id"));
		const kase = await loadCase(artifact.applicationId, actorOf(c.var.user));
		requireArtifactContentAccess(kase, artifact);
		return c.json({ artifact });
	});

	app.patch("/api/assist/artifacts/:id", requireOfficer, async (c) => {
		const artifact = await loadArtifact(c.req.param("id"));
		const actor = actorOf(c.var.user);
		const kase = await loadCase(artifact.applicationId, actor);
		requireArtifactContentAccess(kase, artifact);
		const parsed = updateSchema.safeParse(await readJson(c));
		if (!parsed.success) throw invalidBody(parsed.error);
		const evidence = await assembleFor(kase, actor);
		const validation = validateGeneratedText({
			artifactType: artifact.type,
			content: parsed.data.content,
			evidence,
		});
		if (!validation.ok) return c.json(validationFailure(validation.issues), 422);
		const result = await updateArtifact(db, {
			id: artifact.id,
			actor: actor.id,
			actorRole: actor.role,
			expectedRevision: parsed.data.expectedRevision,
			content: validation.content,
			citations: validation.citations,
			documentDerived: evidence.items.some((item) => item.sourceType === "document"),
			model: artifact.model,
			promptVersion: artifact.promptVersion,
			retentionDays: config.retentionDays,
			now: runtime.now(),
		});
		logger.info(
			{
				applicationId: artifact.applicationId,
				artifactId: result.artifact.id,
				version: result.artifact.version,
				createdVersion: result.createdVersion,
			},
			"assist artifact updated",
		);
		return c.json({
			artifact: result.artifact,
			createdVersion: result.createdVersion,
		});
	});

	app.post("/api/assist/artifacts/:id/approve", requireOfficer, async (c) => {
		const artifact = await loadArtifact(c.req.param("id"));
		const actor = actorOf(c.var.user);
		const kase = await loadCase(artifact.applicationId, actor);
		requireArtifactContentAccess(kase, artifact);
		const parsed = approveSchema.safeParse(await readJson(c));
		if (!parsed.success) throw invalidBody(parsed.error);
		if (artifact.status !== "draft") {
			throw new HttpError(409, "NOT_DRAFT", "only drafts can be approved");
		}
		if (artifact.revision !== parsed.data.expectedRevision) {
			throw new HttpError(409, "VERSION_CONFLICT", "the draft changed since it was read");
		}
		const evidence = await assembleFor(kase, actor);
		const validation = validateGeneratedText({
			artifactType: artifact.type,
			content: artifact.content,
			evidence,
		});
		if (!validation.ok) return c.json(validationFailure(validation.issues), 422);
		const approved = await approveArtifact(db, {
			id: artifact.id,
			actor: actor.id,
			actorRole: actor.role,
			expectedRevision: parsed.data.expectedRevision,
			now: runtime.now(),
		});
		logger.info(
			{ applicationId: approved.applicationId, artifactId: approved.id, version: approved.version },
			"assist artifact approved",
		);
		return c.json({ artifact: approved });
	});

	app.post("/api/assist/artifacts/:id/tombstone", requireOfficer, async (c) => {
		const artifact = await loadArtifact(c.req.param("id"));
		const actor = actorOf(c.var.user);
		const kase = await loadCase(artifact.applicationId, actor);
		requireArtifactContentAccess(kase, artifact);
		const parsed = tombstoneSchema.safeParse(await readJson(c));
		if (!parsed.success) throw invalidBody(parsed.error);
		const tombstoned = await tombstoneArtifact(db, {
			id: artifact.id,
			actor: actor.id,
			actorRole: actor.role,
			expectedRevision: parsed.data.expectedRevision,
			reason: parsed.data.reason,
			now: runtime.now(),
		});
		logger.info(
			{ applicationId: tombstoned.applicationId, artifactId: tombstoned.id },
			"assist artifact tombstoned",
		);
		return c.json({ artifact: tombstoned });
	});

	// --- Service-only retention/hold controls (never gateway-exposed). ---

	app.post("/internal/assist/artifacts/:id/holds", requireService, async (c) => {
		const artifactId = c.req.param("id");
		if (!isUuid(artifactId)) throw new HttpError(404, "NOT_FOUND", "not found");
		const parsed = holdSchema.safeParse(await readJson(c));
		if (!parsed.success) throw invalidBody(parsed.error);
		const hold = await createArtifactHold(db, {
			artifactId,
			reason: parsed.data.reason,
			createdBy: c.var.user.id,
			actorRole: c.var.user.role,
			now: runtime.now(),
		});
		return c.json(hold, 201);
	});

	app.post("/internal/assist/artifacts/:id/holds/:holdId/release", requireService, async (c) => {
		const artifactId = c.req.param("id");
		const holdId = c.req.param("holdId");
		if (!isUuid(artifactId) || !isUuid(holdId)) {
			throw new HttpError(404, "NOT_FOUND", "not found");
		}
		const released = await releaseArtifactHold(db, {
			artifactId,
			holdId,
			actor: c.var.user.id,
			actorRole: c.var.user.role,
			now: runtime.now(),
		});
		return c.json(released);
	});

	app.post("/internal/assist/retention/run", requireService, async (c) => {
		const result = await runArtifactRetention(db, { now: runtime.now() });
		logger.info(result, "assist artifact retention");
		return c.json(result);
	});

	return app;
}
