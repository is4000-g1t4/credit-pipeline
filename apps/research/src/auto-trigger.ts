// T11 auto-trigger: a Kafka consumer on `credit.review.requested` ensures
// at most one `trigger=auto` run per referral generation. The handler runs
// under a dedicated service/automation principal (never a minted officer
// identity). Kafka itself carries no per-envelope auth (plaintext broker):
// the consumer only reads the allowlisted topic, drops malformed envelopes
// (skip + commit, never retried — there is no DLQ table), and re-validates
// consent/status over service-HMAC context before any paid work. Production
// Kafka must use SASL/ACL or a private network. No model fallback: auto
// runs use the same agent/validator.
//
// Idempotency is durable: every outcome lands in `research_auto_events`
// (unique per application + envelope id), checked BEFORE the context
// fetch/caps. A redelivered event returns the stored outcome — even after
// a status/consent change — with zero new paid runs. Permanent skips are
// audited as `auto.skip` and committed; transient errors throw so Kafka
// redelivers.
import { caseFactsSchema, eventEnvelopeSchema, TOPICS, type EventEnvelope } from "@credit/core";
import { agentRuns, researchAutoEvents, withTx, type Db, type Tx } from "@credit/db/research";
import { signInternalHeaders, type Logger } from "@credit/service-kit";
import { and, eq, sql } from "drizzle-orm";
import { Kafka } from "kafkajs";
import { auditResearch } from "./access.js";
import type { AgentRunner } from "./agent.js";
import type { ContextAgentRunner } from "./context-agent.js";
import type { ResearchEnv } from "./env.js";
import { isUuid } from "./ids.js";
import {
	ensureRunTx,
	reapStaleRuns,
	resumeQueuedRuns,
	type CaseFactsPayload,
} from "./lifecycle.js";
import type { Observability } from "./observability.js";
import { executeRun, type ExecDeps } from "./run.js";
import type { LanguageRepair } from "./repair.js";
import type { PolicyRunner } from "./policy-stage.js";
import type { SupportJudge } from "./support.js";

export const AUTO_TRIGGER_GROUP_ID = "credit-research-auto";

export interface AutoTriggerDeps {
	db: Db;
	env: ResearchEnv;
	logger: Logger;
	runner: AgentRunner;
	judge: SupportJudge;
	repair: LanguageRepair;
	observability: Observability;
	/** Optional: absent fails the context stage closed (never the external brief). */
	contextRunner?: ContextAgentRunner;
	/** T03/T04 automatic case policy review; absent fails the policy stage only. */
	policyRunner?: PolicyRunner;
	/** Test seam: fake applications context; default fetches over HMAC. */
	fetchResearchContext?: (applicationId: string) => Promise<ResearchContextResult>;
	/** Test seam: fresh context-consent probe; default reads research-context over HMAC. */
	fetchContextConsent?: (applicationId: string) => Promise<boolean>;
}

export type ResearchContextResult =
	| { ok: true; caseFacts: CaseFactsPayload; applicantUserId: string; contextConsent: boolean }
	| { ok: false; status: number };

export type AutoOutcome =
	| { handled: "ensured"; runId: string }
	| { handled: "duplicate"; runId: string }
	| { handled: "skipped"; reason: string };

/** Health/connection state for /health (informational, never readiness). */
let autoTriggerConnected = false;
let autoTriggerSeenEnabled = false;

export function getAutoTriggerStatus(): { enabled: boolean; connected: boolean } {
	return { enabled: autoTriggerSeenEnabled, connected: autoTriggerConnected };
}

/**
 * Service-HMAC fetch of the allowlisted research context. 4xx (except
 * 408/429) and malformed shapes are permanent — the caller audits a skip,
 * so poison envelopes never redeliver forever. 408 (deadline), 429
 * (rate-limited), 5xx, and transport/timeout errors throw (transient,
 * Kafka redelivers). Signs the dedicated service principal, never an
 * officer.
 */
export function fetchResearchContextOverHttp(
	env: ResearchEnv,
	applicationId: string,
): Promise<ResearchContextResult> {
	const path = `/internal/applications/${applicationId}/research-context`;
	const headers = signInternalHeaders(env.internalSecret, {
		userId: env.autoTriggerServiceUserId,
		role: "service",
		email: env.autoTriggerServiceEmail,
		method: "GET",
		path,
	});
	return (async () => {
		let res: Response;
		try {
			// Bounded: a hung applications service must not stall the
			// partition. Abort → transport error → transient redelivery.
			res = await fetch(`${env.applicationsUrl}${path}`, {
				headers,
				signal: AbortSignal.timeout(10_000),
			});
		} catch (err) {
			throw new Error(
				`research-context unreachable: ${err instanceof Error ? err.message : String(err)}`,
				{ cause: err },
			);
		}
		if (res.status === 408 || res.status === 429) {
			throw new Error(`research-context returned ${res.status}`);
		}
		if (res.status >= 400 && res.status < 500) return { ok: false as const, status: res.status };
		if (!res.ok) throw new Error(`research-context returned ${res.status}`);
		let body: { caseFacts?: unknown; applicantUserId?: unknown; contextAnalysisConsent?: unknown };
		try {
			body = (await res.json()) as {
				caseFacts?: unknown;
				applicantUserId?: unknown;
				contextAnalysisConsent?: unknown;
			};
		} catch {
			return { ok: false as const, status: 422 };
		}
		const facts = caseFactsSchema.safeParse(body.caseFacts);
		if (!facts.success || typeof body.applicantUserId !== "string") {
			return { ok: false as const, status: 422 };
		}
		// Context consent rides beside (never inside) the strict case facts;
		// absent fails closed to false — the stage skips, external unaffected.
		return {
			ok: true as const,
			caseFacts: facts.data,
			applicantUserId: body.applicantUserId,
			contextConsent: body.contextAnalysisConsent === true,
		};
	})();
}

/** UTC calendar-day start (timestamptz) shared by the auto cap queries. */
const UTC_DAY_START = sql`date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;

/**
 * Daily run/cost guards, all UTC-calendar-day scoped and auto-only
 * (`trigger='auto'` — officer runs never consume the automation budget).
 * In-flight (queued/running) auto runs reserve
 * `AGENT_MAX_COST_USD + CONTEXT_AGENT_MAX_COST_USD + POLICY_CASE_MAX_COST_USD`
 * each against the cost
 * budget, as does a claimed retry stage on a terminal run (terminal +
 * context running with a live stage token) — regardless of the run's
 * `created_at`, so a prior-day run retried today still reserves. Retry spend
 * merges into the single `usage` ledger (counted by the `created_at` spend
 * query for same-day runs); a prior-day run retried today additionally
 * counts its `context_usage` by `context_started_at`, so today's retry spend
 * is never free and never double-counted. Returns the first exhausted
 * guard's machine-readable reason (audited, never PII).
 */
export async function checkAutoCaps(
	db: Db | Tx,
	env: ResearchEnv,
	applicantUserId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const perApplicant = (await db.execute(
		sql`SELECT count(*)::int AS n FROM agent_runs WHERE applicant_user_id = ${applicantUserId} AND trigger = 'auto' AND created_at >= ${UTC_DAY_START}`,
	)) as unknown as Array<{ n: number }>;
	if ((perApplicant[0]?.n ?? 0) >= env.autoTriggerMaxRunsPerApplicantDay) {
		return { ok: false, reason: "applicant_daily_cap" };
	}
	const total = (await db.execute(
		sql`SELECT count(*)::int AS n FROM agent_runs WHERE trigger = 'auto' AND created_at >= ${UTC_DAY_START}`,
	)) as unknown as Array<{ n: number }>;
	if ((total[0]?.n ?? 0) >= env.autoTriggerMaxRunsPerDay) {
		return { ok: false, reason: "global_daily_cap" };
	}
	// Non-numeric costs (never server-written) count as 0, never as poison.
	const cost = (await db.execute(
		sql`SELECT coalesce(sum(CASE WHEN usage->>'costUsd' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (usage->>'costUsd')::double precision ELSE 0 END), 0)::float8 AS total FROM agent_runs WHERE trigger = 'auto' AND created_at >= ${UTC_DAY_START}`,
	)) as unknown as Array<{ total: number }>;
	// Retry spend on prior-day runs: the merged `usage` ledger above is
	// keyed by `created_at`, so a yesterday run retried today would read as
	// free. Count its `context_usage` by `context_started_at` instead — the
	// `created_at < day` guard keeps same-day runs (already counted via
	// `usage`) from double-counting.
	const retryCost = (await db.execute(
		sql`SELECT coalesce(sum(CASE WHEN context_usage->>'costUsd' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (context_usage->>'costUsd')::double precision ELSE 0 END), 0)::float8 AS total FROM agent_runs WHERE trigger = 'auto' AND context_started_at >= ${UTC_DAY_START} AND created_at < ${UTC_DAY_START}`,
	)) as unknown as Array<{ total: number }>;
	// Policy spend on prior-day runs is not in the merged usage ledger
	// (keyed by created_at); count policy_usage by policy_started_at.
	const policyRetryCost = (await db.execute(
		sql`SELECT coalesce(sum(CASE WHEN policy_usage->>'costUsd' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (policy_usage->>'costUsd')::double precision ELSE 0 END), 0)::float8 AS total FROM agent_runs WHERE trigger = 'auto' AND policy_started_at >= ${UTC_DAY_START} AND created_at < ${UTC_DAY_START}`,
	)) as unknown as Array<{ total: number }>;
	const inFlight = (await db.execute(
		sql`SELECT count(*)::int AS n FROM agent_runs WHERE trigger = 'auto' AND ((created_at >= ${UTC_DAY_START} AND status IN ('queued', 'running')) OR (context_status = 'running' AND context_stage_token IS NOT NULL) OR (policy_status = 'running' AND policy_timeout_at IS NOT NULL))`,
	)) as unknown as Array<{ n: number }>;
	const spent =
		(cost[0]?.total ?? 0) +
		(retryCost[0]?.total ?? 0) +
		(policyRetryCost[0]?.total ?? 0) +
		(inFlight[0]?.n ?? 0) *
			(env.maxCostUsd +
				env.contextMaxCostUsd +
				(env.policyAssistEnabled ? env.policyCaseMaxCostUsd : 0));
	if (spent >= env.autoTriggerDailyCostBudgetUsd) {
		return { ok: false, reason: "daily_cost_budget" };
	}
	return { ok: true };
}

async function auditAuto(
	db: Db | Tx,
	env: ResearchEnv,
	applicationId: string,
	runId: string | null,
	action: "auto.ensure" | "auto.duplicate" | "auto.skip",
	metadata: Record<string, unknown>,
): Promise<void> {
	await auditResearch(db, {
		applicationId,
		runId,
		actorId: env.autoTriggerServiceUserId,
		actorRole: "service",
		action,
		metadata,
	});
}

type AutoEventRow = typeof researchAutoEvents.$inferSelect;

/** Shared `auto.duplicate` audit: the stored outcome rules on redelivery. */
async function auditDuplicate(
	tx: Tx,
	env: ResearchEnv,
	applicationId: string,
	triggerEventId: string,
	row: AutoEventRow,
): Promise<void> {
	await auditAuto(tx, env, applicationId, row.runId, "auto.duplicate", {
		triggerEventId,
		originalOutcome: row.outcome,
		...(row.reason ? { reason: row.reason } : {}),
	});
}

async function findAutoEvent(
	db: Db | Tx,
	applicationId: string,
	triggerEventId: string,
): Promise<AutoEventRow | null> {
	const rows = await db
		.select()
		.from(researchAutoEvents)
		.where(
			and(
				eq(researchAutoEvents.applicationId, applicationId),
				eq(researchAutoEvents.triggerEventId, triggerEventId),
			),
		)
		.limit(1);
	return rows[0] ?? null;
}

/**
 * Persist one outcome row; a concurrent first delivery that committed
 * first wins (ON CONFLICT DO NOTHING → return the winner). The caller
 * maps the returned row — never its own intent — so losers converge on
 * the winner's outcome with zero extra paid runs.
 */
async function recordAutoEvent(
	tx: Tx,
	applicationId: string,
	triggerEventId: string,
	outcome: "ensured" | "duplicate" | "skipped",
	runId: string | null,
	reason: string | null,
): Promise<AutoEventRow> {
	const [row] = await tx
		.insert(researchAutoEvents)
		.values({ applicationId, triggerEventId, outcome, runId, reason })
		.onConflictDoNothing()
		.returning();
	if (row) return row;
	const winner = await findAutoEvent(tx, applicationId, triggerEventId);
	if (!winner) throw new Error("auto event lost after conflict");
	return winner;
}

/** Map a stored event row back to its outcome (redeliveries converge here). */
function storedOutcome(row: AutoEventRow): AutoOutcome {
	if (row.outcome === "skipped") return { handled: "skipped", reason: row.reason ?? "unknown" };
	return { handled: "duplicate", runId: row.runId as string };
}

/**
 * One referral event → at most one auto run. The durable event log is
 * checked BEFORE the context fetch/caps, so a redelivered event returns
 * the original outcome — even after a status/consent change — with zero
 * new paid calls. Throws on transient failures (context fetch, DB) so
 * Kafka redelivers; every permanent outcome is recorded + audited.
 */
export async function handleReviewRequested(
	deps: AutoTriggerDeps,
	envelope: Extract<EventEnvelope, { type: "review.requested" }>,
): Promise<AutoOutcome> {
	const { db, env, logger } = deps;
	const applicationId =
		typeof envelope.payload === "object" && envelope.payload !== null
			? String((envelope.payload as { applicationId?: unknown }).applicationId ?? "")
			: "";
	if (!isUuid(applicationId)) {
		// Un-auditable (the audit row keys on a uuid application id): log
		// ids only and commit.
		logger.warn({ eventId: envelope.id }, "auto-trigger: invalid application id, skipping");
		return { handled: "skipped", reason: "invalid_application_id" };
	}
	// Redelivery fast-path: the stored outcome rules, before any
	// context fetch or cap check. The duplicate audit commits in the same
	// transaction as the re-read, so a transient audit failure redelivers
	// instead of leaving the outcome unaudited.
	const prior = await withTx(db, async (tx) => {
		const row = await findAutoEvent(tx, applicationId, envelope.id);
		if (!row) return null;
		await auditDuplicate(tx, env, applicationId, envelope.id, row);
		return row;
	});
	if (prior) return storedOutcome(prior);
	// AGENTS_ENABLED=false gates the auto LLM path: permanent audited skip,
	// no run, no paid calls.
	if (!env.agentsEnabled) {
		return skipAndRecord(deps, applicationId, envelope.id, "agents_disabled");
	}
	const fetchContext =
		deps.fetchResearchContext ?? ((id: string) => fetchResearchContextOverHttp(env, id));
	const ctx = await fetchContext(applicationId);
	if (!ctx.ok) {
		return skipAndRecord(
			deps,
			applicationId,
			envelope.id,
			ctx.status === 404 ? "application_not_found" : "context_invalid",
		);
	}
	const { caseFacts, applicantUserId } = ctx;
	if (caseFacts.applicationId !== applicationId) {
		return skipAndRecord(deps, applicationId, envelope.id, "context_mismatch");
	}
	if (!isUuid(applicantUserId)) {
		return skipAndRecord(deps, applicationId, envelope.id, "invalid_applicant");
	}
	if (!caseFacts.aiResearchConsent) {
		return skipAndRecord(deps, applicationId, envelope.id, "consent_required");
	}
	if (caseFacts.status !== "pending_review") {
		return skipAndRecord(deps, applicationId, envelope.id, "not_pending");
	}
	// Caps + ensure + event record + audit commit atomically under one
	// global advisory lock: the cap SELECTs run after the lock is held, so
	// a concurrent referral that committed first is always visible and two
	// events cannot jointly overshoot a cap. (The lock is global because
	// the global/day and cost guards are.) Every audit below commits in
	// the same transaction as its outcome: a transient audit failure rolls
	// the outcome back and Kafka redelivers, instead of leaving an outcome
	// without an audit.
	const decided = await withTx(db, async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('research-auto-caps'))`);
		// A concurrent first delivery may have committed while this call
		// was fetching context: re-check under the lock.
		const raced = await findAutoEvent(tx, applicationId, envelope.id);
		if (raced) {
			await auditDuplicate(tx, env, applicationId, envelope.id, raced);
			return { outcome: storedOutcome(raced), exec: null };
		}
		const caps = await checkAutoCaps(tx, env, applicantUserId);
		if (!caps.ok) {
			const stored = await recordAutoEvent(
				tx,
				applicationId,
				envelope.id,
				"skipped",
				null,
				caps.reason,
			);
			if (stored.outcome !== "skipped" || stored.reason !== caps.reason) {
				// Lost the event race between re-check and insert (only a
				// path outside this lock could interleave — none remains):
				// the winner's outcome rules.
				await auditDuplicate(tx, env, applicationId, envelope.id, stored);
				return { outcome: storedOutcome(stored), exec: null };
			}
			await auditAuto(tx, env, applicationId, null, "auto.skip", {
				triggerEventId: envelope.id,
				reason: caps.reason,
			});
			return { outcome: storedOutcome(stored), exec: null };
		}
		const { run, inserted } = await ensureRunTx(tx, env, {
			applicationId,
			requestedBy: env.autoTriggerServiceUserId,
			requestedByRole: "service",
			trigger: "auto",
			triggerEventId: envelope.id,
			applicantUserId,
			caseFacts,
			aiResearchConsent: caseFacts.aiResearchConsent,
		});
		// `inserted: false` covers both a same-event redelivery that raced
		// past the fast-path and an officer run that absorbed this referral
		// (active-run reuse): either way no new paid work, outcome duplicate.
		const stored = await recordAutoEvent(
			tx,
			applicationId,
			envelope.id,
			inserted ? "ensured" : "duplicate",
			run.id,
			null,
		);
		// Event-race loss after inserting: the winner's outcome rules, and
		// this call starts no execution. A just-inserted orphan is deleted
		// in this same transaction, so a losing skip never leaves an
		// executable paid run behind.
		if (!inserted || stored.outcome !== "ensured" || stored.runId !== run.id) {
			if (inserted) {
				await tx.delete(agentRuns).where(eq(agentRuns.id, run.id));
			}
			await auditDuplicate(tx, env, applicationId, envelope.id, stored);
			return { outcome: storedOutcome(stored), exec: null };
		}
		await auditAuto(tx, env, applicationId, run.id, "auto.ensure", {
			triggerEventId: envelope.id,
		});
		return {
			outcome: { handled: "ensured", runId: run.id } as AutoOutcome,
			exec: run.runToken ? { runId: run.id, token: run.runToken } : null,
		};
	});
	if (decided.exec) {
		// Exactly one background execution, only when this call inserted —
		// the same fire-and-forget shape as the officer route. executeRun
		// finalizes every failure path itself; the wrapper only guards
		// against an escaped rejection (sanitized: run id only).
		const { runId, token } = decided.exec;
		const exec = async (): Promise<void> => {
			try {
				await executeRun(
					{
						db,
						env,
						logger,
						runner: deps.runner,
						judge: deps.judge,
						repair: deps.repair,
						observability: deps.observability,
						contextRunner: deps.contextRunner,
						fetchContextConsent: deps.fetchContextConsent,
						policyRunner: deps.policyRunner,
					},
					runId,
					token,
				);
			} catch (err) {
				logger.error(
					{ runId, err: err instanceof Error ? err.message : String(err) },
					"auto-trigger background execution escaped",
				);
			}
		};
		void exec();
	}
	return decided.outcome;
}

/** Permanent skip: record the outcome and audit it in one transaction
 * under the same `research-auto-caps` global advisory lock as the ensure
 * path, re-checking the event under the lock first. A concurrent first
 * delivery that committed first wins (duplicate); a transient audit
 * failure rolls the outcome back so Kafka redelivers instead of leaving
 * an unaudited skip. */
async function skipAndRecord(
	deps: AutoTriggerDeps,
	applicationId: string,
	triggerEventId: string,
	reason: string,
): Promise<AutoOutcome> {
	const { db, env } = deps;
	const stored = await withTx(db, async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('research-auto-caps'))`);
		const raced = await findAutoEvent(tx, applicationId, triggerEventId);
		if (raced) {
			await auditDuplicate(tx, env, applicationId, triggerEventId, raced);
			return raced;
		}
		const row = await recordAutoEvent(tx, applicationId, triggerEventId, "skipped", null, reason);
		if (row.outcome !== "skipped" || row.reason !== reason) {
			await auditDuplicate(tx, env, applicationId, triggerEventId, row);
			return row;
		}
		await auditAuto(tx, env, applicationId, null, "auto.skip", {
			triggerEventId,
			reason,
		});
		return row;
	});
	if (stored.outcome !== "skipped" || stored.reason !== reason) return storedOutcome(stored);
	return { handled: "skipped", reason };
}

/**
 * T11 queued-run recovery: start every run that was committed but never
 * claimed (crash between insert and execution). Fire-and-forget per run —
 * the token-conditional claim makes concurrent starts safe; the reaper
 * stays the fallback. Returns the started run ids.
 */
export async function recoverQueuedRuns(deps: ExecDeps): Promise<string[]> {
	const pending = await resumeQueuedRuns(deps.db);
	for (const p of pending) {
		const runId = p.id;
		const token = p.runToken;
		const exec = async (): Promise<void> => {
			try {
				await executeRun(deps, runId, token);
			} catch (err) {
				deps.logger.error(
					{ runId, err: err instanceof Error ? err.message : String(err) },
					"queued-run recovery execution escaped",
				);
			}
		};
		void exec();
	}
	return pending.map((p) => p.id);
}

export interface ConsumerHandle {
	stop(): Promise<void>;
	/** True once subscribed; surfaces in /health so a stalled consumer is visible. */
	isConnected(): boolean;
}

/**
 * Pure envelope gate for the consumer: malformed JSON, a schema failure,
 * or a misrouted type is a skip (commit the offset, never stall the
 * partition — no DLQ table in this DB). Only a well-formed
 * `review.requested` envelope is processed. Unit-tested: an
 * unsigned/malformed event is skipped, not retried.
 */
export function classifyAutoMessage(
	raw: string,
):
	| { kind: "process"; envelope: Extract<EventEnvelope, { type: "review.requested" }> }
	| { kind: "skip" } {
	let parsed: unknown = null;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { kind: "skip" };
	}
	const result = eventEnvelopeSchema.safeParse(parsed);
	if (!result.success || result.data.type !== "review.requested") return { kind: "skip" };
	return { kind: "process", envelope: result.data };
}

/**
 * Boot/crash recovery ordering: queued-run recovery FIRST (start runs
 * that were committed but never claimed), the stale-run reaper SECOND.
 * Reversed, a crash-left queued run whose timeout already passed would be
 * failed by the reaper before recovery could start it.
 */
export async function bootRecovery(
	deps: ExecDeps,
): Promise<{ recovered: string[]; reaped: string[] }> {
	const recovered = await recoverQueuedRuns(deps);
	const reaped = await reapStaleRuns(deps.db);
	return { recovered, reaped };
}

/**
 * Starts the auto-trigger consumer; resolves with the handle once the
 * background connect loop is kicked off (never rejects on Kafka outage —
 * it logs and retries, so the service starts cleanly while Kafka is
 * briefly down). The caller must check `env.autoTriggerEnabled` first:
 * when the flag is off this must not be called at all.
 */
export async function startAutoTrigger(
	deps: AutoTriggerDeps,
	opts: { brokers?: string[]; groupId?: string } = {},
): Promise<ConsumerHandle> {
	autoTriggerSeenEnabled = true;
	const brokers =
		opts.brokers ??
		deps.env.kafkaBrokers
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	const kafka = new Kafka({ clientId: "credit-research-auto", brokers });
	const consumer = kafka.consumer({ groupId: opts.groupId ?? AUTO_TRIGGER_GROUP_ID });
	let stopped = false;
	autoTriggerConnected = false;

	void (async () => {
		for (;;) {
			if (stopped) return;
			try {
				await consumer.connect();
				await consumer.subscribe({
					topic: TOPICS["review.requested"],
					fromBeginning: deps.env.autoTriggerFromBeginning,
				});
				autoTriggerConnected = true;
				await consumer.run({
					autoCommit: false,
					eachBatchAutoResolve: false,
					eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary }) => {
						for (const message of batch.messages) {
							const raw = message.value?.toString() ?? "";
							const classified = classifyAutoMessage(raw);
							if (classified.kind === "skip") {
								deps.logger.warn("auto-trigger: invalid JSON, skipping");
								resolveOffset(message.offset);
								continue;
							}
							// Transient failures throw → unresolved → redelivered.
							// Every permanent outcome is recorded + audited inside.
							await handleReviewRequested(deps, classified.envelope);
							resolveOffset(message.offset);
							await heartbeat();
						}
						await commitOffsetsIfNecessary();
					},
				});
				return;
			} catch (err) {
				autoTriggerConnected = false;
				if (stopped) return;
				deps.logger.error(
					{ err: err instanceof Error ? err.message : String(err) },
					"auto-trigger consumer: kafka error, retrying",
				);
				await new Promise((r) => setTimeout(r, 1000));
			}
		}
	})();

	return {
		stop: async () => {
			stopped = true;
			autoTriggerConnected = false;
			try {
				await consumer.disconnect();
			} catch (err) {
				deps.logger.error(
					{ err: err instanceof Error ? err.message : String(err) },
					"auto-trigger consumer: disconnect failed",
				);
			}
		},
		isConnected: () => autoTriggerConnected && !stopped,
	};
}
