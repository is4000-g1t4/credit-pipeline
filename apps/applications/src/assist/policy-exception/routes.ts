// E3 policy-exception officer routes: view, explain, follow-up, memo draft.
//
// Flag-off is an opaque 404. Applicant callers are 403 via the parent
// assist middleware; this module adds the policy-exception flag gate.
// View degrades to `sourceStatus: "unavailable"` when the policy bridge is
// down; explain/follow-up/memo fail closed with typed errors. Artifact
// content never enters logs or telemetry — ids, codes, and counts only.
import {
	classifyPolicyScope,
	hasDirectIdentifier,
	hmacQuestion,
	POLICY_REGISTRY_HASH,
	POLICY_REGISTRY_VERSION,
	validateGeneratedText,
} from "@credit/core";
import { withTx, type Db } from "@credit/db/applications";
import {
	HttpError,
	readJson,
	requireOfficer,
	writeAudit,
	zodFields,
	type Logger,
	type ServiceApp,
	type ServiceVariables,
} from "@credit/service-kit";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { isUuid } from "../../ids.js";
import { requireAssistCaseAccess, requireMemoableCase, type AssistActor } from "../access.js";
import { createArtifact, listArtifacts } from "../artifacts.js";
import { RuleContextUnavailableError, UnsupportedPolicyVersionError } from "../policy-rules.js";
import type { AssistConfig, AssistRuntime } from "../types.js";
import { PolicyExceptionAgentError, runPolicyExceptionAgent } from "./agent.js";
import { PolicySourceError } from "./types.js";
import { validatePolicyMemoDraft } from "./validate.js";
import { buildPolicyExceptionView, loadPolicyExceptionEvidence } from "./view.js";

export interface PolicyExceptionRouteDeps {
	db: Db;
	runtime: AssistRuntime;
	logger: Logger;
}

function caseIdParam(value: string): string {
	if (!isUuid(value)) throw new HttpError(404, "NOT_FOUND", "not found");
	return value;
}

function actorOf(user: { id: string; email: string; role: string }): AssistActor {
	return { id: user.id, email: user.email, role: user.role as AssistActor["role"] };
}

function invalidBody(error: z.ZodError): HttpError {
	return new HttpError(400, "VALIDATION_ERROR", "invalid request", zodFields(error));
}

/** Feature config gate: URL, secrets, client, and runner must all exist.
// View stays available without them (sourceStatus unavailable). */
function requirePolicyAgent(
	runtime: AssistRuntime,
): NonNullable<AssistRuntime["policyExceptionAgentRunner"]> {
	const config = runtime.config;
	if (
		!config.policyUrl ||
		!config.policyInternalSecret ||
		!config.policyAuditHashSecret ||
		!runtime.policyClient ||
		!runtime.policyExceptionAgentRunner
	) {
		throw new HttpError(
			503,
			"POLICY_EXCEPTION_UNAVAILABLE",
			"policy exception agent is not configured",
		);
	}
	return runtime.policyExceptionAgentRunner;
}

function agentConfigFor(config: AssistConfig): {
	model: string;
	agentVersion: string;
	promptVersion: string;
	validatorVersion: string;
	registryVersion: string;
	registryHash: string;
	artifactType: string;
	maxSteps: number;
	maxToolCalls: number;
	timeoutMs: number;
	maxCostUsd: number;
} {
	return {
		model: config.policyExceptionModel,
		agentVersion: config.policyExceptionAgentVersion,
		promptVersion: config.policyExceptionPromptVersion,
		validatorVersion: config.policyExceptionValidatorVersion,
		registryVersion: POLICY_REGISTRY_VERSION,
		registryHash: POLICY_REGISTRY_HASH,
		artifactType: "policy_exception_memo",
		maxSteps: config.policyExceptionMaxSteps,
		maxToolCalls: config.policyExceptionMaxToolCalls,
		timeoutMs: config.policyExceptionTimeoutMs,
		maxCostUsd: config.policyExceptionMaxCostUsd,
	};
}

function traceSummary(
	trace: import("../memo-trace.js").MemoAgentTrace,
	config: AssistConfig,
): import("./types.js").PolicyExceptionTraceSummary {
	return {
		agentVersion: trace.agentVersion,
		model: trace.model,
		promptVersion: trace.promptVersion,
		validatorVersion: trace.validatorVersion ?? config.policyExceptionValidatorVersion,
		registryVersion: trace.registryVersion ?? POLICY_REGISTRY_VERSION,
		registryHash: trace.registryHash ?? POLICY_REGISTRY_HASH,
		steps: trace.steps,
		toolCalls: trace.toolCalls,
		sourceRefs: trace.sourceRefs,
		repairAttempted: trace.repairAttempted,
		repairSucceeded: trace.repairSucceeded,
		inputTokens: trace.inputTokens,
		outputTokens: trace.outputTokens,
		latencyMs: trace.latencyMs,
		costUsd: trace.costUsd ?? 0,
	};
}

function hydrateCitations<T extends { citations: Array<{ policyKey: string; sectionId: string }> }>(
	content: T,
	catalog: import("./types.js").PolicySectionDelivery[],
): T {
	const byKey = new Map(
		catalog.map((section) => [`${section.policyKey}#${section.sectionId}`, section]),
	);
	return {
		...content,
		citations: content.citations.map((citation) => {
			const section = byKey.get(`${citation.policyKey}#${citation.sectionId}`);
			return section
				? {
						...citation,
						version: section.version,
						policyVersionId: section.policyVersionId,
						heading: section.heading,
						effectiveFrom: section.effectiveFrom,
						effectiveTo: section.effectiveTo,
						drawerToken: section.drawerToken,
					}
				: citation;
		}),
	};
}

function mapAgentError(err: unknown, applicationId: string, logger: Logger): never {
	if (err instanceof PolicyExceptionAgentError) {
		logger.warn({ applicationId, code: err.code }, "policy exception agent failed");
		if (err.code === "TIMEOUT")
			throw new HttpError(504, "POLICY_EXCEPTION_TIMEOUT", "policy exception agent timed out");
		if (err.code === "MODEL_ERROR")
			throw new HttpError(
				502,
				"POLICY_EXCEPTION_UNAVAILABLE",
				"policy exception agent is unavailable",
			);
		if (
			err.code === "STEP_LIMIT" ||
			err.code === "TOOL_CALL_LIMIT" ||
			err.code === "BUDGET_EXCEEDED"
		) {
			throw new HttpError(
				422,
				"POLICY_EXCEPTION_BUDGET",
				"policy exception agent budget exceeded",
				{
					issues: err.issues.map((issue) => issue.code),
				},
			);
		}
		throw new HttpError(
			422,
			"POLICY_EXCEPTION_INVALID",
			"policy exception output failed validation",
			{
				issues: err.issues.map((issue) => issue.code),
			},
		);
	}
	if (err instanceof PolicySourceError) {
		logger.warn({ applicationId, code: err.code }, "policy source failed");
		if (err.code === "POLICY_SOURCE_BUDGET") {
			throw new HttpError(422, "POLICY_SOURCE_UNAVAILABLE", "policy source budget exceeded");
		}
		if (err.code === "POLICY_SOURCE_INVALID") {
			throw new HttpError(
				502,
				"POLICY_SOURCE_UNAVAILABLE",
				"policy source returned an invalid response",
			);
		}
		throw new HttpError(
			err.status === 429 ? 429 : err.status !== null && err.status >= 500 ? 503 : 502,
			"POLICY_SOURCE_UNAVAILABLE",
			"policy source is unavailable",
		);
	}
	if (err instanceof RuleContextUnavailableError)
		throw new HttpError(409, "RULE_CONTEXT_UNAVAILABLE", err.message);
	if (err instanceof UnsupportedPolicyVersionError)
		throw new HttpError(409, "UNSUPPORTED_POLICY_VERSION", err.message);
	throw err;
}

const followupSchema = z.object({ question: z.string().min(3).max(1000) }).strict();

export function policyExceptionRoutes(deps: PolicyExceptionRouteDeps): ServiceApp {
	const app: ServiceApp = new Hono<{ Variables: ServiceVariables }>();
	const { db, runtime, logger } = deps;
	const config = runtime.config;

	// ponytail: single-instance in-memory gates; use a shared limiter if scaled.
	const rateHits = new Map<string, number[]>();
	const inFlight = new Set<string>();

	const checkRate = (actorId: string): void => {
		const windowStart = Date.now() - 60_000;
		if (rateHits.size > 1_000) {
			for (const [id, hits] of rateHits) {
				if (!hits.some((t) => t > windowStart)) rateHits.delete(id);
			}
		}
		const prior = (rateHits.get(actorId) ?? []).filter((t) => t > windowStart);
		if (prior.length >= config.policyExceptionRatePerMin) {
			throw new HttpError(429, "RATE_LIMITED", "too many policy exception requests");
		}
		prior.push(Date.now());
		rateHits.set(actorId, prior);
	};

	const policyGate = createMiddleware<{ Variables: ServiceVariables }>(async (_c, next) => {
		if (!config.enabled) throw new HttpError(404, "NOT_FOUND", "not found");
		if (!config.policyExceptionEnabled) throw new HttpError(404, "NOT_FOUND", "not found");
		await next();
	});

	const auditViewed = async (
		applicationId: string,
		actor: AssistActor,
		sourceStatus: string,
		ruleCount: number,
	): Promise<void> => {
		await withTx(db, (tx) =>
			writeAudit(tx, {
				applicationId,
				actor: actor.id,
				action: "policy_exception.viewed",
				entity: "policy_evaluation",
				payload: {
					feature: "policy_exception",
					applicationId,
					actorRole: actor.role,
					sourceStatus,
					ruleCount,
					registryVersion: POLICY_REGISTRY_VERSION,
				},
			}),
		);
	};

	const auditExplained = async (
		applicationId: string,
		actor: AssistActor,
		status: string,
		ruleIds: string[],
	): Promise<void> => {
		await withTx(db, (tx) =>
			writeAudit(tx, {
				applicationId,
				actor: actor.id,
				action: "policy_exception.explained",
				entity: "policy_evaluation",
				payload: {
					feature: "policy_exception",
					applicationId,
					actorRole: actor.role,
					model: config.policyExceptionModel,
					promptVersion: config.policyExceptionPromptVersion,
					agentVersion: config.policyExceptionAgentVersion,
					validatorVersion: config.policyExceptionValidatorVersion,
					registryVersion: POLICY_REGISTRY_VERSION,
					status,
					ruleIds: ruleIds.slice(0, 25),
				},
			}),
		);
	};

	const auditFollowup = async (
		applicationId: string,
		actor: AssistActor,
		status: string,
		questionHmac: string,
	): Promise<void> => {
		await withTx(db, (tx) =>
			writeAudit(tx, {
				applicationId,
				actor: actor.id,
				action: "policy_exception.followup",
				entity: "policy_evaluation",
				payload: {
					feature: "policy_exception",
					applicationId,
					actorRole: actor.role,
					model: config.policyExceptionModel,
					promptVersion: config.policyExceptionPromptVersion,
					agentVersion: config.policyExceptionAgentVersion,
					validatorVersion: config.policyExceptionValidatorVersion,
					registryVersion: POLICY_REGISTRY_VERSION,
					status,
					questionHmac,
				},
			}),
		);
	};

	const auditGenerateBlocked = async (input: {
		applicationId: string;
		actor: AssistActor;
		failureCode: string;
		issueCodes: string[];
	}): Promise<void> => {
		await withTx(db, (tx) =>
			writeAudit(tx, {
				applicationId: input.applicationId,
				actor: input.actor.id,
				action: "policy_exception.generate_blocked",
				entity: "generated_artifact",
				payload: {
					feature: "policy_exception",
					applicationId: input.applicationId,
					actorRole: input.actor.role,
					failureCode: input.failureCode,
					issueCodes: input.issueCodes.slice(0, 50),
					model: config.policyExceptionModel,
					promptVersion: config.policyExceptionPromptVersion,
				},
			}),
		);
	};

	app.get("/api/assist/cases/:id/policy-exception", requireOfficer, policyGate, async (c) => {
		const applicationId = caseIdParam(c.req.param("id"));
		const actor = actorOf(c.var.user);
		const kase = await requireAssistCaseAccess(db, applicationId, actor);
		try {
			const view = await buildPolicyExceptionView({ db, kase, actor, runtime });
			await auditViewed(applicationId, actor, view.sourceStatus, view.context.failedRules.length);
			return c.json(view);
		} catch (err) {
			if (err instanceof RuleContextUnavailableError)
				throw new HttpError(409, "RULE_CONTEXT_UNAVAILABLE", err.message);
			if (err instanceof UnsupportedPolicyVersionError)
				throw new HttpError(409, "UNSUPPORTED_POLICY_VERSION", err.message);
			throw err;
		}
	});

	app.post(
		"/api/assist/cases/:id/policy-exception/explain",
		requireOfficer,
		policyGate,
		async (c) => {
			const applicationId = caseIdParam(c.req.param("id"));
			const actor = actorOf(c.var.user);
			const kase = await requireAssistCaseAccess(db, applicationId, actor);
			checkRate(actor.id);
			if (inFlight.has(applicationId))
				throw new HttpError(
					429,
					"RATE_LIMITED",
					"a policy request is already running for this case",
				);
			inFlight.add(applicationId);
			try {
				const runner = requirePolicyAgent(runtime);
				const policyClient = runtime.policyClient;
				if (!policyClient)
					throw new HttpError(
						503,
						"POLICY_EXCEPTION_UNAVAILABLE",
						"policy exception agent is not configured",
					);
				let loaded: Awaited<ReturnType<typeof loadPolicyExceptionEvidence>>;
				try {
					loaded = await loadPolicyExceptionEvidence({ db, kase, actor, runtime });
				} catch (err) {
					mapAgentError(err, applicationId, logger);
				}
				const mapped = loaded.context.failedRules.filter((rule) => rule.mappingState === "mapped");
				if (loaded.context.failedRules.length === 0 || mapped.length === 0) {
					if (loaded.context.failedRules.length === 0) {
						const limitations = [...loaded.context.limitations];
						await auditExplained(applicationId, actor, "no_match", []);
						return c.json({
							status: "no_match",
							rules: [],
							limitations,
							trace: null,
							registryVersion: POLICY_REGISTRY_VERSION,
						});
					}
					throw new HttpError(422, "MAPPING_UNAVAILABLE", "no mapped rules for this case", {
						ruleIds: loaded.context.failedRules.map((rule) => rule.ruleId),
					});
				}
				if (loaded.sourceStatus === "unavailable") {
					throw new HttpError(503, "POLICY_SOURCE_UNAVAILABLE", "policy source is unavailable");
				}
				try {
					const { content, trace } = await runPolicyExceptionAgent({
						mode: "explain",
						context: loaded.context,
						evidence: loaded.bundle,
						catalog: loaded.catalog,
						policyClient,
						config: agentConfigFor(config),
						runner,
						actorId: actor.id,
						actorRole: actor.role,
						signal: AbortSignal.timeout(config.policyExceptionTimeoutMs),
					});
					await auditExplained(
						applicationId,
						actor,
						(content as { status: string }).status,
						loaded.context.failedRules.map((rule) => rule.ruleId),
					);
					const explained = content as import("./types.js").PolicyExplanation;
					return c.json({
						...explained,
						rules: explained.rules.map((rule) => hydrateCitations(rule, loaded.catalog)),
						trace: traceSummary(trace, config),
						registryVersion: POLICY_REGISTRY_VERSION,
					});
				} catch (err) {
					mapAgentError(err, applicationId, logger);
				}
			} finally {
				inFlight.delete(applicationId);
			}
			throw new HttpError(500, "POLICY_EXCEPTION_UNAVAILABLE", "policy exception failed");
		},
	);

	app.post(
		"/api/assist/cases/:id/policy-exception/followups",
		requireOfficer,
		policyGate,
		async (c) => {
			const applicationId = caseIdParam(c.req.param("id"));
			const parsed = followupSchema.safeParse(await readJson(c));
			if (!parsed.success) throw invalidBody(parsed.error);
			const actor = actorOf(c.var.user);
			const kase = await requireAssistCaseAccess(db, applicationId, actor);
			const question = parsed.data.question;
			const secret = config.policyAuditHashSecret;
			if (!secret)
				throw new HttpError(
					503,
					"POLICY_EXCEPTION_UNAVAILABLE",
					"policy exception agent is not configured",
				);
			const questionHmac = hmacQuestion(secret, question);
			checkRate(actor.id);
			if (inFlight.has(applicationId))
				throw new HttpError(
					429,
					"RATE_LIMITED",
					"a policy request is already running for this case",
				);
			inFlight.add(applicationId);
			try {
				if (classifyPolicyScope(question) === "out_of_scope") {
					await auditFollowup(applicationId, actor, "no_match", questionHmac);
					return c.json({
						status: "no_match",
						segments: [],
						citations: [],
						limitations: [],
						trace: null,
						registryVersion: POLICY_REGISTRY_VERSION,
					});
				}
				if (hasDirectIdentifier(question)) {
					await auditFollowup(applicationId, actor, "needs_policy_owner", questionHmac).catch(
						() => {},
					);
					return c.json({
						status: "needs_policy_owner",
						segments: [],
						citations: [],
						limitations: [],
						trace: null,
						registryVersion: POLICY_REGISTRY_VERSION,
					});
				}
				const mentionedApps = question.match(/\bAPP-\d{4}-[A-Z2-7]{6}\b/gi) ?? [];
				if (
					mentionedApps.some(
						(ref) =>
							kase.application.reference === null ||
							ref.toUpperCase() !== kase.application.reference.toUpperCase(),
					)
				) {
					await auditFollowup(applicationId, actor, "needs_policy_owner", questionHmac).catch(
						() => {},
					);
					return c.json({
						status: "needs_policy_owner",
						segments: [],
						citations: [],
						limitations: ["This answer is limited to the current case."],
						trace: null,
						registryVersion: POLICY_REGISTRY_VERSION,
					});
				}
				const runner = requirePolicyAgent(runtime);
				const policyClient = runtime.policyClient;
				if (!policyClient)
					throw new HttpError(
						503,
						"POLICY_EXCEPTION_UNAVAILABLE",
						"policy exception agent is not configured",
					);
				let loaded: Awaited<ReturnType<typeof loadPolicyExceptionEvidence>>;
				try {
					loaded = await loadPolicyExceptionEvidence({ db, kase, actor, runtime });
				} catch (err) {
					mapAgentError(err, applicationId, logger);
				}
				if (loaded.sourceStatus === "unavailable" && loaded.context.failedRules.length > 0) {
					throw new HttpError(503, "POLICY_SOURCE_UNAVAILABLE", "policy source is unavailable");
				}
				try {
					const { content, trace } = await runPolicyExceptionAgent({
						mode: "followup",
						context: loaded.context,
						evidence: loaded.bundle,
						catalog: loaded.catalog,
						policyClient,
						config: agentConfigFor(config),
						runner,
						actorId: actor.id,
						actorRole: actor.role,
						question,
						signal: AbortSignal.timeout(config.policyExceptionTimeoutMs),
					});
					await auditFollowup(
						applicationId,
						actor,
						(content as { status: string }).status,
						questionHmac,
					);
					const answer = content as import("./types.js").PolicyFollowUp;
					return c.json({
						...answer,
						...hydrateCitations(answer, loaded.catalog),
						trace: traceSummary(trace, config),
						registryVersion: POLICY_REGISTRY_VERSION,
					});
				} catch (err) {
					mapAgentError(err, applicationId, logger);
				}
			} finally {
				inFlight.delete(applicationId);
			}
			throw new HttpError(500, "POLICY_EXCEPTION_UNAVAILABLE", "policy exception failed");
		},
	);

	app.post("/api/assist/cases/:id/policy-exception/memo", requireOfficer, policyGate, async (c) => {
		const applicationId = caseIdParam(c.req.param("id"));
		const actor = actorOf(c.var.user);
		const kase = await requireAssistCaseAccess(db, applicationId, actor);
		requireMemoableCase(kase);
		checkRate(actor.id);
		if (inFlight.has(applicationId)) {
			await auditGenerateBlocked({
				applicationId,
				actor,
				failureCode: "RATE_LIMITED",
				issueCodes: [],
			}).catch(() => {});
			throw new HttpError(429, "RATE_LIMITED", "a policy request is already running for this case");
		}
		inFlight.add(applicationId);
		try {
			const runner = requirePolicyAgent(runtime);
			const policyClient = runtime.policyClient;
			if (!policyClient) {
				await auditGenerateBlocked({
					applicationId,
					actor,
					failureCode: "POLICY_EXCEPTION_UNAVAILABLE",
					issueCodes: [],
				}).catch(() => {});
				throw new HttpError(
					503,
					"POLICY_EXCEPTION_UNAVAILABLE",
					"policy exception agent is not configured",
				);
			}
			let loaded: Awaited<ReturnType<typeof loadPolicyExceptionEvidence>>;
			try {
				loaded = await loadPolicyExceptionEvidence({ db, kase, actor, runtime });
			} catch (err) {
				if (err instanceof HttpError) {
					await auditGenerateBlocked({
						applicationId,
						actor,
						failureCode: err.code,
						issueCodes: [],
					}).catch(() => {});
				}
				mapAgentError(err, applicationId, logger);
			}
			const mapped = loaded.context.failedRules.filter((rule) => rule.mappingState === "mapped");
			if (loaded.context.failedRules.length > 0 && mapped.length === 0) {
				const ruleIds = loaded.context.failedRules.map((rule) => rule.ruleId);
				await auditGenerateBlocked({
					applicationId,
					actor,
					failureCode: "MAPPING_UNAVAILABLE",
					issueCodes: ruleIds,
				}).catch(() => {});
				throw new HttpError(422, "MAPPING_UNAVAILABLE", "no mapped rules for this case", {
					ruleIds,
				});
			}
			if (loaded.context.failedRules.length === 0) {
				await auditGenerateBlocked({
					applicationId,
					actor,
					failureCode: "MAPPING_UNAVAILABLE",
					issueCodes: [],
				}).catch(() => {});
				throw new HttpError(422, "MAPPING_UNAVAILABLE", "no failed rules for this case", {
					ruleIds: [],
				});
			}
			if (loaded.sourceStatus === "unavailable") {
				await auditGenerateBlocked({
					applicationId,
					actor,
					failureCode: "POLICY_SOURCE_UNAVAILABLE",
					issueCodes: [],
				}).catch(() => {});
				throw new HttpError(503, "POLICY_SOURCE_UNAVAILABLE", "policy source is unavailable");
			}
			// Idempotent replay: same evidence + versions replays the draft.
			// Approved/superseded rows never replay as drafts.
			const candidates = await listArtifacts(db, applicationId, "policy_exception_memo");
			const replayed = candidates.find(
				(artifact) =>
					artifact.status === "draft" &&
					artifact.evidenceHash === loaded.replayKey &&
					artifact.model === config.policyExceptionModel &&
					artifact.promptVersion === config.policyExceptionPromptVersion &&
					artifact.agentTrace?.agentVersion === config.policyExceptionAgentVersion &&
					artifact.agentTrace?.registryVersion === POLICY_REGISTRY_VERSION &&
					artifact.agentTrace?.validatorVersion === config.policyExceptionValidatorVersion,
			);
			if (replayed) return c.json({ artifact: replayed, replayed: true }, 200);
			// Guard the unique-draft race: an existing draft with different
			// evidence supersedes on create, but a replay hit above wins.
			let result: Awaited<ReturnType<typeof runPolicyExceptionAgent>>;
			try {
				result = await runPolicyExceptionAgent({
					mode: "memo",
					context: loaded.context,
					evidence: loaded.bundle,
					catalog: loaded.catalog,
					policyClient,
					config: { ...agentConfigFor(config), replayKey: loaded.replayKey },
					runner,
					actorId: actor.id,
					actorRole: actor.role,
					signal: AbortSignal.timeout(config.policyExceptionTimeoutMs),
				});
			} catch (err) {
				if (err instanceof PolicyExceptionAgentError) {
					await auditGenerateBlocked({
						applicationId,
						actor,
						failureCode: err.code,
						issueCodes: err.issues.map((issue) => issue.code),
					}).catch(() => {});
				}
				mapAgentError(err, applicationId, logger);
			}
			const content = result.content as unknown as {
				title: string;
				sections: unknown[];
				openItems: unknown[];
				rules: unknown[];
				regularisationPlanMonths: number | null;
			};
			const validation = validateGeneratedText({
				artifactType: "policy_exception_memo",
				content,
				evidence: loaded.bundle,
			});
			if (!validation.ok) {
				await auditGenerateBlocked({
					applicationId,
					actor,
					failureCode: "GENERATED_TEXT_INVALID",
					issueCodes: validation.issues.map((issue) => issue.code),
				}).catch(() => {});
				return c.json(
					{
						error: {
							code: "GENERATED_TEXT_INVALID",
							message: "generated text failed validation",
							issues: validation.issues.slice(0, 100),
						},
					},
					422,
				);
			}
			const documentDerived = loaded.bundle.items.some((item) => item.sourceType === "document");
			const policyValidation = validatePolicyMemoDraft(
				validation.content,
				loaded.context,
				loaded.catalog,
				loaded.bundle,
			);
			if (!policyValidation.ok) {
				await auditGenerateBlocked({
					applicationId,
					actor,
					failureCode: "POLICY_EXCEPTION_INVALID",
					issueCodes: policyValidation.issues.map((issue) => issue.code),
				}).catch(() => {});
				return c.json(
					{
						error: {
							code: "POLICY_EXCEPTION_INVALID",
							message: "policy memo failed policy validation",
							issues: policyValidation.issues.slice(0, 100),
						},
					},
					422,
				);
			}
			const artifact = await createArtifact(db, {
				applicationId,
				type: "policy_exception_memo",
				content: validation.content,
				citations: validation.citations,
				documentDerived,
				createdBy: actor.id,
				actorRole: actor.role,
				model: config.policyExceptionModel,
				promptVersion: config.policyExceptionPromptVersion,
				retentionDays: config.policyExceptionRetentionDays,
				supersedeDraft: true,
				agentTrace: result.trace,
				evidenceHash: loaded.replayKey,
				auditFeature: "policy_exception",
				auditMetadata: {
					writer: result.trace.writer,
					agentVersion: result.trace.agentVersion,
					toolCallCount: result.trace.toolCalls.length,
					sourceRefCount: result.trace.sourceRefs.length,
					repairAttempted: result.trace.repairAttempted,
					registryVersion: result.trace.registryVersion ?? null,
					validatorVersion: result.trace.validatorVersion ?? null,
				},
				now: runtime.now(),
			});
			logger.info(
				{ applicationId, artifactId: artifact.id, version: artifact.version },
				"policy exception memo drafted",
			);
			return c.json({ artifact }, 201);
		} finally {
			inFlight.delete(applicationId);
		}
	});

	return app;
}
