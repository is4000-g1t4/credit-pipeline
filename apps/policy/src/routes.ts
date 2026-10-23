import { randomUUID } from "node:crypto";
import { HttpError, readJson, requireService, type ServiceVariables } from "@credit/service-kit";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import {
	validateCaseAnswer,
	validateNavigatorAnswer,
	verifyDrawerToken,
	type AnswerCitation,
} from "./answer.js";
import { policyCaseContextSchema } from "./case-context.js";
import { verifyCaseToken } from "./case-token.js";
import { classifyScope, hasDirectIdentifier, hmacQuestion } from "./gates.js";
import { caseRetrievalText, policyFamiliesForSignal } from "./mapping.js";
import { canRead, filterByAcl, rankChunks, type Actor } from "./retrieval.js";
import type { PolicyDeps, PolicyStore } from "./store.js";

const askSchema = z
	.object({
		question: z.string().min(3).max(1_000),
		product: z.enum(["personal_loan", "sme_term_loan"]),
		jurisdiction: z
			.string()
			.regex(/^[A-Z]{2}$/)
			.optional(),
	})
	.strict();

const caseBodySchema = z
	.object({
		caseContext: policyCaseContextSchema,
		caseToken: z.string().min(10),
	})
	.strict();

const approveSchema = z
	.object({
		effectiveFrom: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/)
			.optional(),
	})
	.strict();

const requireOfficer = createMiddleware<{ Variables: ServiceVariables }>(async (c, next) => {
	const me = c.var.user;
	if (!me) throw new HttpError(401, "UNAUTHENTICATED", "login required");
	if (me.role !== "officer") throw new HttpError(403, "FORBIDDEN", "officer only");
	await next();
});

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

function productScope(product: "personal_loan" | "sme_term_loan"): "individual" | "sme" {
	return product === "sme_term_loan" ? "sme" : "individual";
}

async function loadActor(
	store: PolicyStore,
	user: { id: string; role: "applicant" | "officer" | "service" },
): Promise<Actor> {
	if (user.role === "service") return { id: user.id, role: "service", policyRoles: [] };
	return { id: user.id, role: user.role, policyRoles: await store.loadPolicyRoles(user.id) };
}

async function canAdminPolicy(
	store: PolicyStore,
	actor: Actor,
	policyId: string,
): Promise<boolean> {
	if (actor.role !== "officer") return false;
	if (actor.policyRoles.includes("compliance")) return true;
	if (!actor.policyRoles.includes("policy_owner")) return false;
	const acls = await store.loadAcls([policyId]);
	return acls.some(
		(row) =>
			row.policyId === policyId &&
			row.principalType === "user" &&
			row.principal === actor.id &&
			row.permission === "admin",
	);
}

type QueryBase = {
	id: string;
	actorId: string;
	actorRole: string;
	mode: "navigator" | "case_explain";
	budgetClass: "navigator" | "case";
	applicationId: string | null;
	runId: string | null;
	questionHmac: string | null;
	asOf: string;
};

async function logQuery(
	store: PolicyStore,
	base: QueryBase,
	status: string,
	errorCode: string | null,
	retrievedSectionIds: string[] = [],
	usageCost = 0,
): Promise<void> {
	await store.insertQuery({
		...base,
		domain: "credit",
		status,
		errorCode,
		retrievedSectionIds,
		usageCost,
	});
}

function citationRows(
	itemRef: string | null,
	segments: Array<{ citationIndexes: number[] }>,
	citations: AnswerCitation[],
): Array<{ itemRef: string | null; segmentIndex: number; citation: AnswerCitation }> {
	const rows: Array<{ itemRef: string | null; segmentIndex: number; citation: AnswerCitation }> =
		[];
	for (const [segmentIndex, segment] of segments.entries()) {
		for (const citationIndex of segment.citationIndexes) {
			const citation = citations[citationIndex];
			if (citation) rows.push({ itemRef, segmentIndex, citation });
		}
	}
	return rows;
}

export function createPolicyRoutes(deps: PolicyDeps): Hono<{ Variables: ServiceVariables }> {
	const app = new Hono<{ Variables: ServiceVariables }>();
	const { store, env, logger } = deps;

	app.post("/api/policy/ask", requireOfficer, async (c) => {
		if (!env.assistEnabled)
			throw new HttpError(503, "POLICY_DISABLED", "policy assist is disabled");
		const parsed = askSchema.safeParse(await readJson(c));
		if (!parsed.success) throw new HttpError(422, "VALIDATION_ERROR", "invalid request");
		const me = c.var.user;
		const question = parsed.data.question.trim();
		const asOf = today();
		const queryId = randomUUID();
		const base: QueryBase = {
			id: queryId,
			actorId: me.id,
			actorRole: me.role,
			mode: "navigator",
			budgetClass: "navigator",
			applicationId: null,
			runId: null,
			questionHmac: hmacQuestion(env.auditHashSecret, question),
			asOf,
		};
		if (classifyScope(question) === "out_of_scope") {
			await logQuery(store, { ...base, questionHmac: null }, "out_of_scope", "out_of_scope");
			return c.json({ status: "out_of_scope", segments: [], citations: [], limitations: [] });
		}
		if (hasDirectIdentifier(question)) {
			await logQuery(
				store,
				{ ...base, questionHmac: null },
				"identifier_blocked",
				"identifier_blocked",
			);
			return c.json({ status: "identifier_blocked", segments: [], citations: [], limitations: [] });
		}
		const reserved = await store.reserveBudget({
			day: asOf,
			budgetClass: "navigator",
			actorId: me.id,
			maxCostUsd: env.agentMaxCostUsd,
			dailyCapUsd: env.navDailyBudgetUsd,
			actorCapUsd: env.actorDailyBudgetUsd,
			ttlSeconds: env.reservationTtlSeconds,
		});
		if ("error" in reserved) {
			await logQuery(store, base, "budget_exceeded", "budget_exceeded");
			return c.json({ status: "budget_exceeded", segments: [], citations: [], limitations: [] });
		}
		const settle = async (costUsd: number): Promise<void> => {
			try {
				await store.settleBudget(reserved.reservationId, costUsd);
			} catch (err) {
				logger.warn({ err, queryId }, "policy budget settle failed");
			}
		};
		try {
			const active = await store.getActiveIndex();
			if (!active) throw new Error("policy index is unavailable");
			if (
				active.embeddingModel !== env.embeddingModel ||
				active.embeddingDimensions !== env.embeddingDimensions
			) {
				throw new Error("policy embedding index configuration mismatch");
			}
			const [vector] = await deps.embedder.embed([question]);
			if (!vector) throw new Error("policy query embedding is empty");
			const chunks = await store.loadChunks({
				asOf,
				productScope: productScope(parsed.data.product),
				jurisdiction: parsed.data.jurisdiction ?? env.jurisdiction,
				statuses: ["approved"],
				indexVersion: active.indexVersion,
			});
			const actor = await loadActor(store, me);
			const acls = await store.loadAcls([...new Set(chunks.map((chunk) => chunk.policyId))]);
			const ranked = rankChunks(
				question,
				vector,
				filterByAcl(chunks, actor, acls),
				env.retrievalTopK,
			);
			const retrievedIds = ranked.map((chunk) => chunk.sectionId);
			if (ranked.length === 0) {
				await logQuery(store, base, "no_match", null, []);
				await settle(0.0005);
				return c.json({ status: "no_match", segments: [], citations: [], limitations: [] });
			}
			const result = await deps.answerer.answerNavigator({
				question,
				sections: ranked,
				signal: AbortSignal.timeout(env.agentTimeoutMs),
			});
			const validation = validateNavigatorAnswer(result.output, ranked, {
				secret: env.citationSecret,
				asOf,
				queryId,
			});
			if (!validation.ok) {
				logger.warn({ queryId, errors: validation.errors }, "policy citation validation failed");
			} else if (validation.answer.status !== "succeeded") {
				logger.warn(
					{ queryId, status: validation.answer.status },
					"policy answerer returned non-success",
				);
			}
			if (!validation.ok || validation.answer.status !== "succeeded") {
				const status = validation.ok ? validation.answer.status : "needs_policy_owner";
				await logQuery(
					store,
					base,
					status,
					validation.ok ? null : "citation_invalid",
					retrievedIds,
					result.usage.costUsd,
				);
				await settle(result.usage.costUsd);
				return c.json({
					status,
					segments: [],
					citations: [],
					limitations: validation.answer.limitations,
					usage: result.usage,
				});
			}
			await logQuery(store, base, "succeeded", null, retrievedIds, result.usage.costUsd);
			await settle(result.usage.costUsd);
			await store.insertCitations(
				queryId,
				citationRows(null, validation.answer.segments, validation.answer.citations),
			);
			return c.json({ ...validation.answer, usage: result.usage });
		} catch (err) {
			logger.error(
				{ queryId, err: err instanceof Error ? err.message : String(err) },
				"policy navigator failed",
			);
			await logQuery(store, base, "failed", "policy_error");
			await settle(0.0005);
			return c.json({ status: "failed", segments: [], citations: [], limitations: [] });
		}
	});

	app.post("/internal/policy/explain-case", requireService, async (c) => {
		if (!env.assistEnabled)
			throw new HttpError(503, "POLICY_DISABLED", "policy assist is disabled");
		const parsed = caseBodySchema.safeParse(await readJson(c));
		if (!parsed.success) throw new HttpError(422, "VALIDATION_ERROR", "invalid case context");
		const { caseContext, caseToken } = parsed.data;
		const claims = verifyCaseToken(env.caseTokenSecret, caseToken, {
			runId: caseContext.runId,
			applicationId: caseContext.applicationId,
			authorisingActorId: caseContext.authorisingActorId,
			authorisingActorRole: caseContext.authorisingActorRole,
			asOf: caseContext.asOf,
		});
		if (!claims) throw new HttpError(401, "INVALID_CASE_TOKEN", "invalid case token");
		const consumed = await store.consumeCaseToken(
			claims.jti,
			caseContext.runId,
			caseContext.applicationId,
		);
		if (!consumed) throw new HttpError(409, "CASE_TOKEN_REPLAY", "case token already used");
		const queryId = randomUUID();
		const base: QueryBase = {
			id: queryId,
			actorId: caseContext.authorisingActorId,
			actorRole: caseContext.authorisingActorRole,
			mode: "case_explain",
			budgetClass: "case",
			applicationId: caseContext.applicationId,
			runId: caseContext.runId,
			questionHmac: null,
			asOf: caseContext.asOf,
		};
		const reserved = await store.reserveBudget({
			day: today(),
			budgetClass: "case",
			actorId: "00000000-0000-0000-0000-000000000000",
			maxCostUsd: env.caseMaxCostUsd,
			dailyCapUsd: env.caseDailyBudgetUsd,
			actorCapUsd: 0,
			ttlSeconds: env.reservationTtlSeconds,
		});
		if ("error" in reserved) {
			await logQuery(store, base, "budget_exceeded", "budget_exceeded");
			return c.json({ status: "budget_exceeded", items: [], limitations: [] });
		}
		const settle = async (costUsd: number): Promise<void> => {
			try {
				await store.settleBudget(reserved.reservationId, costUsd);
			} catch (err) {
				logger.warn({ err, queryId }, "policy case budget settle failed");
			}
		};
		try {
			const active = await store.getActiveIndex();
			if (!active) throw new Error("policy index is unavailable");
			if (
				active.embeddingModel !== env.embeddingModel ||
				active.embeddingDimensions !== env.embeddingDimensions
			) {
				throw new Error("policy embedding index configuration mismatch");
			}
			const retrievalText = caseRetrievalText(caseContext);
			const [vector] = await deps.embedder.embed([retrievalText]);
			if (!vector) throw new Error("case query embedding is empty");
			const chunks = await store.loadChunks({
				asOf: caseContext.asOf,
				productScope: caseContext.type === "sme" ? "sme" : "individual",
				jurisdiction: env.jurisdiction,
				statuses: ["approved", "retired"],
				indexVersion: active.indexVersion,
			});
			const actor: Actor = { id: "service:case_explain", role: "service", policyRoles: [] };
			const acls = await store.loadAcls([...new Set(chunks.map((chunk) => chunk.policyId))]);
			const allowed = filterByAcl(chunks, actor, acls);
			const families = new Set([
				...caseContext.signals.flatMap((signal) => policyFamiliesForSignal(signal)),
				"documentation",
			]);
			const scoped = allowed.filter((chunk) => families.has(chunk.policyFamily));
			const ranked = rankChunks(
				retrievalText,
				vector,
				scoped.length > 0 ? scoped : allowed,
				env.retrievalTopK,
			);
			const retrievedIds = ranked.map((chunk) => chunk.sectionId);
			if (ranked.length === 0) {
				await logQuery(store, base, "no_match", null, []);
				await settle(0.0005);
				return c.json({ status: "no_match", items: [], limitations: [] });
			}
			const result = await deps.answerer.answerCase({
				context: caseContext,
				sections: ranked,
				signal: AbortSignal.timeout(env.caseTimeoutMs),
			});
			const validation = validateCaseAnswer(result.output, caseContext, ranked, {
				secret: env.citationSecret,
				asOf: caseContext.asOf,
				queryId,
			});
			if (!validation.ok) {
				logger.warn(
					{ queryId, errors: validation.errors },
					"policy case citation validation failed",
				);
			} else if (validation.answer.status !== "succeeded") {
				logger.warn(
					{ queryId, status: validation.answer.status },
					"policy case answerer returned non-success",
				);
			}
			if (!validation.ok || validation.answer.status !== "succeeded") {
				const status = validation.ok ? validation.answer.status : "needs_policy_owner";
				await logQuery(
					store,
					base,
					status,
					validation.ok ? null : "citation_invalid",
					retrievedIds,
					result.usage.costUsd,
				);
				await settle(result.usage.costUsd);
				return c.json({
					status,
					items: [],
					limitations: validation.answer.limitations,
					usage: result.usage,
				});
			}
			await logQuery(store, base, "succeeded", null, retrievedIds, result.usage.costUsd);
			await settle(result.usage.costUsd);
			for (const item of validation.answer.items) {
				await store.insertCitations(
					queryId,
					citationRows(item.ref, item.explanationSegments, item.citations),
				);
			}
			return c.json({ ...validation.answer, usage: result.usage });
		} catch (err) {
			logger.error(
				{ queryId, err: err instanceof Error ? err.message : String(err) },
				"policy case failed",
			);
			await logQuery(store, base, "failed", "policy_error");
			await settle(0.0005);
			return c.json({ status: "failed", items: [], limitations: [] });
		}
	});

	app.get("/api/policy/sections/:versionId/:sectionId", requireOfficer, async (c) => {
		const versionId = c.req.param("versionId");
		const sectionId = c.req.param("sectionId");
		const token = c.req.query("token");
		if (!token) throw new HttpError(404, "NOT_FOUND", "not found");
		const verified = verifyDrawerToken(env.citationSecret, token, { versionId, sectionId });
		if (!verified) throw new HttpError(404, "NOT_FOUND", "not found");
		const section = await store.getSection(versionId, sectionId);
		if (!section || section.status === "draft") throw new HttpError(404, "NOT_FOUND", "not found");
		if (
			section.effectiveFrom > verified.asOf ||
			(section.effectiveTo !== null && section.effectiveTo < verified.asOf)
		) {
			throw new HttpError(404, "NOT_FOUND", "not found");
		}
		const me = c.var.user;
		const actor = await loadActor(store, me);
		const acls = await store.loadAcls([section.policyId]);
		if (!canRead(section.policyId, actor, acls)) {
			throw new HttpError(404, "NOT_FOUND", "not found");
		}
		return c.json(section);
	});

	app.post("/api/policy/versions/:id/submit", requireOfficer, async (c) => {
		const version = await store.getVersion(c.req.param("id"));
		if (!version) throw new HttpError(404, "NOT_FOUND", "not found");
		if (version.status !== "draft")
			throw new HttpError(409, "NOT_DRAFT", "only drafts can be submitted");
		const me = c.var.user;
		const actor = await loadActor(store, me);
		if (!(await canAdminPolicy(store, actor, version.policyId))) {
			throw new HttpError(403, "FORBIDDEN", "policy admin required");
		}
		await store.submitVersion(version.id, me.id);
		return c.json({ status: "submitted" });
	});

	app.post("/api/policy/versions/:id/approve", requireOfficer, async (c) => {
		const parsed = approveSchema.safeParse(await readJson(c));
		if (!parsed.success) throw new HttpError(422, "VALIDATION_ERROR", "invalid request");
		const version = await store.getVersion(c.req.param("id"));
		if (!version) throw new HttpError(404, "NOT_FOUND", "not found");
		const me = c.var.user;
		const actor = await loadActor(store, me);
		if (!(await canAdminPolicy(store, actor, version.policyId))) {
			throw new HttpError(403, "FORBIDDEN", "policy admin required");
		}
		if (!version.submittedBy)
			throw new HttpError(409, "NOT_SUBMITTED", "draft must be submitted first");
		if (version.submittedBy === me.id)
			throw new HttpError(403, "SELF_APPROVAL", "submitter cannot approve");
		const effectiveFrom = parsed.data.effectiveFrom ?? version.effectiveFrom;
		if (effectiveFrom < today())
			throw new HttpError(422, "BACKDATED", "effective date cannot be in the past");
		await store.approveVersion(version.id, me.id, effectiveFrom);
		return c.json({ status: "approved", effectiveFrom });
	});

	app.post("/api/policy/versions/:id/retire", requireOfficer, async (c) => {
		const version = await store.getVersion(c.req.param("id"));
		if (!version) throw new HttpError(404, "NOT_FOUND", "not found");
		const me = c.var.user;
		const actor = await loadActor(store, me);
		if (!(await canAdminPolicy(store, actor, version.policyId))) {
			throw new HttpError(403, "FORBIDDEN", "policy admin required");
		}
		await store.retireVersion(version.id, me.id);
		return c.json({ status: "retired" });
	});

	return app;
}

export const policyRoutes = createPolicyRoutes;
