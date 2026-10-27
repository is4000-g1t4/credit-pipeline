import { randomUUID } from "node:crypto";
import { POLICY_ENGINE_STANDARD_SECTION_IDS } from "@credit/core";
import {
	HttpError,
	readJson,
	requireOfficer,
	requireService,
	type ServiceVariables,
} from "@credit/service-kit";
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
import {
	assertRegistryRefs,
	assertStandardHash,
	CorpusIntegrityError,
} from "./corpus-integrity.js";
import { SERVICE_CASE_EXPLAIN, capBridgeBodies, toBridgeDelivery, type BridgeRow } from "./bridge.js";
import { classifyScope, hasDirectIdentifier, hmacQuestion } from "./gates.js";
import { caseRetrievalText, DOCUMENT_FAMILY, policyFamiliesForSignal } from "./mapping.js";
import { canRead, filterByAcl, rankChunks, type Actor } from "./retrieval.js";
import type { PolicyChunk, PolicyDeps, PolicyStore } from "./store.js";

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

const uuidSchema = z.string().uuid();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const exceptionBaseSchema = z
	.object({
		applicationId: uuidSchema,
		actorId: uuidSchema,
		actorRole: z.string().min(1).max(40),
		policyAsOf: dateSchema,
		productScope: z.enum(["individual", "sme"]),
	})
	.strict();

const resolveSchema = exceptionBaseSchema
	.extend({
		refs: z
			.array(
				z
					.object({
						policyKey: z.string().min(1).max(40),
						sectionId: z.string().min(1).max(64),
						versionId: uuidSchema.optional(),
					})
					.strict(),
			)
			.min(1)
			.max(20),
	})
	.strict();

const bridgeSearchSchema = exceptionBaseSchema
	.extend({
		query: z.string().min(3).max(1000),
		topK: z.number().int().min(1).max(12).optional(),
	})
	.strict();

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
	budgetClass: "navigator" | "case" | "policy_exception";
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

async function requireActiveIndex(
	store: PolicyStore,
	env: PolicyDeps["env"],
): Promise<NonNullable<Awaited<ReturnType<PolicyStore["getActiveIndex"]>>>> {
	const active = await store.getActiveIndex();
	if (!active) throw new Error("policy index is unavailable");
	if (
		active.embeddingModel !== env.embeddingModel ||
		active.embeddingDimensions !== env.embeddingDimensions
	) {
		throw new Error("policy embedding index configuration mismatch");
	}
	return active;
}

function makeSettle(
	store: PolicyStore,
	reservationId: string,
	logger: PolicyDeps["logger"],
	queryId: string,
	message: string,
): (costUsd: number) => Promise<void> {
	return async (costUsd: number): Promise<void> => {
		try {
			await store.settleBudget(reservationId, costUsd);
		} catch (err) {
			logger.warn({ err, queryId }, message);
		}
	};
}

async function settleInvalidAnswer(
	store: PolicyStore,
	base: QueryBase,
	retrievedIds: string[],
	costUsd: number,
	validation: { ok: boolean; answer: { status: string; limitations: string[] } },
	settle: (costUsd: number) => Promise<void>,
): Promise<{ status: string; limitations: string[] }> {
	const status = validation.ok ? validation.answer.status : "needs_policy_owner";
	await logQuery(
		store,
		base,
		status,
		validation.ok ? null : "citation_invalid",
		retrievedIds,
		costUsd,
	);
	await settle(costUsd);
	return { status, limitations: validation.answer.limitations };
}

/** Shared retrieval pipeline: embed → load chunks → ACL → rank. The ACL
 * filter always runs before ranking; callers pass endpoint-specific filters,
 * scopes, and the actor. Returns ranked chunks; callers map section ids. */
async function retrieveSections(
	deps: PolicyDeps,
	input: {
		queryText: string;
		conversationId: string;
		asOf: string;
		productScope: "individual" | "sme";
		jurisdiction: string;
		statuses: Array<"approved" | "retired">;
		actor: Actor;
		topK: number;
		familyFilter?: (chunk: PolicyChunk) => boolean;
		emptyError?: string;
	},
): Promise<PolicyChunk[]> {
	const active = await requireActiveIndex(deps.store, deps.env);
	const [vector] = await deps.embedder.embed([input.queryText], {
		conversationId: input.conversationId,
	});
	if (!vector) throw new Error(input.emptyError ?? "policy query embedding is empty");
	const chunks = await deps.store.loadChunks({
		asOf: input.asOf,
		productScope: input.productScope,
		jurisdiction: input.jurisdiction,
		statuses: input.statuses,
		indexVersion: active.indexVersion,
	});
	const acls = await deps.store.loadAcls([...new Set(chunks.map((chunk) => chunk.policyId))]);
	const allowed = filterByAcl(chunks, input.actor, acls);
	const scoped = input.familyFilter ? allowed.filter(input.familyFilter) : allowed;
	return rankChunks(input.queryText, vector, scoped.length > 0 ? scoped : allowed, input.topK);
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
		const settle = makeSettle(
			store,
			reserved.reservationId,
			logger,
			queryId,
			"policy budget settle failed",
		);
		try {
			const actor = await loadActor(store, me);
			const ranked = await retrieveSections(deps, {
				queryText: question,
				conversationId: queryId,
				asOf,
				productScope: productScope(parsed.data.product),
				jurisdiction: parsed.data.jurisdiction ?? env.jurisdiction,
				statuses: ["approved"],
				actor,
				topK: env.retrievalTopK,
			});
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
				conversationId: queryId,
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
				const invalid = await settleInvalidAnswer(
					store,
					base,
					retrievedIds,
					result.usage.costUsd,
					validation,
					settle,
				);
				return c.json({
					status: invalid.status,
					segments: [],
					citations: [],
					limitations: invalid.limitations,
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
		const settle = makeSettle(
			store,
			reserved.reservationId,
			logger,
			queryId,
			"policy case budget settle failed",
		);
		try {
			const retrievalText = caseRetrievalText(caseContext);
			const families = new Set([
				...caseContext.signals.flatMap((signal) => policyFamiliesForSignal(signal)),
				DOCUMENT_FAMILY,
			]);
			const ranked = await retrieveSections(deps, {
				queryText: retrievalText,
				conversationId: queryId,
				asOf: caseContext.asOf,
				productScope: caseContext.type === "sme" ? "sme" : "individual",
				jurisdiction: env.jurisdiction,
				statuses: ["approved", "retired"],
				actor: SERVICE_CASE_EXPLAIN,
				topK: env.retrievalTopK,
				familyFilter: (chunk) => families.has(chunk.policyFamily),
				emptyError: "case query embedding is empty",
			});
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
				conversationId: queryId,
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
				const invalid = await settleInvalidAnswer(
					store,
					base,
					retrievedIds,
					result.usage.costUsd,
					validation,
					settle,
				);
				return c.json({
					status: invalid.status,
					items: [],
					limitations: invalid.limitations,
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

	app.post("/internal/policy/sections/resolve", requireService, async (c) => {
		if (!env.assistEnabled)
			throw new HttpError(503, "POLICY_DISABLED", "policy assist is disabled");
		const parsed = resolveSchema.safeParse(await readJson(c));
		if (!parsed.success) throw new HttpError(422, "VALIDATION_ERROR", "invalid request");
		const { applicationId, actorId, actorRole, policyAsOf, productScope, refs } = parsed.data;
		const queryId = randomUUID();
		const base: QueryBase = {
			id: queryId,
			actorId,
			actorRole,
			mode: "case_explain",
			budgetClass: "policy_exception",
			applicationId,
			runId: null,
			questionHmac: null,
			asOf: policyAsOf,
		};
		try {
			const found: Array<BridgeRow | null> = [];
			for (const ref of refs) {
				const row = await store.getSectionByRef({
					policyKey: ref.policyKey,
					sectionId: ref.sectionId,
					asOf: policyAsOf,
					productScope,
					jurisdiction: env.jurisdiction,
					versionId: ref.versionId,
				});
				found.push(
					row
						? {
								policyId: row.policyId,
								policyVersionId: row.policyVersionId,
								policyKey: row.policyKey,
								sectionId: row.sectionId,
								version: row.version,
								heading: row.heading,
								body: row.body,
								effectiveFrom: row.effectiveFrom,
								effectiveTo: row.effectiveTo,
								contentHash: row.contentHash,
							}
						: null,
				);
			}
			const present = found.filter((row): row is BridgeRow => row !== null);
			const acls = await store.loadAcls([...new Set(present.map((row) => row.policyId))]);
			const deliverable: BridgeRow[] = [];
			const missing: Array<{
				policyKey: string;
				sectionId: string;
				reason: "not_found" | "not_effective" | "forbidden" | "truncated";
			}> = [];
			for (const [i, row] of found.entries()) {
				const ref = refs[i]!;
				if (!row) {
					missing.push({ policyKey: ref.policyKey, sectionId: ref.sectionId, reason: "not_found" });
					continue;
				}
				if (!canRead(row.policyId, SERVICE_CASE_EXPLAIN, acls)) {
					missing.push({ policyKey: ref.policyKey, sectionId: ref.sectionId, reason: "forbidden" });
					continue;
				}
				deliverable.push(row);
			}
			const capped = capBridgeBodies(deliverable);
			const sections = [];
			for (const [i, entry] of capped.entries()) {
				if (entry.body.length === 0 && entry.truncated) {
					const row = deliverable[i]!;
					missing.push({ policyKey: row.policyKey, sectionId: row.sectionId, reason: "truncated" });
					continue;
				}
				sections.push(toBridgeDelivery(entry, env.citationSecret, policyAsOf, queryId));
			}
			await logQuery(
				store,
				base,
				sections.length > 0 ? "succeeded" : "no_match",
				null,
				sections.map((section) => `${section.policyKey}#${section.sectionId}`),
				0,
			);
			return c.json({ status: missing.length === 0 ? "ok" : "partial", sections, missing });
		} catch (err) {
			if (err instanceof HttpError) throw err;
			logger.error(
				{ queryId, err: err instanceof Error ? err.message : String(err) },
				"policy exception resolve failed",
			);
			try {
				await logQuery(store, base, "failed", "policy_error", [], 0);
			} catch {
				// Log failures never mask the source-unavailable signal.
			}
			throw new HttpError(503, "POLICY_SOURCE_UNAVAILABLE", "policy source is unavailable");
		}
	});

	app.post("/internal/policy/search", requireService, async (c) => {
		if (!env.assistEnabled)
			throw new HttpError(503, "POLICY_DISABLED", "policy assist is disabled");
		const parsed = bridgeSearchSchema.safeParse(await readJson(c));
		if (!parsed.success) throw new HttpError(422, "VALIDATION_ERROR", "invalid request");
		const { applicationId, actorId, actorRole, policyAsOf, productScope, query } = parsed.data;
		const topK = parsed.data.topK ?? env.retrievalTopK;
		const trimmed = query.trim();
		const queryId = randomUUID();
		const base: QueryBase = {
			id: queryId,
			actorId,
			actorRole,
			mode: "case_explain",
			budgetClass: "policy_exception",
			applicationId,
			runId: null,
			questionHmac: hmacQuestion(env.auditHashSecret, trimmed),
			asOf: policyAsOf,
		};
		if (classifyScope(trimmed) === "out_of_scope") {
			await logQuery(store, { ...base, questionHmac: null }, "out_of_scope", "out_of_scope", [], 0);
			return c.json({ status: "out_of_scope", sections: [], missing: [] });
		}
		if (hasDirectIdentifier(trimmed)) {
			await logQuery(
				store,
				{ ...base, questionHmac: null },
				"identifier_blocked",
				"identifier_blocked",
				[],
				0,
			);
			return c.json({ status: "identifier_blocked", sections: [], missing: [] });
		}
		const reserved = await store.reserveBudget({
			day: today(),
			budgetClass: "policy_exception",
			actorId,
			maxCostUsd: 0.02,
			dailyCapUsd: env.policyExceptionDailyBudgetUsd,
			actorCapUsd: 0,
			ttlSeconds: env.reservationTtlSeconds,
		});
		if ("error" in reserved) {
			await logQuery(store, base, "budget_exceeded", "budget_exceeded", [], 0);
			throw new HttpError(429, "budget_exceeded", "policy exception budget exceeded");
		}
		const settle = makeSettle(
			store,
			reserved.reservationId,
			logger,
			queryId,
			"policy exception budget settle failed",
		);
		try {
			const ranked = await retrieveSections(deps, {
				queryText: trimmed,
				conversationId: queryId,
				asOf: policyAsOf,
				productScope,
				jurisdiction: env.jurisdiction,
				statuses: ["approved", "retired"],
				actor: SERVICE_CASE_EXPLAIN,
				topK,
			});
			const retrievedIds = ranked.map((chunk) => `${chunk.policyKey}#${chunk.sectionId}`);
			if (ranked.length === 0) {
				await logQuery(store, base, "no_match", null, [], 0);
				await settle(0.0005);
				return c.json({ status: "ok", sections: [], missing: [] });
			}
			const rows: BridgeRow[] = ranked.map((chunk) => ({
				policyId: chunk.policyId,
				policyVersionId: chunk.policyVersionId,
				policyKey: chunk.policyKey,
				sectionId: chunk.sectionId,
				version: chunk.version,
				heading: chunk.heading,
				body: chunk.body,
				effectiveFrom: chunk.effectiveFrom,
				effectiveTo: chunk.effectiveTo,
				contentHash: chunk.contentHash,
			}));
			const sections = [];
			for (const entry of capBridgeBodies(rows)) {
				if (entry.body.length === 0 && entry.truncated) continue;
				sections.push(toBridgeDelivery(entry, env.citationSecret, policyAsOf, queryId));
			}
			await logQuery(store, base, "succeeded", null, retrievedIds, 0);
			await settle(0.0005);
			return c.json({ status: "ok", sections, missing: [] });
		} catch (err) {
			if (err instanceof HttpError) throw err;
			logger.error(
				{ queryId, err: err instanceof Error ? err.message : String(err) },
				"policy exception search failed",
			);
			try {
				await logQuery(store, base, "failed", "policy_error", [], 0);
			} catch {
				// Log failures never mask the source-unavailable signal.
			}
			try {
				await settle(0.0005);
			} catch {
				// Settle failures are already warned inside makeSettle.
			}
			throw new HttpError(503, "POLICY_SOURCE_UNAVAILABLE", "policy source is unavailable");
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
		if (version.status !== "draft")
			throw new HttpError(409, "NOT_DRAFT", "only drafts can be approved");
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
		const sectionIds = await store.listVersionSectionIds(version.id);
		const [versionCorpus, approvedCorpus] = await Promise.all([
			store.listVersionCorpusSections(version.id),
			store.listApprovedCorpusSections(),
		]);
		const union = [...approvedCorpus];
		const seen = new Set(union.map((s) => `${s.policyKey}#${s.sectionId}`));
		for (const s of versionCorpus) {
			const key = `${s.policyKey}#${s.sectionId}`;
			if (!seen.has(key)) {
				union.push(s);
				seen.add(key);
			}
		}
		// Ref check first: actionable 409 before any standard-body fetch.
		try {
			assertRegistryRefs(union);
		} catch (err) {
			if (err instanceof CorpusIntegrityError) throw new HttpError(409, err.code, err.message);
			throw err;
		}
		const versionPolicyKey = versionCorpus[0]?.policyKey;
		const standardBodies: Array<{ sectionId: string; body: string }> = [];
		if (versionPolicyKey === "POL-CR-009") {
			for (const sectionId of POLICY_ENGINE_STANDARD_SECTION_IDS) {
				const section = await store.getSection(version.id, sectionId);
				if (!section) {
					throw new HttpError(
						409,
						"REGISTRY_MAPPING_MISSING",
						`standard section missing: ${sectionId}`,
					);
				}
				standardBodies.push({ sectionId, body: section.body });
			}
		} else {
			for (const sectionId of POLICY_ENGINE_STANDARD_SECTION_IDS) {
				const row = await store.getSectionByRef({
					policyKey: "POL-CR-009",
					sectionId,
					asOf: effectiveFrom,
					productScope: "individual",
					jurisdiction: env.jurisdiction,
				});
				if (!row) {
					throw new HttpError(
						409,
						"REGISTRY_MAPPING_MISSING",
						`standard section missing: ${sectionId}`,
					);
				}
				standardBodies.push({ sectionId, body: row.body });
			}
		}
		void sectionIds;
		try {
			assertStandardHash(standardBodies);
		} catch (err) {
			if (err instanceof CorpusIntegrityError) throw new HttpError(409, err.code, err.message);
			throw err;
		}
		if (!(await store.hasVersionChunks(version.id))) {
			throw new HttpError(
				409,
				"INDEX_NOT_BUILT",
				`active index is missing chunks for version ${version.id}; run pnpm --filter @credit/policy reindex -- --version=${version.id}`,
			);
		}
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
