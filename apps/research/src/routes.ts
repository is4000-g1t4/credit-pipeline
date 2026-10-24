// Internal research API (signed). Run/finding routes are officer-only and
// case-scoped (T00 access grants); access grant/revoke routes are
// service-only. All run/finding routes verify the run belongs to
// `:applicationId`; mismatch is 404.
// Wave 3 (review routes/UI) is out of scope — this file serves review only.
import {
	agentEvidence,
	agentFindingReviews,
	agentFindings,
	agentRuns,
	agentRunViews,
	contextSignalReviews,
	contextSignals,
	findingEvidence,
	withTx,
	type Db,
} from "@credit/db/research";
import {
	HttpError,
	readJson,
	requireOfficer,
	requireService,
	zodFields,
	type Logger,
	type ServiceApp,
} from "@credit/service-kit";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
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
	revokeResearchAccess,
	type AccessRole,
} from "./access.js";
import type { AgentRunner } from "./agent.js";
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
import { contextConsentProbe, executeContextRetry, executeRun } from "./run.js";
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
}

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

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
			const run = await getRun(db, finding.runId);
			if (!run || run.applicationId !== applicationId) {
				throw new HttpError(404, "NOT_FOUND", "not found");
			}
			await requireResearchAccess(db, applicationId, me.id, me.role);
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
			const run = await getRun(db, signal.runId);
			if (!run || run.applicationId !== applicationId) {
				throw new HttpError(404, "NOT_FOUND", "not found");
			}
			await requireResearchAccess(db, applicationId, me.id, me.role);
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

	return app;
}

interface AggregateFinding {
	id: string;
	claim: string;
	category: string;
	whyItMatters: string;
	allegationStatus: string;
	support: string;
	confidence: string;
	confidenceBasis: unknown;
	entityMatch: unknown;
	evidenceIds: string[];
	evidence: AggregateEvidence[];
	reviewStatus: string;
	reviewedAt: string | null;
}

interface AggregateEvidence {
	id: string;
	url: string;
	finalUrl: string;
	title: string | null;
	publisher: string;
	publishedAt: string | null;
	dateBasis: string;
	retrievedAt: string | null;
	quote: string;
	quoteStart: number;
	quoteEnd: number;
	snapshotText: string;
	snapshotHash: string;
	rawContentSha256: string | null;
	sourceTier: string;
}

/** Single context-signal DTO: latest read and signal review share it. */
function toContextSignalDto(
	s: typeof contextSignals.$inferSelect,
	review?: { action: string; reviewedAt: string | null },
): {
	id: string;
	stageVersion: number;
	accountScope: string;
	type: string;
	periodStart: string | null;
	periodEnd: string | null;
	metric: string;
	observed: number | null;
	expected: number | null;
	confidence: string;
	status: string;
	policyVersion: string;
	explanation: string | null;
	evidence: unknown;
	reviewStatus: string;
	reviewedAt: string | null;
} {
	return {
		id: s.id,
		stageVersion: s.stageVersion,
		accountScope: s.accountScope,
		type: s.type,
		periodStart: s.periodStart,
		periodEnd: s.periodEnd,
		metric: s.metric,
		observed: s.observed === null ? null : Number(s.observed),
		expected: s.expected === null ? null : Number(s.expected),
		confidence: s.confidence,
		status: s.status,
		policyVersion: s.policyVersion,
		explanation: s.explanation,
		evidence: s.evidence,
		reviewStatus: review?.action ?? "pending",
		reviewedAt: review?.reviewedAt ?? null,
	};
}
/** Single evidence DTO: top-level and per-finding share it. */
function toEvidenceDto(e: typeof agentEvidence.$inferSelect): AggregateEvidence {
	return {
		id: e.id,
		url: e.url,
		finalUrl: e.finalUrl,
		title: e.title,
		publisher: e.publisher,
		publishedAt: e.publishedAt,
		dateBasis: e.dateBasis,
		retrievedAt: iso(e.retrievedAt),
		quote: e.quote,
		quoteStart: e.quoteStart,
		quoteEnd: e.quoteEnd,
		snapshotText: e.snapshotText,
		snapshotHash: e.snapshotHash,
		rawContentSha256: e.rawContentSha256,
		sourceTier: e.sourceTier,
	};
}

async function aggregateRun(
	db: Db,
	run: RunRow,
	officerId: string,
	opts: { includeContext?: boolean; includePolicy?: boolean } = {},
): Promise<{
	run: Record<string, unknown>;
	brief: unknown;
	validation: unknown;
	usage: unknown;
	evidence: AggregateEvidence[];
	findings: AggregateFinding[];
	context: {
		status: string;
		stageVersion: number;
		errorCode: string | null;
		model: string | null;
		brief: unknown;
		validation: unknown;
		usage: unknown;
		startedAt: string | null;
		finishedAt: string | null;
		signals: Array<ReturnType<typeof toContextSignalDto>>;
	};
	policy: {
		status: string;
		errorCode: string | null;
		model: string | null;
		promptVersion: string | null;
		brief: unknown;
		validation: unknown;
		usage: unknown;
		startedAt: string | null;
		finishedAt: string | null;
	};
	viewedAt: string | null;
}> {
	const [evidenceRows, findingRows, linkRows, reviewRows, viewRows, signalRows, signalReviewRows] =
		await Promise.all([
			db.select().from(agentEvidence).where(eq(agentEvidence.runId, run.id)),
			db.select().from(agentFindings).where(eq(agentFindings.runId, run.id)),
			db
				.select()
				.from(findingEvidence)
				.where(sql`finding_id IN (SELECT id FROM agent_findings WHERE run_id = ${run.id})`),
			db
				.select()
				.from(agentFindingReviews)
				.where(eq(agentFindingReviews.runId, run.id))
				.orderBy(desc(agentFindingReviews.createdAt)),
			db
				.select({ viewedAt: agentRunViews.viewedAt })
				.from(agentRunViews)
				.where(and(eq(agentRunViews.runId, run.id), eq(agentRunViews.officerId, officerId)))
				.orderBy(desc(agentRunViews.viewedAt))
				.limit(1),
			// T18: reads return only the live stage version (`superseded_at IS
			// NULL`); superseded rows stay historical. A terminal failed run
			// still exposes its stored context here.
			db
				.select()
				.from(contextSignals)
				.where(and(eq(contextSignals.runId, run.id), sql`${contextSignals.supersededAt} IS NULL`)),
			db
				.select()
				.from(contextSignalReviews)
				.where(eq(contextSignalReviews.runId, run.id))
				.orderBy(desc(contextSignalReviews.createdAt)),
		]);
	const evidenceById = new Map(evidenceRows.map((e) => [e.id, e]));
	const findingEvidenceIds = new Map<string, string[]>();
	for (const link of linkRows) {
		const list = findingEvidenceIds.get(link.findingId) ?? [];
		list.push(link.evidenceId);
		findingEvidenceIds.set(link.findingId, list);
	}
	const latestReview = new Map<string, { action: string; createdAt: Date }>();
	for (const review of reviewRows) {
		if (!latestReview.has(review.findingId)) {
			latestReview.set(review.findingId, { action: review.action, createdAt: review.createdAt });
		}
	}
	// Append-only signal reviews: latest action per live signal (badges in
	// the UI); history stays in the table and audit log.
	const latestSignalReview = new Map<string, { action: string; reviewedAt: string }>();
	for (const review of signalReviewRows) {
		if (!latestSignalReview.has(review.signalId)) {
			latestSignalReview.set(review.signalId, {
				action: review.action,
				reviewedAt: review.createdAt.toISOString(),
			});
		}
	}
	// Withdrawn consent omits stored context at read time (the caller
	// audits context.denied): status/version stay visible as metadata, but
	// no brief, usage, or signal content leaves the service.
	const includeContext = opts.includeContext ?? true;
	const includePolicy = opts.includePolicy ?? true;
	return {
		run: summarizeRun(run),
		brief: run.brief,
		validation: run.validation,
		usage: run.usage,
		evidence: evidenceRows.map(toEvidenceDto),
		findings: findingRows.map((f) => {
			const evidenceIds = findingEvidenceIds.get(f.id) ?? [];
			const review = latestReview.get(f.id);
			return {
				id: f.id,
				claim: f.claim,
				category: f.category,
				whyItMatters: f.whyItMatters,
				allegationStatus: f.allegationStatus,
				support: f.support,
				confidence: f.confidence,
				confidenceBasis: f.confidenceBasis,
				entityMatch: f.entityMatch,
				evidenceIds,
				evidence: evidenceIds.flatMap((id) => {
					const e = evidenceById.get(id);
					return e ? [toEvidenceDto(e)] : [];
				}),
				reviewStatus: review?.action ?? "pending",
				reviewedAt: review ? review.createdAt.toISOString() : null,
			};
		}),
		context: {
			status: run.contextStatus,
			stageVersion: run.contextStageVersion,
			errorCode: run.contextErrorCode,
			model: run.contextModel,
			brief: includeContext ? run.contextBrief : null,
			validation: includeContext ? run.contextValidation : null,
			usage: includeContext ? run.contextUsage : null,
			startedAt: iso(run.contextStartedAt),
			finishedAt: iso(run.contextFinishedAt),
			signals: includeContext
				? signalRows.map((s) => toContextSignalDto(s, latestSignalReview.get(s.id)))
				: [],
		},
		policy: {
			status: run.policyStatus,
			errorCode: run.policyErrorCode,
			model: run.policyModel,
			promptVersion: run.policyPromptVersion,
			brief: includePolicy ? run.policyBrief : null,
			validation: includePolicy ? run.policyValidation : null,
			usage: includePolicy ? run.policyUsage : null,
			startedAt: iso(run.policyStartedAt),
			finishedAt: iso(run.policyFinishedAt),
		},
		viewedAt: viewRows[0] ? viewRows[0].viewedAt.toISOString() : null,
	};
}
