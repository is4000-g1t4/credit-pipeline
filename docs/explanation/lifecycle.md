# Lifecycle

This page explains states and failure behavior. Audience: developers who debug stuck cases, and readers who want to know what moves a case. Outcome: you can predict the next state of any application, loan, or alert.

## Application status machine

Allowed transitions, from `packages/core/src/status.ts`:

| From                                      | To                                               | Trigger                                                      |
| ----------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| `submitted`                               | `processing`, `failed`                           | Workflow start; reconciler marks ended cases failed          |
| `processing`                              | `pending_review`, `booked`, `declined`, `failed` | Refer; auto book; policy or check-only decline; error path   |
| `pending_review`                          | `booked`, `declined`, `expired`, `failed`        | Officer approve; officer decline; 72-hour expiry; error path |
| `booked`, `declined`, `expired`, `failed` | none                                             | Terminal; no transitions out                                 |

`isTerminal` is true for `booked`, `declined`, `expired`, and `failed`. Every status write in the worker and reconciler is conditional, so terminal states are never overwritten.

Each applicant can hold at most 3 non-terminal applications (`submitted`, `processing`, `pending_review`). A fourth submit returns 409 `TOO_MANY_APPLICATIONS`. Source: `apps/applications/src/routes/applications.ts:170-171`.

## Decision paths

The workflow runs checks first. Identity or sanctions failure declines the case before scoring (check-only decline). Otherwise scorecard-v1 and policy-v1.0 decide: `decline` persists a system decline, `auto_approve` books directly, anything else marks the case `pending_review`. Source: `apps/worker/src/workflows/application.ts:243-320`.

The officer decision travels as a Temporal update from the review service. Replay rules:

- Same `requestId` on a decided case returns the original result (`booked` or `declined` with `decisionId` and `loanId`).
- Same `requestId` on an approved decision with no loan yet returns 409 `BOOKING_INCOMPLETE`: the case is still converging (saga step 2 or 3 pending, reconciler retrying). Retry until it replays `booked`.
- A different decision on a decided case returns 409 `DECISION_CONFLICT`.
- A decision on a case that is not `pending_review` returns 409 `CASE_NOT_PENDING`.
- Invalid terms (amount above the request, bad term range, DTI or DSCR breach) return 422 `DECISION_REJECTED`.

Source: `apps/review/src/routes/review.ts:70-95`, `packages/service-kit/src/gateway.ts:66-103`.

## Review expiry

A referred case waits at most 72 hours (`REFER_DEADLINE_MS` in `apps/worker/src/workflows/application.ts`). At the deadline the workflow calls `expireReview`, which flips `pending_review` to `expired` only when no decision and no loan exist. A decision in flight at the deadline runs first: if it succeeds it books; if it fails, the next loop calls `expireReview` and the case becomes `expired` unless a decision or loan exists. The reconciler also expires stale pending cases whose workflow ended. Source: `apps/worker/src/activities/decisions.ts:308-352`.

## Booking saga

Booking spans two databases, so it runs as three transactions in `apps/worker/src/activities/booking.ts`:

1. `credit_applications`: lock the case, check the route guard (auto needs `processing`, officer needs `pending_review`), insert the decision plus audit and outbox rows. Status does not flip yet.
2. `credit_loans`: insert the loan with denormalized reference, applicant, and product, plus installments, audit, and outbox rows.
3. `credit_applications`: conditional flip to `booked` from a non-terminal status, plus audit.

Each step is idempotent. A crash between steps 1 and 2 replays into the existing decision. A crash between steps 2 and 3 replays into the existing loan and finishes the flip. The brief window between steps 2 and 3 shows a loan whose application is not yet `booked`. Readers must treat `booked` status as the terminal marker. `markFailed` and `expireReview` check loan existence first, so the window can never flip the case to a wrong terminal state. Officer approvals are capped: approved amount must stay within the product minimum and the requested amount, term 12–60 months, and adjusted terms must pass DTI or DSCR checks.

## Reconciler

The reconciler runs every 30 seconds under advisory lock 4243. Source: `apps/worker/src/reconciler.ts`.

| Case set                                                                                      | Rule                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submitted`, never started, older than 30 s                                                   | Start the workflow                                                                                                                                                                                                                                                         |
| `submitted` with a started workflow                                                           | If describe says CLOSED or NOT_FOUND and no decision or loan exists, mark failed                                                                                                                                                                                           |
| `processing` or `pending_review`, untouched for 15 min                                        | If describe says CLOSED or NOT_FOUND and no decision or loan exists, mark failed (`processing`) or expired (`pending_review`)                                                                                                                                              |
| `processing` or `pending_review`, untouched for 15 min, with an approved decision but no loan | Resume the booking saga from the persisted decision (`repairBooking`, idempotent). A repair error is transient: the case stays non-terminal and retries next tick — never failed. While converging, review replay on the same `requestId` returns 409 `BOOKING_INCOMPLETE` |

A describe error skips the tick. It never fails the case.

## Research runs

Advisory research runs (case brief, context stage, policy stage) are durable Temporal workflows, not in-process jobs. The `agent_runs` row stays the read model the UI polls. Source: `apps/research/src/agent-run.ts`, `agent-activities.ts`, `agent-sweep.ts`, `agent-worker.ts`, `lifecycle.ts`.

1. The API inserts the `queued` row (with its audit) and, only after that transaction commits, starts workflow `research.run:<runId>:<token>` on the `research-agents` queue. The start is bounded to 2 seconds. If Temporal is unreachable or the start does not answer in time, the response is unchanged and the row stays `queued`. A context retry is the same shape: the claimed stage starts `research.context-retry:<runId>:<stageToken>`.
2. The `agent-worker` process runs the activity with a Temporal heartbeat for the whole run (the run's own DB heartbeat continues for the UI). Attempt 1 claims with the input token. Business failures (validation, model unavailable, budget) are finalized on the row and the activity returns, so Temporal never retries or re-spends them.
3. A crash, lost heartbeat or unexpected throw retries the activity (3 attempts). Attempt > 1 first calls `rotateRunForRetry`: in one transaction, only while the run is non-terminal, it rotates `run_token`, resets the row to `queued`, refreshes the lease, and discards what the dead attempt persisted (evidence, findings, context signals, stage state). The zombie's token-guarded writes then fail with `StaleRunError`. A terminal run does no work. A context retry rotates the stage token the same way (`rotateContextStageForRetry`).
4. When every attempt fails, or the workflow is cancelled, `failAgentRun` fails a still-active run: `timeout` for a timeout, otherwise `internal_error`, token cleared, `finished_at` set. Context and policy stages it left `queued` or `running` fail with the same code. For a retry it fails only the running stage. It is idempotent and never touches a terminal run or a persisted brief.
5. The worker sweep (every 15s) re-issues idempotent starts for queued runs and claimed context retries that never heartbeated and are older than 10s. It is also the backstop for orphaned rows: a `queued` or `running` run with no sign of life (DB heartbeat, else creation) past the whole retry horizon (lease × 3 attempts + backoff + 5 minutes) fails `timeout` through the `failAgentRun` logic, stages included. That covers runs never started, terminated workflows, exhausted cleanup and pre-migration rows, so the UI always reaches a terminal state and a new run is never blocked. Context or policy stages left `running` on a terminal run fail `timeout` the same way. A live retry, or a started run waiting on a backlogged worker, stays inside the horizon and is never killed.

## Idempotency and replay

- Submit: `Idempotency-Key` plus user id is the key. Same key with the same body replays `{id, reference}` with 201. Same key with a different body returns 409 `IDEMPOTENCY_CONFLICT`.
- Decisions: one row per application (`application_id` unique). Officer `requestId` is unique while nulls stay distinct, so system decisions carry no request id and officer replays match on it.
- Outbox inserts use `ON CONFLICT (dedupe_key) DO NOTHING`, so retries never duplicate events.
- The portfolio consumer inserts `processed_events` and `activity_feed` with `ON CONFLICT DO NOTHING`, so redelivery writes nothing.

## Loans, installments, alerts

Loan status is derived, never stored by callers. `deriveLoanStatus` in `packages/core/src/status.ts`: all installments paid means `closed`; any overdue means `overdue`; otherwise `active`. Installments move `scheduled` to `paid` or `overdue`. Alerts move `open` to `acknowledged` or `closed`.

The monitoring sweep runs every 5 minutes with overlap `SKIP`. It marks due `scheduled` installments `overdue`, creates one `payment_overdue` alert per overdue installment without one, recomputes affected loans, and writes audit plus outbox rows for each new alert. Re-runs with the same data write nothing. A manual run (`POST /api/demo/monitoring/run`) waits up to 30 seconds for counts; if the workflow is still running it returns 202 with `{workflowId}`. Sources: `apps/worker/src/schedules.ts`, `apps/worker/src/activities/monitoring.ts`, `packages/service-kit/src/gateway.ts:149-178`.

Paying an installment marks it `paid`, recomputes the loan, closes its open alerts, and emits `payment.posted`. Acknowledging an alert only moves `open` to `acknowledged`. Paying later closes only open alerts, so an acknowledged alert stays acknowledged. A repeat pay on a paid installment returns 409 `ALREADY_PAID`; acknowledging a non-open alert returns 409 `ALERT_NOT_OPEN`. Sources: `apps/loans/src/routes/demo.ts:65-154`, `apps/loans/src/routes/loans.ts:91-130`.

Demo age moves unpaid due dates back by the given days, then runs monitoring in the same call and returns its counts (or 202 when monitoring is still running).

## Why alerts behave this way

One alert exists per overdue installment because `ews_alerts` carries a partial unique index on (`installment_id`, `type`). Concurrent sweeps converge: only the insert winner writes audit and outbox rows. Pay closes alerts because the debt is settled. Acknowledge only marks review, so the alert stays visible in history but leaves the open queue.

## Related

- [Architecture](architecture.md) — components, trust boundary, failure domains
- [Data and events](../reference/data-and-events.md) — tables, topics, outbox timing
- [Public and internal API](../reference/api.md) — exact routes and error codes
