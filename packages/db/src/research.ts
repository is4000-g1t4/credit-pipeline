// @credit/db/research — credit_research only. Agent runs, evidence snapshots,
// findings, append-only reviews, and explicit panel views.
import { sql } from "drizzle-orm";
import {
	date,
	check,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

export { createDb, withTx, type Db, type Tx } from "./client.js";

const createdAt = () =>
	timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull();

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const agentRunStatus = pgEnum("agent_run_status", [
	"queued",
	"running",
	"succeeded",
	"failed",
]);
export const agentTrigger = pgEnum("agent_trigger", ["officer", "auto"]);
// T11: who requested the run. Auto runs are requested by the service
// principal, never a minted officer identity.
export const agentRequestedByRole = pgEnum("agent_requested_by_role", ["officer", "service"]);
export const agentObservability = pgEnum("agent_observability", ["ok", "degraded"]);
export const agentErrorCode = pgEnum("agent_error_code", [
	"model_unavailable",
	"tool_error",
	"timeout",
	"validation_failed",
	"config_error",
	"internal_error",
	"case_facts_incomplete",
]);
export const evidenceSourceTier = pgEnum("evidence_source_tier", [
	"official",
	"registry",
	"reputable_news",
	"review_platform",
	"other",
]);
export const evidenceDateBasis = pgEnum("evidence_date_basis", [
	"publisher_metadata",
	"tavily_estimate",
	"unknown",
]);
export const findingSupport = pgEnum("finding_support", ["verified", "unverified"]);
export const findingConfidence = pgEnum("finding_confidence", ["low", "medium", "high"]);
export const findingReviewAction = pgEnum("finding_review_action", ["accepted", "rejected"]);
// --- T18 context analyst (SPEC-t17-t18 §3.1). D0 wires schema only; the
// ContextAgentRunner/stage/retry land in D1+. ---
export const contextStatus = pgEnum("context_status", [
	"not_applicable",
	"queued",
	"running",
	"succeeded",
	"failed",
	"skipped",
]);
export const contextSignalStatus = pgEnum("context_signal_status", [
	"review",
	"needs_chase",
	"insufficient_data",
]);
// T03/T04 automatic case policy review (same run row, isolated stage).
export const policyStageStatus = pgEnum("policy_status", [
	"not_applicable",
	"running",
	"succeeded",
	"no_match",
	"needs_policy_owner",
	"budget_exceeded",
	"failed",
	"skipped",
]);
// T00 case-level authorization: which staff may see sensitive research for
// one application. Officers self-claim `assigned_officer` on first run;
// `service` grants/revokes the specialist roles. `user_id` is a plain uuid
// (cross-DB reference to credit_auth.users, never an FK).
export const researchAccessRole = pgEnum("research_access_role", [
	"assigned_officer",
	"compliance",
	"policy_owner",
	"safeguarding",
]);

export const agentRuns = pgTable(
	"agent_runs",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		applicationId: uuid("application_id").notNull(),
		feature: text("feature").notNull(),
		status: agentRunStatus("status").notNull().default("queued"),
		trigger: agentTrigger("trigger").notNull().default("officer"),
		requestedBy: uuid("requested_by").notNull(),
		requestedByRole: agentRequestedByRole("requested_by_role").notNull().default("officer"),
		// T11 auto-trigger dedupe key: the Kafka envelope id. Null for
		// officer runs; the partial unique index below guards only auto rows.
		triggerEventId: text("trigger_event_id"),
		// T11 internal cap accounting only — never sent to the prompt/trace.
		applicantUserId: uuid("applicant_user_id"),
		runToken: uuid("run_token"),
		caseFacts: jsonb("case_facts").notNull(),
		model: text("model").notNull(),
		agentVersion: text("agent_version").notNull(),
		promptVersion: text("prompt_version").notNull(),
		promptHash: text("prompt_hash").notNull(),
		asOf: timestamp("as_of", { withTimezone: true, mode: "date" }).notNull(),
		grafanaConversationId: text("grafana_conversation_id").notNull(),
		observability: agentObservability("observability").notNull().default("degraded"),
		brief: jsonb("brief"),
		validation: jsonb("validation"),
		errorCode: agentErrorCode("error_code"),
		error: text("error"),
		usage: jsonb("usage"),
		startedAt: ts("started_at"),
		finishedAt: ts("finished_at"),
		timeoutAt: ts("timeout_at").notNull(),
		heartbeatAt: ts("heartbeat_at"),
		createdAt: createdAt(),
		// T18 context stage (same run row, separate stage fields): validated
		// brief/usage detail, error code, lease/heartbeat for the reaper,
		// prompt/model provenance, and the stage token/version. Retry inserts
		// a new stage version; the token (not run status) is authoritative.
		contextStatus: contextStatus("context_status").notNull().default("not_applicable"),
		contextBrief: jsonb("context_brief"),
		contextValidation: jsonb("context_validation"),
		contextUsage: jsonb("context_usage"),
		contextErrorCode: text("context_error_code"),
		contextStartedAt: ts("context_started_at"),
		contextFinishedAt: ts("context_finished_at"),
		contextTimeoutAt: ts("context_timeout_at"),
		contextHeartbeatAt: ts("context_heartbeat_at"),
		contextPromptVersion: text("context_prompt_version"),
		contextModel: text("context_model"),
		contextStageToken: uuid("context_stage_token"),
		contextStageVersion: integer("context_stage_version").notNull().default(1),
		// T03/T04 automatic policy stage. Policy failure never changes the
		// external/context outcome; the brief is consent-gated at read time.
		policyStatus: policyStageStatus("policy_status").notNull().default("not_applicable"),
		policyBrief: jsonb("policy_brief"),
		policyValidation: jsonb("policy_validation"),
		policyUsage: jsonb("policy_usage"),
		policyErrorCode: text("policy_error_code"),
		policyModel: text("policy_model"),
		policyPromptVersion: text("policy_prompt_version"),
		policyStartedAt: ts("policy_started_at"),
		policyFinishedAt: ts("policy_finished_at"),
		policyTimeoutAt: ts("policy_timeout_at"),
		policyHeartbeatAt: ts("policy_heartbeat_at"),
		contextDocumentFindings: jsonb("context_document_findings"),
	},
	(t) => [
		uniqueIndex("agent_runs_active_application_uniq")
			.on(t.applicationId, t.feature)
			.where(sql`${t.status} in ('queued', 'running')`),
		// T11: one run per referral generation — duplicate envelopes return
		// the original run (even terminal) with zero new paid calls.
		uniqueIndex("agent_runs_trigger_event_uniq")
			.on(t.applicationId, t.trigger, t.triggerEventId)
			.where(sql`${t.triggerEventId} IS NOT NULL`),
		index("agent_runs_application_created_idx").on(t.applicationId, t.createdAt),
		index("agent_runs_status_timeout_idx").on(t.status, t.timeoutAt),
		// T11 auto-cap day queries: per-applicant/day, global/day, and
		// cost-budget/day all filter `trigger='auto'` + `created_at`.
		index("agent_runs_auto_caps_idx").on(t.trigger, t.createdAt),
		index("agent_runs_applicant_created_idx").on(t.applicantUserId, t.createdAt),
		// T18 context-stage reaper: expired queued/running stages by lease.
		index("agent_runs_context_status_timeout_idx").on(t.contextStatus, t.contextTimeoutAt),
		index("agent_runs_policy_status_timeout_idx").on(t.policyStatus, t.policyTimeoutAt),
	],
);

export const agentEvidence = pgTable(
	"agent_evidence",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		runId: uuid("run_id")
			.notNull()
			.references(() => agentRuns.id, { onDelete: "cascade" }),
		url: text("url").notNull(),
		finalUrl: text("final_url").notNull(),
		title: text("title"),
		publisher: text("publisher").notNull(),
		publishedAt: date("published_at", { mode: "string" }),
		dateBasis: evidenceDateBasis("date_basis").notNull().default("unknown"),
		retrievedAt: timestamp("retrieved_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		quote: text("quote").notNull(),
		quoteStart: integer("quote_start").notNull(),
		quoteEnd: integer("quote_end").notNull(),
		snapshotText: text("snapshot_text").notNull(),
		snapshotHash: text("snapshot_hash").notNull(),
		rawContentSha256: text("raw_content_sha256"),
		sourceTier: evidenceSourceTier("source_tier").notNull().default("other"),
		metadata: jsonb("metadata"),
	},
	(t) => [
		uniqueIndex("agent_evidence_run_url_hash_uniq").on(t.runId, t.finalUrl, t.snapshotHash),
		index("agent_evidence_run_idx").on(t.runId),
	],
);

export const agentFindings = pgTable(
	"agent_findings",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		runId: uuid("run_id")
			.notNull()
			.references(() => agentRuns.id, { onDelete: "cascade" }),
		claim: text("claim").notNull(),
		category: text("category").notNull(),
		whyItMatters: text("why_it_matters").notNull(),
		allegationStatus: text("allegation_status").notNull(),
		support: findingSupport("support").notNull().default("unverified"),
		confidence: findingConfidence("confidence").notNull().default("low"),
		confidenceBasis: jsonb("confidence_basis").notNull(),
		entityMatch: jsonb("entity_match").notNull(),
		createdAt: createdAt(),
	},
	(t) => [index("agent_findings_run_idx").on(t.runId)],
);

export const findingEvidence = pgTable(
	"finding_evidence",
	{
		findingId: uuid("finding_id")
			.notNull()
			.references(() => agentFindings.id, { onDelete: "cascade" }),
		evidenceId: uuid("evidence_id")
			.notNull()
			.references(() => agentEvidence.id, { onDelete: "cascade" }),
	},
	(t) => [primaryKey({ columns: [t.findingId, t.evidenceId] })],
);

export const agentFindingReviews = pgTable(
	"agent_finding_reviews",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		findingId: uuid("finding_id")
			.notNull()
			.references(() => agentFindings.id, { onDelete: "cascade" }),
		runId: uuid("run_id")
			.notNull()
			.references(() => agentRuns.id, { onDelete: "cascade" }),
		officerId: uuid("officer_id").notNull(),
		action: findingReviewAction("action").notNull(),
		note: text("note"),
		createdAt: createdAt(),
	},
	(t) => [index("agent_finding_reviews_finding_idx").on(t.findingId, t.createdAt)],
);

export const agentRunViews = pgTable(
	"agent_run_views",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		runId: uuid("run_id")
			.notNull()
			.references(() => agentRuns.id, { onDelete: "cascade" }),
		officerId: uuid("officer_id").notNull(),
		viewedAt: timestamp("viewed_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
		// UTC minute bucket of viewed_at; part of the dedupe unique key.
		viewedMinute: timestamp("viewed_minute", { withTimezone: true, mode: "date" }).notNull(),
	},
	(t) => [
		index("agent_run_views_run_officer_idx").on(t.runId, t.officerId, t.viewedAt),
		// Per-officer/run/minute dedupe (§4): the route inserts with
		// ON CONFLICT DO NOTHING against this bucket. A stored UTC column
		// (not a date_trunc expression — STABLE, unusable in an index).
		uniqueIndex("agent_run_views_run_officer_minute_uniq").on(t.runId, t.officerId, t.viewedMinute),
	],
);

// T11: durable auto-trigger outcome log — one row per referral
// generation `(application_id, trigger_event_id)`. Redeliveries return the
// stored outcome (even after a status/consent change) with zero new paid
// runs. `outcome` is 'ensured' | 'duplicate' | 'skipped'; `reason` carries
// the skip machine code.
export const researchAutoEvents = pgTable(
	"research_auto_events",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		applicationId: uuid("application_id").notNull(),
		triggerEventId: text("trigger_event_id").notNull(),
		outcome: text("outcome").notNull(),
		runId: uuid("run_id"),
		reason: text("reason"),
		createdAt: createdAt(),
	},
	(t) => [
		uniqueIndex("research_auto_events_application_event_uniq").on(
			t.applicationId,
			t.triggerEventId,
		),
		index("research_auto_events_application_idx").on(t.applicationId),
	],
);

// T00: one active grant per (application, user). Revocation sets
// `revoked_at` (history stays); the partial unique index guards only live
// rows. `application_id` is a plain uuid — no cross-DB FK.
export const researchAccessGrants = pgTable(
	"research_access_grants",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		applicationId: uuid("application_id").notNull(),
		userId: uuid("user_id").notNull(),
		accessRole: researchAccessRole("access_role").notNull(),
		grantedBy: uuid("granted_by").notNull(),
		grantedAt: timestamp("granted_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
		revokedAt: ts("revoked_at"),
	},
	(t) => [
		uniqueIndex("research_access_grants_active_application_user_uniq")
			.on(t.applicationId, t.userId)
			.where(sql`${t.revokedAt} IS NULL`),
		index("research_access_grants_application_idx").on(t.applicationId),
	],
);

// T00: append-only security audit — every sensitive-research read/write and
// every grant/revoke/claim/denial. No update/delete path exists in code;
// `metadata` carries ids and codes only, never PII. `run_id` is nullable
// (access actions have no run) and intentionally FK-free so history survives
// run cleanup.
export const researchAuditLog = pgTable(
	"research_audit_log",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		applicationId: uuid("application_id").notNull(),
		runId: uuid("run_id"),
		actorId: uuid("actor_id").notNull(),
		actorRole: text("actor_role").notNull(),
		action: text("action").notNull(),
		metadata: jsonb("metadata"),
		createdAt: createdAt(),
	},
	(t) => [
		index("research_audit_log_application_time_idx").on(t.applicationId, t.createdAt),
		index("research_audit_log_run_idx").on(t.runId),
	],
);

// T18 context signals: deterministic candidate snapshots selected by the
// model. Retries insert a new stage_version and mark old rows superseded —
// reviewed rows are never mutated/deleted. Reads return only
// `superseded_at IS NULL`; reviews of superseded rows stay historical.
export const contextSignals = pgTable(
	"context_signals",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		runId: uuid("run_id")
			.notNull()
			.references(() => agentRuns.id, { onDelete: "cascade" }),
		stageVersion: integer("stage_version").notNull().default(1),
		accountId: uuid("account_id"),
		// Derived from account_id by the service (`all` when null); the
		// check below enforces the relationship and the validator reuses it.
		accountScope: text("account_scope").notNull(),
		type: text("type").notNull(),
		periodStart: date("period_start", { mode: "string" }),
		periodEnd: date("period_end", { mode: "string" }),
		metric: text("metric").notNull(),
		observed: text("observed"),
		expected: text("expected"),
		confidence: findingConfidence("confidence").notNull().default("low"),
		status: contextSignalStatus("status").notNull(),
		policyVersion: text("policy_version").notNull(),
		explanation: text("explanation"),
		evidence: jsonb("evidence").notNull(),
		supersededAt: ts("superseded_at"),
		createdAt: createdAt(),
	},
	(t) => [
		uniqueIndex("context_signals_run_stage_scope_type_period_metric_uniq").on(
			t.runId,
			t.stageVersion,
			t.accountScope,
			t.type,
			t.periodStart,
			t.periodEnd,
			t.metric,
		),
		index("context_signals_run_idx").on(t.runId),
		check(
			"context_signals_account_scope_chk",
			sql`(${t.accountId} IS NULL AND ${t.accountScope} = 'all') OR (${t.accountId} IS NOT NULL AND ${t.accountScope} = CAST(${t.accountId} AS text))`,
		),
	],
);

// T18 signal reviews are mandatory + append-only. `signal_id` is a plain
// uuid (no FK) so retention can purge signal content while reviews survive
// with ids-only/snapshot metadata.
export const contextSignalReviews = pgTable(
	"context_signal_reviews",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		signalId: uuid("signal_id").notNull(),
		runId: uuid("run_id")
			.notNull()
			.references(() => agentRuns.id, { onDelete: "cascade" }),
		signalSnapshot: jsonb("signal_snapshot").notNull(),
		officerId: uuid("officer_id").notNull(),
		action: findingReviewAction("action").notNull(),
		note: text("note"),
		createdAt: createdAt(),
	},
	(t) => [index("context_signal_reviews_signal_idx").on(t.signalId, t.createdAt)],
);
