// EN-01/02/03 officer routes for the case-assist module.
//
// Wire format: every officer route is off (404) unless ASSIST_ENABLED=true;
// applicant callers are 403; another officer's assigned case is a non-leaking
// 404. Service-only hold/retention routes stay available while disabled.
// Artifact content never enters logs or telemetry — only ids, versions, and
// counts. Validation runs before persistence and again before approval.
import { decisions, scores, withTx, type Db } from "@credit/db/applications";
import {
	ADVERSE_TAXONOMY_VERSION,
	ARTIFACT_TYPES,
	FAIR_LENDING_DENY_LIST_VERSION,
	resolveAdverseJurisdictionProfile,
	validateAdverseJurisdictionProfile,
	validateAdverseLetterContent,
	validateAdverseLetterDecisionBinding,
	validateGeneratedText,
	type AdverseActionLetterContent,
	type AdverseJurisdictionProfile,
	type ArtifactType,
	type ValidationIssue,
} from "@credit/core";
import {
	HttpError,
	readJson,
	requireOfficer,
	requireService,
	writeAudit,
	zodFields,
	type Logger,
	type ServiceApp,
	type ServiceVariables,
} from "@credit/service-kit";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { isUuid } from "../ids.js";
import { requireAssistCaseAccess, requireMemoableCase, type AssistActor } from "./access.js";
import {
	approveArtifact,
	createArtifact,
	createArtifactHold,
	findArtifactByEvidence,
	getArtifact,
	listArtifacts,
	releaseArtifactHold,
	runArtifactRetention,
	tombstoneArtifact,
	updateArtifact,
} from "./artifacts.js";
import {
	buildAdverseActionLetter,
	buildAdverseReasonFacts,
	decisionReasonCodes,
	decisionSnapshotVersions,
	type AdverseLetterBuildFailure,
} from "./adverse.js";
import { assembleCaseEvidence } from "./evidence.js";
import { buildCreditMemo } from "./memo.js";
import { MemoAgentError, runMemoAgent } from "./memo-agent.js";
import { evidenceHash } from "./memo-trace.js";
import type {
	ArtifactAuditMetadata,
	ArtifactDto,
	AssistConfig,
	AssistRuntime,
	MemoAgentTrace,
} from "./types.js";

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

function adverseFailureBody(failure: AdverseLetterBuildFailure): {
	status: number;
	body: {
		error: {
			code: string;
			message: string;
			details?: Record<string, unknown>;
		};
	};
} {
	if (failure.code === "NOT_DECLINED") {
		return {
			status: 409,
			body: {
				error: {
					code: "CASE_NOT_DECLINED",
					message: "the case has no declined decision to explain",
				},
			},
		};
	}
	if (failure.code === "DISCLOSURE_UNAVAILABLE") {
		return {
			status: 422,
			body: {
				error: {
					code: "DISCLOSURE_UNAVAILABLE",
					message: failure.detail,
					details: { issues: failure.issues ?? [] },
				},
			},
		};
	}
	if (failure.code === "FAIR_LENDING_BLOCKED") {
		return {
			status: 422,
			body: {
				error: {
					code: "FAIR_LENDING_BLOCKED",
					message: failure.detail,
					details: {
						terms: failure.terms ?? [],
						reasonCodes: failure.reasonCodes ?? [],
					},
				},
			},
		};
	}
	return {
		status: 422,
		body: {
			error: {
				code: "NEEDS_OFFICER_INPUT",
				message: failure.detail,
				details: {
					reasonCodes: failure.reasonCodes ?? [],
					unmappedCodes: failure.unmappedCodes ?? [],
					missingCitationCodes: failure.missingCitationCodes ?? [],
					requiredMin: failure.requiredMin ?? null,
					requiredMax: failure.requiredMax ?? null,
				},
			},
		},
	};
}

function adverseProfileFailure(issues: Array<{ code: string; message: string }>): {
	error: {
		code: "ADVERSE_PROFILE_INVALID";
		message: string;
		issues: Array<{ code: string; message: string }>;
	};
} {
	return {
		error: {
			code: "ADVERSE_PROFILE_INVALID",
			message: "adverse-action letter does not satisfy its jurisdiction profile",
			issues: issues.slice(0, 50),
		},
	};
}

function adverseDecisionFailure(issues: Array<{ code: string; message: string }>): {
	error: {
		code: "ADVERSE_DECISION_MISMATCH";
		message: string;
		issues: Array<{ code: string; message: string }>;
	};
} {
	return {
		error: {
			code: "ADVERSE_DECISION_MISMATCH",
			message: "adverse-action letter does not match the case decision",
			issues: issues.slice(0, 50),
		},
	};
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

/** Idempotent replay only within the current writer configuration: the
 * existing artifact must have been produced by the current mode and
 * versions. A hash hit from the other writer (or a version drift)
 * regenerates instead of returning stale provenance. */
function memoReplayMatches(artifact: ArtifactDto, config: AssistConfig): boolean {
	const trace = artifact.agentTrace;
	if (config.memoWriter === "agent") {
		return (
			trace?.writer === "agent" &&
			artifact.model === config.memoModel &&
			artifact.promptVersion === config.memoPromptVersion &&
			trace?.agentVersion === config.memoAgentVersion
		);
	}
	return (
		trace?.writer === "deterministic" &&
		artifact.model === config.model &&
		artifact.promptVersion === config.promptVersion
	);
}

function adverseAuditMetadata(input: {
	content: AdverseActionLetterContent;
	profile: AdverseJurisdictionProfile;
	decision: typeof decisions.$inferSelect;
	droppedReasonCodes?: string[];
}): ArtifactAuditMetadata {
	const versions = decisionSnapshotVersions(input.decision);
	return {
		decisionId: input.decision.id,
		reasonCodes: input.content.principalReasons.map((reason) => reason.code),
		...(input.droppedReasonCodes === undefined
			? {}
			: { droppedReasonCodes: input.droppedReasonCodes }),
		jurisdiction: input.content.jurisdiction,
		profileVersion: input.content.profileVersion,
		profileWordingHash: input.profile.wordingHash,
		taxonomyVersion: ADVERSE_TAXONOMY_VERSION,
		legalReviewRef: input.profile.legalReview.reference,
		policyVersion: versions.policyVersion,
		scorecardVersion: versions.scorecardVersion,
		citationRefs: input.content.principalReasons.flatMap((reason) =>
			reason.citations.map((citation) => citation.ref),
		),
		fairLendingScan: "passed",
		fairLendingDenyListVersion: FAIR_LENDING_DENY_LIST_VERSION,
	};
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

	const requireAdverseProfile = (): AdverseJurisdictionProfile => {
		const profile = resolveAdverseJurisdictionProfile(config.adverseJurisdiction);
		if (!profile) {
			throw new HttpError(
				409,
				"JURISDICTION_UNSUPPORTED",
				"adverse-action jurisdiction is not supported",
			);
		}
		const profileValidation = validateAdverseJurisdictionProfile(profile);
		if (!profileValidation.ok) {
			throw new HttpError(
				422,
				"DISCLOSURE_UNAVAILABLE",
				"the adverse-action jurisdiction profile is not approved",
				{ issues: profileValidation.issues.map((issue) => issue.code) },
			);
		}
		if (config.adverseContactPath.trim().length === 0 || config.adverseContactPath.length > 300) {
			throw new HttpError(
				422,
				"DISCLOSURE_UNAVAILABLE",
				"the adverse-action contact path is missing or too long",
			);
		}
		return profile;
	};

	const loadDecisionRow = async (applicationId: string) => {
		const rows = await db
			.select()
			.from(decisions)
			.where(eq(decisions.applicationId, applicationId))
			.limit(1);
		return rows[0] ?? null;
	};

	const loadScoreRow = async (applicationId: string) => {
		const rows = await db
			.select()
			.from(scores)
			.where(eq(scores.applicationId, applicationId))
			.orderBy(desc(scores.createdAt), desc(scores.id))
			.limit(1);
		return rows[0] ?? null;
	};

	const auditAdverseBlocked = async (
		artifact: {
			id: string;
			applicationId: string;
			type: string;
			version: number;
			revision: number;
		},
		actor: AssistActor,
		action: "edit" | "approve",
		issueCodes: string[],
	): Promise<void> => {
		await withTx(db, (tx) =>
			writeAudit(tx, {
				applicationId: artifact.applicationId,
				actor: actor.id,
				action: `artifact.${action}_blocked`,
				entity: "generated_artifact",
				payload: {
					feature: "assist",
					artifactId: artifact.id,
					applicationId: artifact.applicationId,
					type: artifact.type,
					version: artifact.version,
					revision: artifact.revision,
					actorRole: actor.role,
					issueCodes: issueCodes.slice(0, 50),
				},
			}),
		);
	};

	const auditAdverseGenerateBlocked = async (input: {
		applicationId: string;
		actor: AssistActor;
		decisionId: string | null;
		failureCode: string;
		detail: string;
		issueCodes: string[];
		jurisdiction: string;
		profileVersion: string;
		profileWordingHash: string | null;
		model: string;
		promptVersion: string;
	}): Promise<void> => {
		await withTx(db, (tx) =>
			writeAudit(tx, {
				applicationId: input.applicationId,
				actor: input.actor.id,
				action: "artifact.generate_blocked",
				entity: "generated_artifact",
				payload: {
					feature: "assist",
					applicationId: input.applicationId,
					decisionId: input.decisionId,
					failureCode: input.failureCode,
					detail: input.detail,
					issueCodes: input.issueCodes.slice(0, 50),
					jurisdiction: input.jurisdiction,
					profileVersion: input.profileVersion,
					profileWordingHash: input.profileWordingHash,
					taxonomyVersion: ADVERSE_TAXONOMY_VERSION,
					model: input.model,
					promptVersion: input.promptVersion,
					fairLendingDenyListVersion: FAIR_LENDING_DENY_LIST_VERSION,
					actorRole: input.actor.role,
				},
			}),
		);
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
		const startedAt = Date.now();
		// Idempotent replay: identical evidence replays the newest non-deleted
		// memo instead of regenerating (and racing the draft guard).
		const hash = evidenceHash(evidence);
		const replayed = await findArtifactByEvidence(db, {
			applicationId,
			type: "credit_memo",
			evidenceHash: hash,
		});
		if (replayed && memoReplayMatches(replayed, config)) {
			return c.json({ artifact: replayed, replayed: true }, 200);
		}
		const documentDerived = evidence.items.some((item) => item.sourceType === "document");

		if (config.memoWriter === "agent") {
			const memoModel = runtime.memoModel;
			// Fails closed without leaking config: no key names, no model ids.
			if (!memoModel) {
				throw new HttpError(503, "MEMO_AGENT_UNAVAILABLE", "memo agent is not configured");
			}
			let result: Awaited<ReturnType<typeof runMemoAgent>>;
			try {
				result = await runMemoAgent({
					application: kase.application,
					evidence,
					model: memoModel,
					config: {
						model: config.memoModel,
						promptVersion: config.memoPromptVersion,
						agentVersion: config.memoAgentVersion,
						maxSteps: config.memoMaxSteps,
						maxToolCalls: config.memoMaxToolCalls,
						timeoutMs: config.memoTimeoutMs,
						maxCostUsd: config.memoMaxCostUsd,
					},
					signal: AbortSignal.timeout(config.memoTimeoutMs),
				});
			} catch (err) {
				if (err instanceof MemoAgentError) {
					// Metadata only: error code plus the issue count, never
					// generated text, quotes, or evidence.
					logger.warn(
						{ applicationId, code: err.code, issueCount: err.issues.length },
						"assist memo agent failed",
					);
					if (err.code === "TIMEOUT") {
						throw new HttpError(504, "MEMO_AGENT_TIMEOUT", "memo agent timed out");
					}
					if (err.code === "MODEL_ERROR") {
						throw new HttpError(502, "MEMO_AGENT_UNAVAILABLE", "memo agent is unavailable");
					}
					if (
						err.code === "STEP_LIMIT" ||
						err.code === "TOOL_CALL_LIMIT" ||
						err.code === "BUDGET_EXCEEDED"
					) {
						throw new HttpError(422, "MEMO_AGENT_BUDGET", "memo agent budget exceeded");
					}
					throw new HttpError(422, "MEMO_AGENT_INVALID", "memo agent output failed validation");
				}
				throw err;
			}
			const validation = validateGeneratedText({
				artifactType: "credit_memo",
				content: result.content,
				evidence,
			});
			if (!validation.ok) {
				// A model bug must fail closed, never persist a partial memo.
				logger.warn(
					{ applicationId, issueCount: validation.issues.length },
					"assist memo validation failed",
				);
				return c.json(validationFailure(validation.issues), 422);
			}
			const trace = result.trace;
			const artifact = await createArtifact(db, {
				applicationId,
				type: "credit_memo",
				content: validation.content,
				citations: validation.citations,
				documentDerived,
				createdBy: actor.id,
				actorRole: actor.role,
				model: config.memoModel,
				promptVersion: config.memoPromptVersion,
				retentionDays: config.retentionDays,
				supersedeDraft: true,
				agentTrace: trace,
				evidenceHash: hash,
				auditMetadata: {
					writer: trace.writer,
					agentVersion: trace.agentVersion,
					toolCallCount: trace.toolCalls.length,
					sourceRefCount: trace.sourceRefs.length,
					repairAttempted: trace.repairAttempted,
				},
				now: runtime.now(),
			});
			logger.info(
				{
					applicationId,
					artifactId: artifact.id,
					version: artifact.version,
					writer: trace.writer,
					toolCallCount: trace.toolCalls.length,
				},
				"assist memo drafted",
			);
			return c.json({ artifact }, 201);
		}

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
		// Deterministic writer, agent-shaped provenance: zero tools/tokens,
		// citations as the source refs, wall-clock latency only.
		const trace: MemoAgentTrace = {
			writer: "deterministic",
			agentVersion: config.memoAgentVersion,
			model: config.model,
			promptVersion: config.promptVersion,
			evidenceHash: hash,
			steps: 1,
			toolCalls: [],
			sourceRefs: [...new Set(validation.citations.map((citation) => citation.ref))].sort(),
			repairAttempted: false,
			repairSucceeded: null,
			fallbackReason: null,
			inputTokens: 0,
			outputTokens: 0,
			latencyMs: Math.max(0, Date.now() - startedAt),
		};
		const artifact = await createArtifact(db, {
			applicationId,
			type: "credit_memo",
			content: validation.content,
			citations: validation.citations,
			documentDerived,
			createdBy: actor.id,
			actorRole: actor.role,
			model: config.model,
			promptVersion: config.promptVersion,
			retentionDays: config.retentionDays,
			supersedeDraft: true,
			agentTrace: trace,
			evidenceHash: hash,
			auditMetadata: {
				writer: trace.writer,
				agentVersion: trace.agentVersion,
				toolCallCount: 0,
				sourceRefCount: trace.sourceRefs.length,
				repairAttempted: false,
			},
			now: runtime.now(),
		});
		logger.info(
			{ applicationId, artifactId: artifact.id, version: artifact.version, writer: trace.writer },
			"assist memo drafted",
		);
		return c.json({ artifact }, 201);
	});

	// EN-08 / US-ADV-1/2: deterministic letter from the terminal decline.
	// Only this route may create an adverse-action letter; generic artifact
	// creation is rejected below so the taxonomy cannot be bypassed.
	app.post("/api/assist/cases/:id/adverse-action", requireOfficer, async (c) => {
		const applicationId = caseIdParam(c.req.param("id"));
		const actor = actorOf(c.var.user);
		const kase = await loadCase(applicationId, actor);
		if (kase.application.status !== "declined") {
			throw new HttpError(409, "CASE_NOT_DECLINED", "the case has no declined decision to explain");
		}
		const decision = await loadDecisionRow(applicationId);
		if (!decision || decision.outcome !== "declined") {
			throw new HttpError(409, "CASE_NOT_DECLINED", "the case has no declined decision to explain");
		}
		let profile: AdverseJurisdictionProfile;
		try {
			profile = requireAdverseProfile();
		} catch (err) {
			if (err instanceof HttpError) {
				await auditAdverseGenerateBlocked({
					applicationId,
					actor,
					decisionId: decision.id,
					failureCode: err.code,
					detail: err.message,
					issueCodes: err.fields?.issues ?? [],
					jurisdiction: config.adverseJurisdiction,
					profileVersion: "",
					profileWordingHash: null,
					model: config.model,
					promptVersion: config.adversePromptVersion,
				});
			}
			throw err;
		}
		const score = await loadScoreRow(applicationId);
		const evidence = await assembleFor(kase, actor);
		const built = buildAdverseActionLetter({
			application: kase.application,
			decision,
			score,
			evidence,
			profile,
			contactPath: config.adverseContactPath,
		});
		if (!built.ok) {
			const mapped = adverseFailureBody(built.failure);
			logger.warn(
				{
					applicationId,
					code: built.failure.code,
					detail: built.failure.detail,
					issueCount: built.failure.issues?.length ?? 0,
				},
				"assist adverse action letter blocked",
			);
			await auditAdverseGenerateBlocked({
				applicationId,
				actor,
				decisionId: decision.id,
				failureCode: built.failure.code,
				detail: built.failure.detail,
				issueCodes: [
					...(built.failure.issues ?? []),
					...(built.failure.unmappedCodes ?? []),
					...(built.failure.missingCitationCodes ?? []),
				],
				jurisdiction: profile.code,
				profileVersion: profile.version,
				profileWordingHash: profile.wordingHash,
				model: config.model,
				promptVersion: config.adversePromptVersion,
			});
			return c.json(mapped.body, mapped.status === 409 ? 409 : 422);
		}
		const validation = validateGeneratedText({
			artifactType: "adverse_action_letter",
			content: built.content,
			evidence,
		});
		if (!validation.ok) {
			logger.warn(
				{ applicationId, issueCount: validation.issues.length },
				"assist adverse action letter validation failed",
			);
			await auditAdverseGenerateBlocked({
				applicationId,
				actor,
				decisionId: decision.id,
				failureCode: "GENERATED_TEXT_INVALID",
				detail: "generated text failed validation",
				issueCodes: validation.issues.map((issue) => issue.code),
				jurisdiction: profile.code,
				profileVersion: profile.version,
				profileWordingHash: profile.wordingHash,
				model: config.model,
				promptVersion: config.adversePromptVersion,
			});
			return c.json(validationFailure(validation.issues), 422);
		}
		const content = validation.content as AdverseActionLetterContent;
		const artifact = await createArtifact(db, {
			applicationId,
			type: "adverse_action_letter",
			content,
			citations: validation.citations,
			documentDerived: content.principalReasons.some((reason) =>
				reason.citations.some((citation) => citation.ref.startsWith("document:")),
			),
			createdBy: actor.id,
			actorRole: actor.role,
			model: config.model,
			promptVersion: config.adversePromptVersion,
			retentionDays: config.retentionDays,
			auditMetadata: adverseAuditMetadata({
				content,
				profile,
				decision,
				droppedReasonCodes: built.droppedCodes,
			}),
			now: runtime.now(),
		});
		logger.info(
			{
				applicationId,
				artifactId: artifact.id,
				version: artifact.version,
				jurisdiction: profile.code,
				profileVersion: profile.version,
				reasonCount: content.principalReasons.length,
			},
			"assist adverse action letter drafted",
		);
		return c.json(
			{
				artifact,
				principalReasons: built.reasons,
				droppedReasonCodes: built.droppedCodes,
				decisionId: decision.id,
				jurisdiction: profile.code,
				profileVersion: profile.version,
			},
			201,
		);
	});

	app.post("/api/assist/cases/:id/artifacts", requireOfficer, async (c) => {
		const applicationId = caseIdParam(c.req.param("id"));
		const parsed = createSchema.safeParse(await readJson(c));
		if (!parsed.success) throw invalidBody(parsed.error);
		const actor = actorOf(c.var.user);
		const kase = await loadCase(applicationId, actor);
		if (parsed.data.type === "credit_memo") requireMemoableCase(kase);
		if (parsed.data.type === "adverse_action_letter") {
			throw new HttpError(
				422,
				"DEDICATED_ROUTE_REQUIRED",
				"adverse-action letters must be generated from a declined case",
			);
		}
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
		const adverseContext =
			artifact.type === "adverse_action_letter"
				? {
						profile: requireAdverseProfile(),
						decision: await loadDecisionRow(artifact.applicationId),
						score: await loadScoreRow(artifact.applicationId),
					}
				: null;
		if (adverseContext !== null && adverseContext.decision === null) {
			throw new HttpError(409, "CASE_NOT_DECLINED", "the case decision is missing");
		}
		const adverseDecision = adverseContext?.decision ?? null;
		const evidence = await assembleFor(kase, actor);
		const validation = validateGeneratedText({
			artifactType: artifact.type,
			content: parsed.data.content,
			evidence,
		});
		if (!validation.ok) {
			if (adverseContext !== null) {
				await auditAdverseBlocked(
					artifact,
					actor,
					"edit",
					validation.issues.map((issue) => issue.code),
				);
			}
			return c.json(validationFailure(validation.issues), 422);
		}
		let adverseContent: AdverseActionLetterContent | null = null;
		if (adverseContext !== null && adverseDecision !== null) {
			const content = validation.content as AdverseActionLetterContent;
			const profileValidation = validateAdverseLetterContent(content, adverseContext.profile);
			if (!profileValidation.ok) {
				await auditAdverseBlocked(
					artifact,
					actor,
					"edit",
					profileValidation.issues.map((issue) => issue.code),
				);
				return c.json(adverseProfileFailure(profileValidation.issues), 422);
			}
			const binding = validateAdverseLetterDecisionBinding({
				content,
				applicationId: kase.application.id,
				decisionId: adverseDecision.id,
				decisionReasonCodes: decisionReasonCodes(adverseDecision),
				profile: adverseContext.profile,
				contactPath: config.adverseContactPath,
				facts: buildAdverseReasonFacts(
					kase.application,
					adverseDecision,
					adverseContext.score,
					evidence,
				),
			});
			if (!binding.ok) {
				await auditAdverseBlocked(
					artifact,
					actor,
					"edit",
					binding.issues.map((issue) => issue.code),
				);
				return c.json(adverseDecisionFailure(binding.issues), 422);
			}
			adverseContent = content;
		}
		const result = await updateArtifact(db, {
			id: artifact.id,
			actor: actor.id,
			actorRole: actor.role,
			expectedRevision: parsed.data.expectedRevision,
			content: validation.content,
			citations: validation.citations,
			documentDerived:
				adverseContent === null
					? evidence.items.some((item) => item.sourceType === "document")
					: adverseContent.principalReasons.some((reason) =>
							reason.citations.some((citation) => citation.ref.startsWith("document:")),
						),
			model: artifact.model,
			promptVersion: artifact.promptVersion,
			retentionDays: config.retentionDays,
			auditMetadata:
				adverseContent !== null && adverseContext !== null && adverseDecision !== null
					? adverseAuditMetadata({
							content: adverseContent,
							profile: adverseContext.profile,
							decision: adverseDecision,
							droppedReasonCodes: decisionReasonCodes(adverseDecision).filter(
								(code) => !adverseContent.principalReasons.some((reason) => reason.code === code),
							),
						})
					: undefined,
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
		const adverseContext =
			artifact.type === "adverse_action_letter"
				? {
						profile: requireAdverseProfile(),
						decision: await loadDecisionRow(artifact.applicationId),
						score: await loadScoreRow(artifact.applicationId),
					}
				: null;
		if (adverseContext !== null && adverseContext.decision === null) {
			throw new HttpError(409, "CASE_NOT_DECLINED", "the case decision is missing");
		}
		const adverseDecision = adverseContext?.decision ?? null;
		const evidence = await assembleFor(kase, actor);
		const validation = validateGeneratedText({
			artifactType: artifact.type,
			content: artifact.content,
			evidence,
		});
		if (!validation.ok) {
			if (adverseContext !== null) {
				await auditAdverseBlocked(
					artifact,
					actor,
					"approve",
					validation.issues.map((issue) => issue.code),
				);
			}
			return c.json(validationFailure(validation.issues), 422);
		}
		let adverseContent: AdverseActionLetterContent | null = null;
		if (adverseContext !== null && adverseDecision !== null) {
			const content = validation.content as AdverseActionLetterContent;
			const profileValidation = validateAdverseLetterContent(content, adverseContext.profile);
			if (!profileValidation.ok) {
				await auditAdverseBlocked(
					artifact,
					actor,
					"approve",
					profileValidation.issues.map((issue) => issue.code),
				);
				return c.json(adverseProfileFailure(profileValidation.issues), 422);
			}
			const binding = validateAdverseLetterDecisionBinding({
				content,
				applicationId: kase.application.id,
				decisionId: adverseDecision.id,
				decisionReasonCodes: decisionReasonCodes(adverseDecision),
				profile: adverseContext.profile,
				contactPath: config.adverseContactPath,
				facts: buildAdverseReasonFacts(
					kase.application,
					adverseDecision,
					adverseContext.score,
					evidence,
				),
			});
			if (!binding.ok) {
				await auditAdverseBlocked(
					artifact,
					actor,
					"approve",
					binding.issues.map((issue) => issue.code),
				);
				return c.json(adverseDecisionFailure(binding.issues), 422);
			}
			adverseContent = content;
		}
		const approved = await approveArtifact(db, {
			id: artifact.id,
			actor: actor.id,
			actorRole: actor.role,
			expectedRevision: parsed.data.expectedRevision,
			auditMetadata:
				adverseContent !== null && adverseContext !== null && adverseDecision !== null
					? adverseAuditMetadata({
							content: adverseContent,
							profile: adverseContext.profile,
							decision: adverseDecision,
							droppedReasonCodes: decisionReasonCodes(adverseDecision).filter(
								(code) => !adverseContent.principalReasons.some((reason) => reason.code === code),
							),
						})
					: undefined,
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
