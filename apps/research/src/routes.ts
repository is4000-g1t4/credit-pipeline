// Internal research API (signed). Run/finding routes are officer-only and
// case-scoped (T00 access grants); access grant/revoke routes are
// service-only. All run/finding routes verify the run belongs to
// `:applicationId`; mismatch is 404.
// Wave 3 (review routes/UI) is out of scope — this file serves review only.
import {
	agentFindingReviews,
	agentFindings,
	agentRuns,
	agentRunViews,
	contextSignalReviews,
	contextSignals,
	withTx,
	type Db,
} from "@credit/db/research";
import {
	HttpError,
	readJson,
	requireOfficer,
	requireService,
	signInternalHeaders,
	zodFields,
	type Logger,
	type ServiceApp,
} from "@credit/service-kit";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { caseFactsSchema } from "@credit/core";
import {
	auditResearch,
	claimOfficerAccess,
	grantResearchAccess,
	hasResearchAccess,
	requireOrClaimResearchAccess,
	requireResearchAccess,
	requireRunAccess,
	revokeResearchAccess,
	type AccessRole,
} from "./access.js";
import type { AgentRunner } from "./agent.js";
import {
	CaseAssistantError,
	type CaseAssistantOutput,
	type CaseAssistantRunner,
	type CaseAssistantToolEvent,
} from "./case-assistant.js";
import { checkAutoCaps } from "./auto-trigger.js";
import type { ContextAgentRunner } from "./context-agent.js";
import type { ResearchEnv } from "./env.js";
import {
	claimContextRetry,
	claimContextRetryTx,
	ensureRunTx,
	getRun,
	latestRunForApplication,
	summarizeRun,
	type CaseFactsPayload,
	type RunRow,
} from "./lifecycle.js";
import type { Observability } from "./observability.js";
import { aggregateRun, toContextSignalDto } from "./aggregate.js";
import { executeRun } from "./run.js";
import { contextConsentProbe, executeContextRetry } from "./context-stage.js";
import type { LanguageRepair } from "./repair.js";
import type { PolicyRunner } from "./policy-stage.js";
import type { SupportJudge } from "./support.js";
import { sha256Hex } from "./validator.js";
import { isUuid } from "./ids.js";

const ensureSchema = z
	.object({
		applicationId: z.uuid(),
		caseFacts: caseFactsSchema,
		aiResearchConsent: z.boolean(),
	})
	.strict();

const reviewSchema = z
	.object({
		action: z.enum(["accepted", "rejected"]),
		note: z.string().max(1000).optional(),
	})
	.strict();

// T00 service-only access management. The role matrix lives here as a
// strict enum: anything outside it is 422, never a silent downgrade.
const grantSchema = z
	.object({
		userId: z.uuid(),
		accessRole: z.enum(["assigned_officer", "compliance", "policy_owner", "safeguarding"]),
	})
	.strict();

const revokeSchema = z
	.object({
		userId: z.uuid(),
	})
	.strict();

export interface ResearchRouteDeps {
	db: Db;
	env: ResearchEnv;
	logger: Logger;
	runner: AgentRunner;
	judge: SupportJudge;
	repair: LanguageRepair;
	observability: Observability;
	contextRunner: ContextAgentRunner;
	/** Test seam: fresh context-consent probe; default reads research-context over HMAC. */
	fetchContextConsent?: (applicationId: string) => Promise<boolean>;
	/** T03/T04 automatic case policy review; absent fails the policy stage only. */
	policyRunner?: PolicyRunner;
	/** Case-scoped read-only assistant; absent fails the assistant route closed (503). */
	caseAssistant?: CaseAssistantRunner;
	/** Test seam: full research-context body; default reads it over HMAC. */
	fetchResearchContext?: (applicationId: string) => Promise<{
		caseFacts: Record<string, unknown>;
		contextAnalysisConsent: unknown;
	}>;
	/** Test seam: officer need-to-know check; default calls applications. */
	checkAssistantCaseAccess?: (
		applicationId: string,
		user: { id: string; email: string; role: string },
	) => Promise<void>;
}

/** Absent assistant runner: the route fails closed (503), never silent. */
const unavailableCaseAssistantRunner: CaseAssistantRunner = {
	async run() {
		throw new CaseAssistantError("CASE_ASSISTANT_UNAVAILABLE", "case assistant is not configured");
	},
};

/**
 * Full research-context body over the signed service route (fail typed:
 * unknown ids 404, drafts 409, anything else a 502 without case content).
 */
async function fetchResearchContextOverHttp(
	env: ResearchEnv,
	applicationId: string,
): Promise<{ caseFacts: Record<string, unknown>; contextAnalysisConsent: unknown }> {
	const path = `/internal/applications/${applicationId}/research-context`;
	const headers = signInternalHeaders(env.internalSecret, {
		userId: env.autoTriggerServiceUserId,
		role: "service",
		email: env.autoTriggerServiceEmail,
		method: "GET",
		path,
	});
	let res: Response;
	try {
		res = await fetch(`${env.applicationsUrl}${path}`, {
			headers,
			signal: AbortSignal.timeout(10_000),
		});
	} catch {
		throw new HttpError(502, "CASE_ASSISTANT_FAILED", "case context is unavailable");
	}
	if (res.status === 404) throw new HttpError(404, "NOT_FOUND", "not found");
	if (res.status === 409)
		throw new HttpError(409, "CASE_NOT_SUBMITTED", "application is not submitted");
	if (!res.ok) throw new HttpError(502, "CASE_ASSISTANT_FAILED", "case context is unavailable");
	const body = (await res.json()) as {
		caseFacts?: unknown;
		contextAnalysisConsent?: unknown;
	};
	if (
		!body ||
		typeof body !== "object" ||
		body.caseFacts === null ||
		typeof body.caseFacts !== "object"
	) {
		throw new HttpError(502, "CASE_ASSISTANT_FAILED", "case facts are unavailable");
	}
	return {
		caseFacts: body.caseFacts as Record<string, unknown>,
		contextAnalysisConsent: body.contextAnalysisConsent,
	};
}

/**
 * Officer need-to-know check over the signed user route. Applications owns the
 * rule (any non-draft case except another officer's active assignment or a
 * revoked officer); unknown/forbidden cases 404 without case content.
 */
async function checkAssistantCaseAccessOverHttp(
	env: ResearchEnv,
	applicationId: string,
	user: { id: string; email: string; role: string },
): Promise<void> {
	const path = `/internal/applications/${applicationId}/assistant-access`;
	const headers = signInternalHeaders(env.internalSecret, {
		userId: user.id,
		role: "officer",
		email: user.email,
		method: "GET",
		path,
	});
	let res: Response;
	try {
		res = await fetch(`${env.applicationsUrl}${path}`, {
			headers,
			signal: AbortSignal.timeout(5_000),
		});
	} catch {
		throw new HttpError(502, "CASE_ASSISTANT_FAILED", "case access check failed");
	}
	if (res.status === 404) throw new HttpError(404, "NOT_FOUND", "not found");
	if (!res.ok) throw new HttpError(502, "CASE_ASSISTANT_FAILED", "case access check failed");
}

/** UTC minute bucket for the per-officer/run/minute view dedupe key. */
export function viewMinuteBucket(d: Date = new Date()): Date {
	return new Date(Math.floor(d.getTime() / 60_000) * 60_000);
}

async function scopedRun(db: Db, applicationId: string, runId: string): Promise<RunRow> {
	if (!isUuid(applicationId) || !isUuid(runId)) {
		throw new HttpError(404, "NOT_FOUND", "not found");
	}
	const run = await getRun(db, runId);
	if (!run || run.applicationId !== applicationId) {
		throw new HttpError(404, "NOT_FOUND", "not found");
	}
	return run;
}

export function researchRoutes(deps: ResearchRouteDeps): ServiceApp {
	const app: ServiceApp = new Hono();
	const { db, env, logger, runner, judge, repair, observability, contextRunner } = deps;

	app.post("/internal/research/runs/ensure", requireOfficer, async (c) => {
		const me = c.var.user;
		const parsed = ensureSchema.safeParse(await readJson(c));
		if (!parsed.success) {
			throw new HttpError(
				422,
				"VALIDATION_ERROR",
				"invalid ensure request",
				zodFields(parsed.error),
			);
		}
		const { applicationId, caseFacts, aiResearchConsent } = parsed.data;
		if (applicationId !== caseFacts.applicationId) {
			throw new HttpError(422, "VALIDATION_ERROR", "application id mismatch");
		}
		// T00: fail-closed validation BEFORE the claim, so a rejected
		// request never leaves an orphan grant behind. ensureRun
		// re-validates the same predicates; drift fails closed there.
		if (!aiResearchConsent) {
			throw new HttpError(403, "CONSENT_REQUIRED", "AI research consent is required");
		}
		if (caseFacts.status !== "pending_review") {
			throw new HttpError(409, "CASE_NOT_PENDING", "case is not awaiting an officer decision");
		}
		if (caseFacts.asOf !== caseFacts.submittedAt) {
			throw new HttpError(422, "VALIDATION_ERROR", "asOf must equal submittedAt");
		}
		// Claim-on-first-run: another user's active assigned_officer grant is
		// 404 (non-disclosure); otherwise this officer owns the case from here.
		await claimOfficerAccess(db, applicationId, me.id);
		// The run insert and its `run.ensure` audit commit atomically: a
		// failed audit leaves no unaudited run behind.
		const { run, inserted } = await withTx(db, async (tx) => {
			const ensured = await ensureRunTx(tx, env, {
				applicationId,
				requestedBy: me.id,
				caseFacts: caseFacts as CaseFactsPayload,
				aiResearchConsent,
			});
			await auditResearch(tx, {
				applicationId,
				runId: ensured.run.id,
				actorId: me.id,
				actorRole: me.role,
				action: "run.ensure",
				metadata: { status: ensured.run.status, inserted: ensured.inserted },
			});
			return ensured;
		});
		if (inserted && run.runToken) {
			// Exactly one background execution, only when this call inserted.
			// executeRun finalizes every failure path itself; the async
			// wrapper keeps the fire-and-forget rejection-free and logs the
			// sanitized outcome (runId + error code, never case content).
			const token: string = run.runToken;
			const runId = run.id;
			const exec = async (): Promise<void> => {
				try {
					await executeRun(
						{
							db,
							env,
							logger,
							runner,
							judge,
							repair,
							observability,
							contextRunner,
							fetchContextConsent: deps.fetchContextConsent,
							policyRunner: deps.policyRunner,
						},
						runId,
						token,
					);
				} catch (err) {
					logger.error(
						{ runId, err: err instanceof Error ? err.message : String(err) },
						"research background execution escaped",
					);
				}
			};
			void exec();
		}
		return c.json({ run: summarizeRun(run), inserted }, 202);
	});

	app.get("/internal/research/applications/:applicationId/latest", requireOfficer, async (c) => {
		const applicationId = c.req.param("applicationId");
		if (!isUuid(applicationId)) throw new HttpError(404, "NOT_FOUND", "not found");
		// T11: an auto run carries no officer grant — the first officer to
		// open it claims the case here; any later officer gets 404.
		await requireOrClaimResearchAccess(db, applicationId, c.var.user.id, c.var.user.role);
		const run = await latestRunForApplication(db, applicationId);
		if (!run) throw new HttpError(404, "NOT_FOUND", "no research run for this application");
		await auditResearch(db, {
			applicationId,
			runId: run.id,
			actorId: c.var.user.id,
			actorRole: c.var.user.role,
			action: "run.read",
		});
		// Withdrawn context consent gates stored context at read time: the
		// external brief stays readable, but a stored brief/signals are
		// omitted (audited as context.denied) — no officer reads context
		// after withdrawal, even before the purge lands. Runs with no
		// stored brief skip the probe (nothing to hide, no audit noise).
		let includeContext = true;
		if (run.contextBrief !== null || run.policyBrief !== null) {
			includeContext = await contextConsentProbe(deps, env)(applicationId);
			if (!includeContext) {
				await auditResearch(db, {
					applicationId,
					runId: run.id,
					actorId: c.var.user.id,
					actorRole: c.var.user.role,
					action: "context.denied",
					metadata: { code: "consent_withdrawn", policy: run.policyBrief !== null },
				});
			} else if (run.contextBrief !== null || run.policyBrief !== null) {
				// The response carries stored context/policy: mark the officer
				// read. Withdrawn consent takes the branch above.
				await auditResearch(db, {
					applicationId,
					runId: run.id,
					actorId: c.var.user.id,
					actorRole: c.var.user.role,
					action: "context.read",
					metadata: { route: "latest", policy: run.policyBrief !== null },
				});
			}
		}
		return c.json(
			await aggregateRun(db, run, c.var.user.id, {
				includeContext,
				includePolicy: includeContext,
			}),
		);
	});

	app.post(
		"/internal/research/applications/:applicationId/runs/:runId/view",
		requireOfficer,
		async (c) => {
			const me = c.var.user;
			const run = await scopedRun(db, c.req.param("applicationId"), c.req.param("runId"));
			// T11 claim-on-first-read (see latest).
			await requireOrClaimResearchAccess(db, run.applicationId, me.id, me.role);
			await auditResearch(db, {
				applicationId: run.applicationId,
				runId: run.id,
				actorId: me.id,
				actorRole: me.role,
				action: "run.view",
			});
			const recent = (await db.execute(
				sql`SELECT viewed_at FROM agent_run_views
					WHERE run_id = ${run.id} AND officer_id = ${me.id}
					  AND viewed_at > now() - INTERVAL '60 seconds'
					ORDER BY viewed_at DESC LIMIT 1`,
			)) as unknown as Array<{ viewed_at: string }>;
			if (recent[0]) {
				// Raw execute returns timestamptz as text; parse explicitly.
				const viewedAt = new Date(recent[0].viewed_at).toISOString();
				return c.json({ runId: run.id, viewedAt, deduped: true });
			}
			// Minute-bucket unique index + DO NOTHING: concurrent first
			// views collapse to one row instead of double-inserting.
			const inserted = await db
				.insert(agentRunViews)
				.values({ runId: run.id, officerId: me.id, viewedMinute: viewMinuteBucket() })
				.onConflictDoNothing()
				.returning({ viewedAt: agentRunViews.viewedAt });
			if (inserted[0]) {
				return c.json({
					runId: run.id,
					viewedAt: inserted[0].viewedAt.toISOString(),
					deduped: false,
				});
			}
			// Lost the race inside the bucket: re-read the winner.
			const winner = (await db.execute(
				sql`SELECT viewed_at FROM agent_run_views
					WHERE run_id = ${run.id} AND officer_id = ${me.id}
					ORDER BY viewed_at DESC LIMIT 1`,
			)) as unknown as Array<{ viewed_at: string }>;
			return c.json({
				runId: run.id,
				viewedAt: winner[0]
					? new Date(winner[0].viewed_at).toISOString()
					: new Date().toISOString(),
				deduped: true,
			});
		},
	);

	app.get(
		"/internal/research/applications/:applicationId/runs/:runId/bundle",
		requireOfficer,
		async (c) => {
			const run = await scopedRun(db, c.req.param("applicationId"), c.req.param("runId"));
			// T11 claim-on-first-read (see latest).
			await requireOrClaimResearchAccess(db, run.applicationId, c.var.user.id, c.var.user.role);
			if (run.status !== "succeeded" || !run.brief) {
				throw new HttpError(404, "NOT_FOUND", "no succeeded research bundle");
			}
			// The deciding officer's latest view freezes into the bundle
			// (§2.1.5/§8.6): another officer's view never satisfies it.
			const aggregate = await aggregateRun(db, run, c.var.user.id);
			const accepted = aggregate.findings.filter((f) => f.reviewStatus === "accepted");
			// An empty accepted set is stale, not a bundle: the min(1) schema
			// shape would otherwise surprise review with a 503.
			if (accepted.length === 0) {
				throw new HttpError(
					409,
					"RESEARCH_SELECTION_STALE",
					"no accepted findings remain on this run",
				);
			}
			await auditResearch(db, {
				applicationId: run.applicationId,
				runId: run.id,
				actorId: c.var.user.id,
				actorRole: c.var.user.role,
				action: "bundle.read",
			});
			// The bundle read touches a run carrying stored context: mark
			// the contact like latest does (read when consent allows, denied
			// when withdrawn — the bundle itself carries no context bytes).
			if (run.contextBrief !== null) {
				const allowed = await contextConsentProbe(deps, env)(run.applicationId);
				await auditResearch(db, {
					applicationId: run.applicationId,
					runId: run.id,
					actorId: c.var.user.id,
					actorRole: c.var.user.role,
					action: allowed ? "context.read" : "context.denied",
					metadata: allowed ? { route: "bundle" } : { code: "consent_withdrawn", route: "bundle" },
				});
			}
			return c.json({
				bundle: {
					agentRunId: run.id,
					applicationId: run.applicationId,
					briefHash: sha256Hex(JSON.stringify(run.brief)),
					viewedAt: aggregate.viewedAt,
					acceptedFindings: accepted.map((f) => ({
						findingId: f.id,
						claim: f.claim,
						category: f.category,
						entityMatch: f.entityMatch,
						evidence: f.evidence.map((e) => ({
							url: e.url,
							quote: e.quote,
							snapshotHash: e.snapshotHash,
						})),
					})),
				},
			});
		},
	);

	app.post(
		"/internal/research/applications/:applicationId/findings/:findingId/review",
		requireOfficer,
		async (c) => {
			const me = c.var.user;
			const applicationId = c.req.param("applicationId");
			const findingId = c.req.param("findingId");
			if (!isUuid(applicationId) || !isUuid(findingId)) {
				throw new HttpError(404, "NOT_FOUND", "not found");
			}
			const parsed = reviewSchema.safeParse(await readJson(c));
			if (!parsed.success) {
				throw new HttpError(422, "VALIDATION_ERROR", "invalid review", zodFields(parsed.error));
			}
			const findingRows = await db
				.select()
				.from(agentFindings)
				.where(eq(agentFindings.id, findingId))
				.limit(1);
			const finding = findingRows[0];
			if (!finding) throw new HttpError(404, "NOT_FOUND", "not found");
			const run = await requireRunAccess(db, applicationId, finding.runId, me.id, me.role);
			if (run.status !== "succeeded") {
				throw new HttpError(
					409,
					"RUN_NOT_SUCCEEDED",
					"findings can be reviewed only on a succeeded run",
				);
			}
			const [review] = await withTx(db, async (tx) => {
				// Review insert + audit commit atomically: a failed audit
				// leaves no unaudited review behind.
				const [row] = await tx
					.insert(agentFindingReviews)
					.values({
						findingId,
						runId: run.id,
						officerId: me.id,
						action: parsed.data.action,
						note: parsed.data.note ?? null,
					})
					.returning({ id: agentFindingReviews.id });
				await auditResearch(tx, {
					applicationId,
					runId: run.id,
					actorId: me.id,
					actorRole: me.role,
					action: "finding.review",
					metadata: { findingId, reviewAction: parsed.data.action },
				});
				return [row];
			});
			return c.json({ id: review.id, findingId, action: parsed.data.action }, 201);
		},
	);

	// T18 context signal review (D4): officer-only, append-only. Resolves
	// signal -> run -> application and requires it equals :applicationId;
	// cross-case or unknown ids are 404, superseded signals are 409. Reviews
	// survive signal purge (plain signal_id, ids-only snapshot, no FK).
	app.post(
		"/internal/research/applications/:applicationId/context/signals/:signalId/review",
		requireOfficer,
		async (c) => {
			const me = c.var.user;
			const applicationId = c.req.param("applicationId");
			const signalId = c.req.param("signalId");
			if (!isUuid(applicationId) || !isUuid(signalId)) {
				throw new HttpError(404, "NOT_FOUND", "not found");
			}
			const parsed = reviewSchema.safeParse(await readJson(c));
			if (!parsed.success) {
				throw new HttpError(422, "VALIDATION_ERROR", "invalid review", zodFields(parsed.error));
			}
			const signalRows = await db
				.select()
				.from(contextSignals)
				.where(eq(contextSignals.id, signalId))
				.limit(1);
			const signal = signalRows[0];
			if (!signal) throw new HttpError(404, "NOT_FOUND", "not found");
			const run = await requireRunAccess(db, applicationId, signal.runId, me.id, me.role);
			// Withdrawn consent rejects reviews of prior context too: the
			// officer cannot act on signals they may no longer read.
			const probeConsent = contextConsentProbe(deps, env);
			if (!(await probeConsent(applicationId))) {
				await auditResearch(db, {
					applicationId,
					runId: run.id,
					actorId: me.id,
					actorRole: me.role,
					action: "context.denied",
					metadata: { code: "consent_withdrawn", signalId },
				});
				throw new HttpError(
					403,
					"CONTEXT_CONSENT_REQUIRED",
					"context analysis consent is required",
				);
			}
			let withdrawnInTx = false;
			let review: { id: string; createdAt: Date };
			try {
				[review] = await withTx(db, async (tx) => {
					// The supersede check lives INSIDE the insert transaction
					// under a row lock: a retry superseding between the read
					// above and this write 409s instead of reviewing history.
					const locked = await tx
						.select({ supersededAt: contextSignals.supersededAt })
						.from(contextSignals)
						.where(eq(contextSignals.id, signalId))
						.for("update");
					if (!locked[0]) throw new HttpError(404, "NOT_FOUND", "not found");
					if (locked[0].supersededAt !== null) {
						throw new HttpError(
							409,
							"SIGNAL_SUPERSEDED",
							"signal was superseded by a newer context stage",
						);
					}
					// Live consent recheck INSIDE the insert transaction
					// (consent + stage version): a withdrawal racing the
					// pre-check above aborts the review instead of acting on
					// unreadable context.
					if (!(await probeConsent(applicationId))) {
						withdrawnInTx = true;
						throw new HttpError(
							403,
							"CONTEXT_CONSENT_REQUIRED",
							"context analysis consent is required",
						);
					}
					// Review insert + audit commit atomically: a failed audit
					// leaves no unaudited review behind.
					const [row] = await tx
						.insert(contextSignalReviews)
						.values({
							signalId,
							runId: run.id,
							// Ids-only snapshot (type/period/metric/status) — no
							// free text, so the row stays meaningful after purge.
							signalSnapshot: {
								type: signal.type,
								periodStart: signal.periodStart,
								periodEnd: signal.periodEnd,
								metric: signal.metric,
								status: signal.status,
								policyVersion: signal.policyVersion,
								accountScope: signal.accountScope,
							},
							officerId: me.id,
							action: parsed.data.action,
							note: parsed.data.note ?? null,
						})
						.returning({ id: contextSignalReviews.id, createdAt: contextSignalReviews.createdAt });
					await auditResearch(tx, {
						applicationId,
						runId: run.id,
						actorId: me.id,
						actorRole: me.role,
						action: "context.signal_review",
						metadata: { signalId, reviewAction: parsed.data.action },
					});
					return [row];
				});
			} catch (err) {
				// The in-tx denial audit would roll back with the
				// transaction, so record it outside like the pre-check path.
				if (withdrawnInTx) {
					await auditResearch(db, {
						applicationId,
						runId: run.id,
						actorId: me.id,
						actorRole: me.role,
						action: "context.denied",
						metadata: { code: "consent_withdrawn", signalId },
					});
				}
				throw err;
			}
			return c.json(
				{
					id: review.id,
					signalId,
					action: parsed.data.action,
					signal: toContextSignalDto(signal, {
						action: parsed.data.action,
						reviewedAt: review.createdAt.toISOString(),
					}),
				},
				201,
			);
		},
	);

	// T18 context purge (SPEC-t17-t18 §4): service-only, called by the
	// applications service when context consent is withdrawn. Covers every
	// stage state, not just terminal ones: queued/running stages are moved to
	// `skipped` with the stage token cleared (a running stage's token no
	// longer matches, so it cannot persist after the purge), live signals are
	// superseded with their content blanked (observed/expected/explanation
	// nulled, evidence emptied), and stored brief/validation/usage are
	// nulled. Read gating on live consent already hides prior context
	// immediately; this is the durable data-minimization half. Audited as
	// context.purge.
	app.post(
		"/internal/research/applications/:applicationId/context/purge",
		requireService,
		async (c) => {
			const me = c.var.user;
			const applicationId = c.req.param("applicationId");
			if (!isUuid(applicationId)) throw new HttpError(404, "NOT_FOUND", "not found");
			const { purgedRuns, purgedSignals } = await withTx(db, async (tx) => {
				// Terminal stages first: the live update below moves
				// queued/running rows into `skipped`, so it must run second
				// (otherwise one row matches both updates and counts twice).
				const terminal = await tx
					.update(agentRuns)
					.set({ contextBrief: null, contextValidation: null, contextUsage: null })
					.where(
						and(
							eq(agentRuns.applicationId, applicationId),
							inArray(agentRuns.contextStatus, ["succeeded", "failed", "skipped"]),
						),
					)
					.returning({ id: agentRuns.id });
				// Queued/running stages become skipped with the token
				// cleared: a running stage's token no longer matches, so it
				// cannot persist after the purge.
				const live = await tx
					.update(agentRuns)
					.set({
						contextStatus: "skipped",
						contextBrief: null,
						contextValidation: null,
						contextUsage: null,
						contextStageToken: null,
						contextFinishedAt: new Date(),
					})
					.where(
						and(
							eq(agentRuns.applicationId, applicationId),
							inArray(agentRuns.contextStatus, ["queued", "running"]),
						),
					)
					.returning({ id: agentRuns.id });
				const ids = [...live, ...terminal].map((r) => r.id);
				if (ids.length === 0) return { purgedRuns: 0, purgedSignals: 0 };
				// Supersede every signal for the application's runs and blank
				// stored content (history rows keep ids for review audit).
				const signals = await tx
					.update(contextSignals)
					.set({
						supersededAt: sql`COALESCE(${contextSignals.supersededAt}, now())` as unknown as Date,
						observed: null,
						expected: null,
						explanation: null,
						evidence: [],
					})
					.where(inArray(contextSignals.runId, ids))
					.returning({ id: contextSignals.id });
				return { purgedRuns: ids.length, purgedSignals: signals.length };
			});
			await auditResearch(db, {
				applicationId,
				actorId: me.id,
				actorRole: me.role,
				action: "context.purge",
				metadata: { purgedRuns, purgedSignals },
			});
			return c.json({ applicationId, purgedRuns, purgedSignals });
		},
	);

	// T18 context retry (D3 internal seam; D4 review/gateway proxy it): an
	// officer-only async retry of the context stage on the same run. Only
	// for a terminal run whose stage is terminal-failed/skipped, max one
	// retry, never an external rerun and never before finalization. Returns
	// 202 with the new stage token/version; officers poll latest.
	app.post(
		"/internal/research/applications/:applicationId/runs/:runId/context/retry",
		requireOfficer,
		async (c) => {
			const me = c.var.user;
			const applicationId = c.req.param("applicationId");
			const runId = c.req.param("runId");
			const run = await scopedRun(db, applicationId, runId);
			await requireResearchAccess(db, applicationId, me.id, me.role);
			if (run.status !== "succeeded" && run.status !== "failed") {
				throw new HttpError(409, "RUN_NOT_TERMINAL", "context retry needs a terminal run");
			}
			if (!env.agentsEnabled) {
				throw new HttpError(409, "AGENTS_DISABLED", "agentic research is disabled");
			}
			if (!env.contextEnabled) {
				throw new HttpError(409, "CONTEXT_DISABLED", "context analysis is disabled");
			}
			if (!(await contextConsentProbe(deps, env)(applicationId))) {
				throw new HttpError(
					403,
					"CONTEXT_CONSENT_REQUIRED",
					"context analysis consent is required",
				);
			}
			// Auto-run retries draw the automation budget: caps and claim
			// commit atomically under the same global advisory lock as the
			// ensure path, so concurrent retries cannot jointly overshoot a
			// cap and a claimed retry reserves its stage spend (in-flight)
			// for the rest of the day. Officer runs never consume it.
			let claimed: { stageToken: string; stageVersion: number } | null;
			if (run.trigger === "auto" && run.applicantUserId) {
				const decided = await withTx(db, async (tx) => {
					await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('research-auto-caps'))`);
					// Caps and claim under one lock: a concurrent retry that
					// committed first is visible here, so two retries cannot
					// jointly overshoot a cap.
					const caps = await checkAutoCaps(tx, env, run.applicantUserId as string);
					if (!caps.ok) {
						return { caps, claimed: null } as const;
					}
					return { caps, claimed: await claimContextRetryTx(tx, env, runId) } as const;
				});
				if (!decided.caps.ok) {
					throw new HttpError(409, "AUTO_CAP_EXCEEDED", `retry blocked: ${decided.caps.reason}`);
				}
				claimed = decided.claimed;
			} else {
				claimed = await claimContextRetry(db, env, runId);
			}
			if (!claimed) {
				throw new HttpError(
					409,
					"RETRY_UNAVAILABLE",
					"context retry is not available for this run",
				);
			}
			await auditResearch(db, {
				applicationId,
				runId: run.id,
				actorId: me.id,
				actorRole: me.role,
				action: "context.retry",
				metadata: { stageVersion: claimed.stageVersion },
			});
			const stageToken: string = claimed.stageToken;
			const exec = async (): Promise<void> => {
				try {
					await executeContextRetry(
						{
							db,
							env,
							logger,
							contextRunner,
							observability,
							fetchContextConsent: deps.fetchContextConsent,
						},
						runId,
						stageToken,
					);
				} catch (err) {
					logger.error(
						{ runId, err: err instanceof Error ? err.message : String(err) },
						"context retry execution escaped",
					);
				}
			};
			void exec();
			return c.json(
				{
					runId: run.id,
					contextStageToken: claimed.stageToken,
					contextStageVersion: claimed.stageVersion,
				},
				202,
			);
		},
	);
	// T11: recent auto-trigger history (skips, ensures, duplicates) for an
	// authorized officer — this is how a skip reason becomes visible. With
	// no auto.* history AND no run at all the endpoint returns
	// `{entries:[]}` WITHOUT claiming (merely opening a case page must not
	// assign it); when a run exists but the caller holds no grant it
	// returns the same audited 404 as latest (non-disclosure). Only when
	// history exists does the first officer claim via T00
	// `claimOfficerAccess` (a skip usually leaves no run and no grant
	// behind, so plain requireResearchAccess would 404 for everyone) — any
	// later officer gets 404. An officer who already holds an active grant
	// (assigned or specialist) reads without claiming. Entries carry
	// ids/codes/reasons only, never case facts, quotes, or applicant data.
	app.get("/internal/research/applications/:applicationId/audit", requireOfficer, async (c) => {
		const applicationId = c.req.param("applicationId");
		if (!isUuid(applicationId)) throw new HttpError(404, "NOT_FOUND", "not found");
		const rows = (await db.execute(
			sql`SELECT action, actor_role, run_id, metadata, created_at FROM research_audit_log
				WHERE application_id = ${applicationId} AND action IN ('auto.skip', 'auto.ensure', 'auto.duplicate')
				ORDER BY created_at DESC LIMIT 50`,
		)) as unknown as Array<{
			action: string;
			actor_role: string;
			run_id: string | null;
			metadata: unknown;
			created_at: string;
		}>;
		if (rows.length === 0) {
			// No auto history: a stranger on a run-less case sees the same
			// empty answer as the owner (nothing is assigned by looking);
			// a stranger on a case with a run gets the audited 404.
			if (await hasResearchAccess(db, applicationId, c.var.user.id)) {
				return c.json({ applicationId, entries: [] });
			}
			const runs = (await db.execute(
				sql`SELECT id FROM agent_runs WHERE application_id = ${applicationId} LIMIT 1`,
			)) as unknown as Array<{ id: string }>;
			if (runs.length === 0) return c.json({ applicationId, entries: [] });
			await requireResearchAccess(db, applicationId, c.var.user.id, c.var.user.role);
			return c.json({ applicationId, entries: [] });
		}
		if (await hasResearchAccess(db, applicationId, c.var.user.id)) {
			await auditResearch(db, {
				applicationId,
				actorId: c.var.user.id,
				actorRole: c.var.user.role,
				action: "run.read",
				metadata: { scope: "auto-audit" },
			});
			return c.json({
				applicationId,
				entries: rows.map((r) => ({
					action: r.action,
					actorRole: r.actor_role,
					runId: r.run_id,
					metadata: r.metadata ?? {},
					createdAt: new Date(r.created_at).toISOString(),
				})),
			});
		}
		await claimOfficerAccess(db, applicationId, c.var.user.id);
		await auditResearch(db, {
			applicationId,
			actorId: c.var.user.id,
			actorRole: c.var.user.role,
			action: "run.read",
			metadata: { scope: "auto-audit" },
		});
		return c.json({
			applicationId,
			entries: rows.map((r) => ({
				action: r.action,
				actorRole: r.actor_role,
				runId: r.run_id,
				metadata: r.metadata ?? {},
				createdAt: new Date(r.created_at).toISOString(),
			})),
		});
	});

	// T00 service-only access management (future auto-trigger principal and
	// specialist grants). Officers and applicants get 403 via
	// `requireService`; every grant/revoke is audited with ids/roles only.
	app.post(
		"/internal/research/applications/:applicationId/access/grants",
		requireService,
		async (c) => {
			const me = c.var.user;
			const applicationId = c.req.param("applicationId");
			if (!isUuid(applicationId)) throw new HttpError(404, "NOT_FOUND", "not found");
			const parsed = grantSchema.safeParse(await readJson(c));
			if (!parsed.success) {
				throw new HttpError(422, "VALIDATION_ERROR", "invalid grant", zodFields(parsed.error));
			}
			const grant = await grantResearchAccess(db, {
				applicationId,
				userId: parsed.data.userId,
				accessRole: parsed.data.accessRole as AccessRole,
				grantedBy: me.id,
				granterRole: me.role,
			});
			return c.json(
				{
					grant: {
						id: grant.id,
						applicationId: grant.applicationId,
						userId: grant.userId,
						accessRole: grant.accessRole,
						grantedBy: grant.grantedBy,
						grantedAt: grant.grantedAt.toISOString(),
						revokedAt: grant.revokedAt?.toISOString() ?? null,
					},
				},
				201,
			);
		},
	);

	app.post(
		"/internal/research/applications/:applicationId/access/revoke",
		requireService,
		async (c) => {
			const me = c.var.user;
			const applicationId = c.req.param("applicationId");
			if (!isUuid(applicationId)) throw new HttpError(404, "NOT_FOUND", "not found");
			const parsed = revokeSchema.safeParse(await readJson(c));
			if (!parsed.success) {
				throw new HttpError(422, "VALIDATION_ERROR", "invalid revoke", zodFields(parsed.error));
			}
			await revokeResearchAccess(db, {
				applicationId,
				userId: parsed.data.userId,
				revokedBy: me.id,
				revokerRole: me.role,
			});
			return c.json({ applicationId, userId: parsed.data.userId, revoked: true });
		},
	);

	// Case-scoped read-only assistant (officer Q&A over one case). Flag-gated
	// (404 without agents + case-assistant flags); consent-gated (403 without
	// context consent); drafts 409 via research-context. The runner owns the
	// tool loop and answer validation; this route never sees prompts, tool
	// results, or PII beyond the officer's own question.
	app.post(
		"/internal/research/applications/:applicationId/assistant",
		requireOfficer,
		async (c) => {
			const startedAt = Date.now();
			const me = c.var.user;
			const applicationId = c.req.param("applicationId");
			if (!isUuid(applicationId)) throw new HttpError(404, "NOT_FOUND", "not found");
			if (!env.agentsEnabled || !env.caseAssistantEnabled) {
				throw new HttpError(404, "CASE_ASSISTANT_DISABLED", "case assistant is disabled");
			}
			const parsed = z
				.object({
					question: z.string().min(1).max(env.caseAssistantMaxQuestionChars),
					history: z
						.array(
							z
								.object({
									role: z.enum(["user", "assistant"]),
									text: z.string().min(1).max(env.caseAssistantMaxHistoryChars),
								})
								.strict(),
						)
						.max(env.caseAssistantMaxHistoryMessages)
						.optional(),
				})
				.strict()
				.safeParse(await readJson(c));
			if (!parsed.success) {
				throw new HttpError(
					422,
					"VALIDATION_ERROR",
					"invalid assistant request",
					zodFields(parsed.error),
				);
			}
			const history = parsed.data.history ?? [];
			if (history.reduce((n, m) => n + m.text.length, 0) > env.caseAssistantMaxHistoryChars) {
				throw new HttpError(422, "VALIDATION_ERROR", "assistant history is too long");
			}
			const checkAccess =
				deps.checkAssistantCaseAccess ??
				((id: string, user: { id: string; email: string; role: string }) =>
					checkAssistantCaseAccessOverHttp(env, id, user));
			await checkAccess(applicationId, me);
			const fetchContext =
				deps.fetchResearchContext ?? ((id: string) => fetchResearchContextOverHttp(env, id));
			const { caseFacts, contextAnalysisConsent } = await fetchContext(applicationId);
			if (contextAnalysisConsent !== true) {
				throw new HttpError(
					403,
					"CONTEXT_CONSENT_REQUIRED",
					"context analysis consent is required",
				);
			}
			const submittedAt = caseFacts["submittedAt"];
			if (typeof submittedAt !== "string" || submittedAt.length < 10) {
				throw new HttpError(502, "CASE_ASSISTANT_FAILED", "case facts are unavailable");
			}
			// One abort path: the inbound disconnect plus the run timeout.
			const timeoutSignal = AbortSignal.timeout(env.caseAssistantTimeoutMs);
			const inbound = c.req.raw.signal;
			const signal =
				typeof AbortSignal.any === "function" && inbound
					? AbortSignal.any([inbound, timeoutSignal])
					: timeoutSignal;
			const assistant = deps.caseAssistant ?? unavailableCaseAssistantRunner;
			const run = async (
				onToolEvent?: (event: CaseAssistantToolEvent) => void,
			): Promise<CaseAssistantOutput> =>
				assistant.run({
					applicationId,
					caseFacts,
					asOfDate: submittedAt.slice(0, 10),
					question: parsed.data.question,
					history,
					actorId: me.id,
					actorRole: me.role,
					signal,
					runId: applicationId,
					onToolEvent,
				});
			const toHttpError = (err: unknown): HttpError => {
				if (!(err instanceof CaseAssistantError)) {
					logger.error({ applicationId, code: "CASE_ASSISTANT_FAILED" }, "case assistant failed");
					return new HttpError(502, "CASE_ASSISTANT_FAILED", "assistant run failed");
				}
				// Sanitized envelope only: static messages, ids, and codes —
				// never the question, answer, or tool results.
				logger.error(
					{ applicationId, code: err.code, reason: err.message },
					"case assistant failed",
				);
				switch (err.code) {
					case "UNSAFE_OUTPUT":
					case "INVALID_OUTPUT":
						return new HttpError(422, err.code, "assistant output failed validation");
					case "CASE_ASSISTANT_TIMEOUT":
						return new HttpError(504, err.code, "assistant run timed out");
					case "CASE_ASSISTANT_UNAVAILABLE":
						return new HttpError(503, err.code, "assistant model is unavailable");
					default:
						return new HttpError(502, err.code, "assistant run failed");
				}
			};

			// Opt-in SSE: tool progress arrives while the loop runs, then one
			// answer event. Errors after the stream opens are typed events.
			if ((c.req.header("accept") ?? "").includes("text/event-stream")) {
				const encoder = new TextEncoder();
				const stream = new ReadableStream<Uint8Array>({
					async start(controller) {
						const send = (event: unknown): void => {
							try {
								controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
							} catch {
								// Client disconnected; the run signal aborts it too.
							}
						};
						try {
							const out = await run((tool) => send({ type: "tool", ...tool }));
							send({ type: "answer", answer: out, latencyMs: Date.now() - startedAt });
						} catch (err) {
							const mapped = toHttpError(err);
							send({
								type: "error",
								status: mapped.status,
								code: mapped.code,
								message: mapped.message,
							});
						} finally {
							try {
								controller.close();
							} catch {
								// already closed/errored by the client
							}
						}
					},
				});
				return c.body(stream, 200, {
					"content-type": "text/event-stream; charset=utf-8",
					"cache-control": "no-cache, no-transform",
					connection: "keep-alive",
					"x-accel-buffering": "no",
				});
			}

			try {
				const out = await run();
				return c.json({ ...out, latencyMs: Date.now() - startedAt });
			} catch (err) {
				throw toHttpError(err);
			}
		},
	);

	return app;
}
