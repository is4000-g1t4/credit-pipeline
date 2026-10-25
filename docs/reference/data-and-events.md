# Data and events

This page is a lookup surface. Audience: developers who change storage or read events. Outcome: you know which database owns each table, which topics exist, and how events move.

## Database ownership

| Database              | Owner                        | Tables                                                                                                                                                                                                          | Notes                                                                                              |
| --------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `credit_auth`         | Gateway                      | `users`                                                                                                                                                                                                         | Email unique; role `applicant` or `officer`; scrypt hash                                           |
| `credit_applications` | Applications service, worker | `applications`, `kyc_checks`, `external_reports`, `documents`, `scores`, `policy_evaluations`, `decisions`, `idempotency_keys`, `generated_artifacts`, `generated_artifact_holds`, `audit_log`, `outbox_events` | Pipeline state, decisions, generated artifacts/holds, audit, outbox                                |
| `credit_loans`        | Loans service, worker        | `loans`, `installments`, `payments`, `ews_alerts`, `audit_log`, `outbox_events`                                                                                                                                 | Ledger plus audit and outbox; denormalized `application_reference`, `applicant_user_id`, `product` |
| `credit_portfolio`    | Portfolio service            | `processed_events`, `activity_feed`, `dead_letter_events`                                                                                                                                                       | Kafka read model; application and loan ids are opaque                                              |
| `credit_research`     | Research service             | `agent_runs`, `agent_evidence`, `agent_findings`, `finding_evidence`, `agent_finding_reviews`, `agent_run_views`                                                                                                | Advisory briefs; runs token-claimed, evidence/findings persist atomically with success             |
| `credit_policy`       | Policy service               | `policy_documents`, `policy_versions`, `policy_sections`, `policy_chunks`, `policy_queries`, ACL/role/audit/spend tables                                                                                        | Versioned corpus, pgvector index, query log, spend ledger                                          |

Sources: `packages/db/src/auth.ts`, `packages/db/src/applications.ts`, `packages/db/src/loans.ts`, `packages/db/src/portfolio.ts`, `packages/db/src/research.ts`, `packages/db/src/policy.ts`, `packages/db/src/shared.ts`.

Rules:

- No cross-database foreign keys. Cross-service references are plain UUIDs.
- Each service imports only its own `@credit/db/*` subpath (`./auth`, `./applications`, `./loans`, `./portfolio`, `./research`, `./policy`, `./shared`).
- The worker is the only component that writes both `credit_applications` and `credit_loans`. It never touches `credit_auth`, `credit_portfolio`, or `credit_research`.
- Review is stateless and owns no tables.

Key uniqueness:

- `applications.reference` is unique.
- `decisions.application_id` is unique: one decision per application.
- `decisions.request_id` is unique but nullable: nulls stay distinct, so only officer request ids replay.
- `loans.application_id` is unique: one loan per application.
- `idempotency_keys` uses the (`user_id`, `key`) composite.
- `outbox_events.dedupe_key` is unique; `seq` orders the relay.
- `ews_alerts` has a partial unique index on (`installment_id`, `type`) where the installment is not null: one alert per overdue installment.

## Migrations and seed

- `pnpm db:init` creates the six service databases plus the Temporal pair if missing. Source: `scripts/db-init.ts`.
- `pnpm db:migrate` applies each service folder in `packages/db/drizzle/*` to its own database, tracked per database. Source: `packages/db/src/migrate.ts`. When `RESEARCH_DATABASE_URL` is unset (Phase 1 checkout), research is skipped with a clear log and the other five still fail fast — set it (see `getting-started.md` §9) to enable Phase 2.
- `pnpm db:generate` regenerates migrations from the six configs: `drizzle.config.auth.ts`, `drizzle.config.applications.ts`, `drizzle.config.loans.ts`, `drizzle.config.portfolio.ts`, `drizzle.config.research.ts`, `drizzle.config.policy.ts`. Never hand-edit files under `packages/db/drizzle/`.
- `pnpm db:seed` inserts the 7 demo users idempotently (`ON CONFLICT DO NOTHING` on email). Source: `packages/db/src/seed.ts`.
- `pnpm setup` runs `db:wait && db:init && kafka:init && db:migrate && db:seed`.
- `pnpm kafka:init` creates the 7 topics (3 partitions, replication factor 1), idempotently. Source: `scripts/kafka-init.ts`.

## Event catalog

Seven topics, from `packages/core/src/events.ts` and `scripts/kafka-init.ts`:

| Event type              | Topic                          | Producer                              | Payload keys                                                                                                                           |
| ----------------------- | ------------------------------ | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `application.submitted` | `credit.application.submitted` | Applications service submit           | `applicationId`, `reference`, `type`, `product`, `amountCents`, `termMonths`                                                           |
| `decision.made`         | `credit.decision.made`         | Worker booking and decline activities | `decisionId`, `applicationId`, `outcome`, `decidedBy`, `reasonCodes`, plus `approvedAmountCents`, `termMonths`, `rateBps` when present |
| `review.requested`      | `credit.review.requested`      | Worker `markPendingReview`            | `applicationId`, `reference`, `reasonCodes`                                                                                            |
| `review.expired`        | `credit.review.expired`        | Worker `expireReview`                 | `applicationId`, `reference`                                                                                                           |
| `loan.booked`           | `credit.loan.booked`           | Worker `bookLoan`                     | `loanId`, `applicationId`, `principalCents`, `termMonths`, `rateBps`, `monthlyPaymentCents`                                            |
| `payment.posted`        | `credit.payment.posted`        | Loans demo pay                        | `paymentId`, `loanId`, `installmentId`, `amountCents`                                                                                  |
| `ews.alert`             | `credit.ews.alert`             | Worker monitoring                     | `alertId`, `loanId`, `installmentId` when present, `alertType`, `severity`                                                             |

Envelope shape: `{id, type, version: 1, occurredAt, applicationId?, loanId?, payload}`. Payload schemas in `packages/core/src/schemas.ts:210-326` are strict (`.strict()`), so unknown keys are rejected.

Dedupe keys, from `packages/core/src/events.ts:50-71`:

| Event                   | Key                                     |
| ----------------------- | --------------------------------------- |
| `application.submitted` | `application.submitted:<applicationId>` |
| `review.requested`      | `review.requested:<applicationId>`      |
| `decision.made`         | `decision.made:<decisionId>`            |
| `review.expired`        | `review.expired:<applicationId>`        |
| `loan.booked`           | `loan.booked:<loanId>`                  |
| `payment.posted`        | `payment.posted:<paymentId>`            |
| `ews.alert`             | `ews.alert:<alertId>`                   |

## Outbox relay

Each writer database has its own `outbox_events` copy. Writers insert the outbox row in the same transaction as the state change with `ON CONFLICT (dedupe_key) DO NOTHING`. The worker runs one relay loop per writer database (`apps/worker/src/index.ts`, `apps/worker/src/outbox/relay.ts`):

- Tick every 1 second; one owner per database via advisory locks 4242 and 4243.
- Batch up to 50 unpublished rows in `seq` order.
- First failure stops the batch, so order is preserved.
- Each failure increments `attempts` and records `last_error`.
- After 10 attempts the row is marked dead-lettered.
- While Kafka is down the tick is skipped without touching rows.

Gateway health aggregates backlog and dead-letter counts from the applications and loans health checks. The gateway itself owns no outbox table.

## Portfolio consumer

Group `credit-activity`, subscribes from the beginning to all seven topics, manual commit. Source: `apps/portfolio/src/events/consumer.ts`.

- Invalid JSON or schema rejection: writes `dead_letter_events`, commits the offset, continues. Poison never stalls the partition.
- Valid envelope: one transaction inserts `processed_events` and `activity_feed`, both `ON CONFLICT DO NOTHING`. Duplicate delivery writes nothing and still commits.
- Transient database errors: thrown without resolving, so Kafka redelivers.
- Feed text uses only allowlisted payload fields plus the core reason-text map. It never includes identity fields. Allowlisted events may include documented financial amounts (`principalCents`, `termMonths`, `rateBps`, `amountCents`).
- Portfolio health reports `consumer: ok` only while connected.

## Advisory research data

Phase 2 research state lives entirely in `credit_research`; no events are emitted for it.

- Case facts are the single 16-key strict schema (`caseFactsSchema` in `packages/core/src/schemas.ts`): `applicationId`, `reference`, `type`, `product`, `amountCents`, `termMonths`, `submittedAt`, `asOf` (must equal `submittedAt`), `applicantName`, `companyName`, `registrationNumber`, `industry`, `yearsTrading`, `city`, `aiResearchConsent`, `status`. Stored minus consent; consent rides the request only.
- `agent_runs` rows carry the frozen case facts, `asOf`, model/agent/prompt versions, usage, and the Grafana conversation id (the run id — not PII). Evidence rows carry the server-built snapshot, offsets, hashes, tiers, and the verified date basis; findings carry only judge-supported claims with derived confidence (never the model's self-reported confidence).
- Finding reviews are append-only (`agent_finding_reviews`); the latest action per finding wins. Views are per officer/run/minute (`agent_run_views`); the decision bundle's `viewedAt` is the deciding officer's latest view.
- The frozen bundle (`researchBundleSchema`) is built server-side at decision time, narrowed to exactly the accepted finding ids, and copied into the officer decision snapshot (approve via `bookLoan`, decline via `persistOfficerDecline`). The public selection (`agentRunId` + `acceptedFindingIds`) never reaches the workflow.

## Generated artifacts (EN-01/02/03)

Generated artifacts stay in `credit_applications` because they are case-scoped
and must be deleted under the same retention/legal-hold regime.

- `generated_artifacts`: one row per version (`application_id`, `type`,
  `version`, `revision`, `status`; `content` and server-extracted `citations`
  jsonb; `content_hash`, `model`, `prompt_version`, `created_by`,
  `approved_by`, timestamps, `retention_until`). A partial unique index keeps
  one live draft per case/type. `revision` is the optimistic-concurrency token.
  `document_derived` marks artifacts built while document evidence was
  available; reads then require the active assigned-officer grant even after
  unassignment.
- A database trigger freezes `content`/`citations`/provenance once a row is
  approved or superseded and only permits `draft → approved|deleted`,
  `approved → superseded|deleted`, and `superseded → deleted`. Deletion is a
  tombstone (`status='deleted'`, `deleted_at` set); rows are never hard-deleted.
- `generated_artifact_holds` and any active document legal hold on the case
  block tombstone/retention (release is idempotent); deletion also takes the
  per-application advisory lock the document hold path uses. `audit_log` gets
  one ids-only row per create/edit/version/approve/tombstone/hold/retention
  action.
- Generation provenance is metadata only; no prompt, generated text, document
  quote, or applicant PII goes to logs or Grafana.

## PII allowlist

Event payload schemas and feed text are allowlists: only the keys in the catalog above may appear. Audit writes reject forbidden keys (`nationalid`, `dob`, `address`, `phone`, `email`, `income`, `revenue`, `registrationnumber`, and variants) via `assertAllowlisted` in `packages/service-kit/src/events.ts`. Do not add identity fields to events or audit payloads, and do not add new finance fields beyond the catalog.

## Related

- [Architecture](../explanation/architecture.md) — why the split exists
- [Lifecycle](../explanation/lifecycle.md) — saga windows, monitoring, alert states
- [Public and internal API](api.md) — internal contracts that read this state
