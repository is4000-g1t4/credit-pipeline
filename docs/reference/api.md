# Gateway API Reference

Public HTTP contracts for the credit pipeline. Audience: API caller or integrator. Outcome: exact method, path, access, body, response, and error for each endpoint.

All public calls go through the gateway. Default base URL is `http://127.0.0.1:3001`. Browsers should use the same-origin web proxy (`/api` on `http://localhost:3000`), which forwards to the gateway. The gateway sets no CORS headers. Non-browser clients can call the gateway directly.

For ports, base URLs, and secrets, see `../reference/configuration.md`. For request flow and trust boundaries, see `../explanation/architecture.md`. For status values, see `../explanation/lifecycle.md`.

## Conventions

- JSON only. Send `content-type: application/json` on bodies.
- Error envelope for every 4xx/5xx: `{ "error": { "code", "message", "fields?" } }`. `fields` maps a field path to messages. No stack traces.
- Session: cookie `session`, HMAC-signed, 7-day expiry, `HttpOnly`, `SameSite=Lax`, `Path=/`. The `Secure` flag applies in production only. There is no signup route.
- Body limit: 100,000 bytes on `/api/*`. Larger bodies return 413 `BODY_TOO_LARGE`.
- Rate limits are in-memory per gateway process: login 10/min per email plus 30/min per IP (the web proxy shares one peer IP, so the per-email cap is the real guard); application submit 5/min per user. Excess returns 429 `RATE_LIMITED`.
- In production (`NODE_ENV=production`), non-GET/HEAD/OPTIONS requests need `Origin` exactly equal to `WEB_ORIGIN`. Other origins return 403 `ORIGIN_FORBIDDEN`.
- Responses carry `x-request-id`. Send one to correlate logs; the gateway generates one when missing.
- The gateway preserves path and query when proxying and passes the upstream status and body through. A transport failure returns 502 `BAD_GATEWAY`.
- Invalid JSON bodies return 400 `INVALID_JSON`.

## Auth

| Method and path         | Access | Purpose                                    |
| ----------------------- | ------ | ------------------------------------------ |
| `POST /api/auth/login`  | Public | Log in with email and password             |
| `POST /api/auth/logout` | Public | Clear the session cookie                   |
| `GET /api/auth/me`      | User   | Return the current user and demo-mode flag |

Login request:

```json
{ "email": "maria@example.com", "password": "demo1234" }
```

Login response `200`:

```json
{
	"user": {
		"id": "<uuid>",
		"email": "maria@example.com",
		"fullName": "Maria Demo",
		"role": "applicant"
	}
}
```

Login sets the `session` cookie. Wrong email or password returns 401 `INVALID_CREDENTIALS`. Bad shape returns 400 `VALIDATION_ERROR`.

Logout response `200`: `{ "ok": true }`. It clears the cookie.

`GET /api/auth/me` response `200`:

```json
{
	"user": {
		"id": "<uuid>",
		"email": "officer@example.com",
		"fullName": "Officer Demo",
		"role": "officer"
	},
	"demoMode": true
}
```

No session or unknown user returns 401 `UNAUTHENTICATED`.

## Applications

| Method and path                               | Access                               | Purpose                                                                                                         |
| --------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `POST /api/applications`                      | Applicant                            | Submit an application (needs `Idempotency-Key`; 409 `DRAFT_REQUIRED` for profiled customers)                    |
| `POST /api/applications/drafts`               | Applicant                            | Create a draft, no workflow/outbox (needs `Idempotency-Key`)                                                    |
| `POST /api/applications/:id/submit`           | Applicant                            | Submit a draft after the requirements gate (needs `Idempotency-Key`)                                            |
| `GET /api/applications/:id/requirements`      | Owner / assigned officer (submitted) | Requirements checklist: `readyToSubmit`, blockers, warnings, reusable evidence (owner only — officers get `[]`) |
| `PATCH /api/applications/:id/context-consent` | Applicant (owner)                    | Set context-analysis consent (`context-consent-v1`)                                                             |
| `POST /api/applications/:id/documents/reuse`  | Applicant (owner)                    | Copy clean/fresh customer evidence into app docs (201 copy, 200 replay)                                         |
| `GET /api/applications`                       | User                                 | List applications, newest first, cursor pages (officers exclude drafts)                                         |
| `GET /api/applications/:id`                   | User                                 | Full case detail; gateway composes the `loan` block (officers 404 on drafts)                                    |
| `GET /api/customer/profile`                   | Applicant (owner)                    | Profile, masked accounts, KYC freshness, reusable evidence metadata                                             |
| `GET /api/customer/documents`                 | Applicant (owner)                    | Reusable evidence metadata and freshness; no bytes/text                                                         |

### Submit an application

Header `Idempotency-Key` is required. Missing key returns 400 `MISSING_IDEMPOTENCY_KEY`. Officers cannot submit (403 `FORBIDDEN`).

Submit body:

```json
{
	"type": "individual",
	"product": "personal_loan",
	"amountCents": 1200000,
	"termMonths": 48,
	"purpose": "Home renovation",
	"consents": [true, true, true],
	"identity": {
		"fullName": "Maria Demo",
		"dob": "1990-05-14",
		"nationalId": "MARIA42C1",
		"email": "maria@example.com",
		"phone": "+1-555-0100",
		"address": "1 Demo Street",
		"city": "Demo City"
	},
	"individual": {
		"employmentStatus": "employed",
		"employerName": "Acme Corp",
		"employmentYears": 6,
		"monthlyIncomeCents": 420000,
		"existingDebtCents": 61000,
		"bankRelationshipYears": 3
	}
}
```

SME submits use the same envelope with `"type": "sme"`, `"product": "sme_term_loan"`, and an `sme` block instead of `individual`:

```json
"sme": {
	"companyName": "Café Aurora",
	"registrationNumber": "CAFEAURC",
	"industry": "hospitality",
	"yearsTrading": 4,
	"employees": 9,
	"annualRevenueCents": 61000000,
	"monthlyFcfCents": 380000,
	"existingDebtServiceCents": 30000
}
```

`sme` fields: `companyName` (1-200 chars), `registrationNumber` (6-20 alphanumeric), `industry` (`hospitality`, `retail`, `services`, `construction`, `other`), `yearsTrading` (0-100), `employees` (int, 0-10000), `annualRevenueCents` / `monthlyFcfCents` / `existingDebtServiceCents` (integer cents, min 0; monthly FCF must not exceed revenue / 12), optional `collateral` (`{ hasCollateral, valueCents? }`). Full schema: `smeBlockSchema` in `packages/core/src/schemas.ts`.

Rules:

- `type` must match `product`: `individual` needs `personal_loan`; `sme` needs `sme_term_loan` with an `sme` block.
- `amountCents`: $1,000-$25,000 personal; $5,000-$100,000 SME.
- `termMonths`: 12-60.
- `consents`: exactly 3, all `true`.
- `identity.dob`: format `YYYY-MM-DD`; owner must be 18 or older.
- `identity.email`: must equal the session email.
- `identity.nationalId`: 8-20 alphanumeric characters.

Success response `201`: `{ "id": "<uuid>", "reference": "<reference>" }`.

Idempotency: same key with the same payload replays `201` with the original `{id, reference}`. Same key with a different payload returns 409 `IDEMPOTENCY_CONFLICT`. Each applicant can hold at most 3 non-terminal applications; the 4th submit returns 409 `TOO_MANY_APPLICATIONS`. Invalid bodies return 400 `VALIDATION_ERROR` with `fields`.

### List applications

Query params: `limit` (1-100, default 20), `cursor` (`<ISO-8601>,<uuid>`). Officers see all applications. Applicants see only their own. Bad cursor returns 400 `INVALID_CURSOR`.

Response `200`:

```json
{
	"items": [
		{
			"id": "<uuid>",
			"reference": "<reference>",
			"type": "individual",
			"product": "personal_loan",
			"status": "booked",
			"amountCents": 1200000,
			"termMonths": 48,
			"submittedAt": "<iso>",
			"decidedAt": "<iso>"
		}
	],
	"nextCursor": "<iso>,<uuid>"
}
```

`nextCursor` is `null` when the page is not full. Pass it as `cursor` for the next page.

### Read application detail

Response `200` contains `application`, `checks`, `externalReports`, `documents`, `score`, `policyEvaluation`, `decision`, and `timeline`. Key nested fields:

- `application`: list fields plus `identity`, `financial`, `business`, `consents`, `purpose`, `workflowStartedAt`, `failedReason`.
- `checks[]`: `type`, `status`, `details`. `externalReports[]`: `provider`, `kind`, `version`, `payload`. `documents[]`: `kind`, `status`, `note`.
- `score`: `modelVersion`, `score`, `grade`, `components`, `factors`, `affordability` (null until scored). `policyEvaluation`: `policyVersion`, `outcome`, `reasons[]`, `maxAmountCents`, `inputs` (null until evaluated). `decision`: `outcome`, `decidedBy`, `approvedAmountCents`, `termMonths`, `rateBps`, `reasons` (null until decided). `notes`, `officerUserId`, `requestId`, and `snapshot` are officer-only: applicants see the safe fields above (`id`, `outcome`, `decidedBy`, terms, `rateBps`, `reasons`, `decidedAt`).
- `timeline[]`: `at`, `actor`, `action`, `entity`, `payload` (audit entries, newest first).

The gateway adds `loan`:

```json
{
	"loan": {
		"id": "<uuid>",
		"principalCents": 5000000,
		"installments": { "total": 60, "paid": 0, "overdue": 0 }
	}
}
```

`loan` is `null` when no loan is booked yet. A loan lookup failure other than 404 returns 502 `BAD_GATEWAY`. Cross-applicant reads and bad ids return 404 `NOT_FOUND`, never 403.

## Review

Officer only. All endpoints proxy to the review service. Applicants get 403 on every `/api/review/*` route.

| Method and path                 | Access  | Purpose                           |
| ------------------------------- | ------- | --------------------------------- |
| `GET /api/review/queue`         | Officer | Pending cases, oldest first       |
| `POST /api/review/:id/decision` | Officer | Approve or decline a pending case |

Queue response `200`:

```json
{
	"items": [
		{
			"id": "<uuid>",
			"reference": "<reference>",
			"type": "sme",
			"product": "sme_term_loan",
			"amountCents": 6000000,
			"termMonths": 60,
			"submittedAt": "<iso>",
			"waitMs": 12345,
			"score": 711,
			"grade": "B",
			"reasons": ["AMOUNT_ABOVE_AUTO_LIMIT"],
			"topReasons": ["AMOUNT_ABOVE_AUTO_LIMIT"]
		}
	]
}
```

Decision body:

```json
{
	"requestId": "<uuid>",
	"outcome": "approve",
	"approvedAmountCents": 5000000,
	"termMonths": 60,
	"notes": "Counter-offer: reduced to $50,000 on current cash flow."
}
```

Rules:

- `requestId`: UUID. Use a fresh one per decision attempt. Keep the panel open while retrying: a page reload generates a new one, and a decided case then returns `DECISION_CONFLICT`.
- `outcome`: `approve` or `decline`.
- `approvedAmountCents`: positive integer cents, optional.
- `termMonths`: 12-60, optional.
- Declines need `reasonCode` (`OFFICER_JUDGEMENT`, `INSUFFICIENT_EVIDENCE`, or `POLICY_EXCEPTION`) and non-empty `notes` (max 2000 chars).
- Invalid bodies return 422 `VALIDATION_ERROR` with `fields`.

Replay rules:

- Same `requestId` on a decided case replays the original result `200`: `{ "outcome": "booked"|"declined", "decisionId": "<uuid>", "loanId": "<uuid>"|null }` (`loanId` is `null` only on declines).
- Same `requestId` on an approved decision with no loan yet returns 409 `BOOKING_INCOMPLETE`: the booking saga is still converging (the reconciler retries it). Retry the same call until it replays `booked`.
- A different decision on a decided case returns 409 `DECISION_CONFLICT`.
- A case that is not `pending_review` returns 409 `CASE_NOT_PENDING`.
- Workflow errors map to 409 `CASE_NOT_RUNNING`, 422 `DECISION_REJECTED`, or 500 `DECISION_FAILED`.

### Advisory research (Phase 2)

Officer only. Cited public-source briefs on `pending_review` cases with AI research consent. There are no `/api/research/*` routes; everything lives under `/api/review/*`.

| Method and path                                                  | Purpose                                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `POST /api/review/:id/research`                                  | Ensure a run; `202` `{ "runId", "status" }`, idempotent                                     |
| `GET /api/review/:id/research`                                   | Latest run + brief + evidence + findings; never records a view                              |
| `GET /api/review/:id/research/audit`                             | Auto-trigger history (`auto.skip`/`auto.ensure`/`auto.duplicate`); works with no run        |
| `POST /api/review/:id/research/view`                             | `{ "runId" }`; records one view after the panel opens                                       |
| `POST /api/review/:id/research/findings/:findingId`              | `{ "action": "accepted"\|"rejected", "note?" }`; append-only                                |
| `POST /api/review/:id/research/context/retry`                    | Context-stage retry; `202` `{ "runId", "contextStageToken", "contextStageVersion" }`        |
| `POST /api/review/:id/research/context/signals/:signalId/review` | `{ "action": "accepted"\|"rejected", "note?" }`; append-only signal review + updated signal |

Rules:

- Feature disabled (`AGENTS_ENABLED` or `AGENT_CASE_BRIEF_ENABLED` false): every research route returns 404 `RESEARCH_DISABLED` and the UI panel hides. Applicants still get 403 first.
- `POST .../research` without AI research consent returns 403 `CONSENT_REQUIRED`; on a case that is not `pending_review` it returns 409 `CASE_NOT_PENDING`.
- `GET .../research` returns 404 when no run exists yet. Finding reviews return 409 `RUN_NOT_SUCCEEDED` unless the run succeeded, and 404 when the run/finding does not belong to the application.
- Internal context (T18): `GET .../research` also carries `context` (`status` not_applicable/queued/running/succeeded/failed/skipped, `stageVersion`, `errorCode`, `model`, server-composed `brief` with summary/claims/dataGaps/limitations, `validation`, `usage`, live `signals[]` with type/period/metric/observed/expected/confidence/status/policyVersion/explanation/evidence ids plus `reviewStatus`/`reviewedAt`). A terminal failed run still exposes its stored context. Context retry (`POST .../research/context/retry`) resolves the latest run, claims a new stage version (max one retry, terminal failed/skipped stage only, never an external rerun) and returns 202 — poll latest until the stage settles. Signal review (`POST .../research/context/signals/:signalId/review`) appends `{action, note?}` to `context_signal_reviews` (ids-only snapshot, audited as `context.signal_review`) and returns `201 {id, signalId, action, signal}` with the updated signal; cross-case/unknown ids are 404, superseded signals are 409 `SIGNAL_SUPERSEDED`. Withdrawing context consent (`PATCH /api/applications/:id/context-consent`) immediately omits stored brief/signals from officer reads (audited `context.denied`) and rejects signal review/retry with 403; the applications service best-effort purges stored context via `POST .../context/purge` (service HMAC). An empty successful stage reports `No signals met the evidence bar for this period` with zero signals — never an all-clear. The officer panel renders context as a separate "Internal context" section after the external brief; a failed stage shows the sanitized error code with Retry (hidden when the case is decided or consent is off). The stage starts from a bounded officer-screen snapshot (preflight) then drills in through the read-only internal context tools (transactions, credit history, external reports, KYC checks, loans), and outputs stay advisory/deterministic: officer-facing signals remain deterministic candidates plus server-composed claims, with the model able to lower confidence but never raise it. Advisory only — no decision, chase, score, or status change.
- Case-level access (T00): the first officer to ensure a run claims the case (`assigned_officer`); the same officer re-ensuring is idempotent. Another user's active `assigned_officer` grant on that case makes any other officer's ensure, latest, view, finding-review, bundle, or audit call return 404 (non-disclosure — identical to "no such case"), and the denial is audited. Specialist grants (`compliance`, `policy_owner`, `safeguarding`) are additive: they never block an officer claim and never make a case unclaimable — but only an active `assigned_officer` grant authorizes ensure; specialists read but never ensure. A user with a revoked grant for the application cannot self-claim (audited denial/404) — only the service grant path may re-grant them. Specialist access is granted/revoked only through the service-only access endpoints below; officers and applicants get 403 there.
- Auto-trigger (T11): when `AGENT_AUTO_TRIGGER_ENABLED` is true, research consumes `credit.review.requested` (group `credit-research-auto`, manual commit) and ensures at most one `trigger=auto` run per referral generation, requested by the service principal (`AUTO_TRIGGER_SERVICE_USER_ID`, role `service`). Every outcome is recorded in `research_auto_events` (unique per application + envelope id), checked before the context fetch/caps: a redelivered envelope returns the stored outcome — even after a status/consent change, even when terminal, even when an officer run absorbed the referral — with zero new paid calls. An auto run carries no officer grant: the first officer to open latest/view/bundle (or the auto-audit endpoint below, when history exists) claims the case via T00 `claimOfficerAccess`; any later officer gets 404. Skips (consent/status/caps/budget/context failures) are recorded and audited as `auto.skip` with a machine-readable reason (`consent_required`, `not_pending`, `applicant_daily_cap`, `global_daily_cap`, `daily_cost_budget`, `application_not_found`, `context_invalid`, `context_mismatch`, `invalid_applicant`), ensures as `auto.ensure`, duplicates as `auto.duplicate` — all under actor role `service`, ids and codes only. Caps are UTC-calendar-day scoped, count only `trigger='auto'` runs, and check + ensure commit atomically under a global advisory lock; queued/running auto runs reserve `AGENT_MAX_COST_USD + CONTEXT_AGENT_MAX_COST_USD` each against the cost budget. Context 4xx/shape failures are permanent skips (never infinite redelivery) — except 408/429, which are transient and throw so Kafka redelivers; 5xx/transport/timeout failures throw so Kafka redelivers. Malformed envelopes are skipped + committed, never retried. Kafka carries no per-envelope auth: production Kafka must use SASL/ACL or a private network (the host-published 9092 listener is plaintext for local dev/test only). Crash-after-insert runs are picked up by the queued-run recovery sweep, which runs before the reaper on boot (boot + every 10s); the reaper stays the fallback.
- Review auto-audit: `GET /api/review/:id/research/audit` (officer) proxies the internal endpoint below with the same feature gate as the other research routes. It deliberately has no consent/status gate — gating on those would hide the skips it exists to surface. It returns `200 { "applicationId", "entries" }` (`action`, `actorRole`, `runId`, `metadata` with trigger event id + reason, `createdAt`), no PII, even when no run exists but a skip was audited. With no auto history it returns `200 { "applicationId", "entries": [] }` when no run exists, and 404 when a run exists the caller cannot see. Unknown cases 404 via the case-existence check (no orphan grant); cross-officer reads 404 via the research claim, passed through untouched. Disabled flags 404 `RESEARCH_DISABLED`; applicants 403. The case page fetches it automatically when latest 404s or research is unavailable, shows the `trigger` (`auto`/`officer`) and `requestedByRole` on runs (`auto` badge + "started automatically" copy), renders a cross-officer 404 as "not available for this case / assigned to another officer" (never a raw error), and offers an explicit "View auto-trigger audit" section with refresh. An auto run appears without clicking Run; the panel never auto-starts an officer run.
- Internal auto-audit: `GET /internal/research/applications/:applicationId/audit` (officer) returns the recent `auto.skip`/`auto.ensure`/`auto.duplicate` entries (`action`, `actorRole`, `runId`, `metadata` with trigger event id + reason, `createdAt`) — no PII. With no auto.* history it returns `200 { "applicationId", "entries": [] }` WITHOUT claiming when no run exists for the application (merely opening a case page must not assign it); when a run exists but the caller holds no grant it returns the same audited 404 as latest (non-disclosure — the denial is audited). Only when history exists does the first officer to open it claim the case via T00 `claimOfficerAccess` even when no run exists (a skip usually leaves none); any later officer gets 404. An officer who already holds an active grant (assigned or specialist) reads without claiming. This is how a skip reason becomes visible.
- Every sensitive-research read/write appends one row to `research_audit_log` (actor, time, action, application/run ids — never PII). If the audit write fails, the request fails instead of silently dropping security history. The table is append-only at the database level too (a migration trigger rejects UPDATE/DELETE). The run insert and its `run.ensure` audit commit in one transaction, as do a finding-review insert and its audit — a failed audit never leaves an unaudited mutation.
- Status semantics: unsigned/bad-signature calls return 401; a valid signature with the wrong role returns 403; cross-officer and unknown-case reads return 404.
- Using research in a decision: send only the selection (`agentRunId` plus non-empty `acceptedFindingIds`) in the decision body. Review fetches the app-scoped frozen bundle, verifies the selection is covered, narrows the forwarded bundle to exactly the accepted ids (§8.6), and forwards the server-built `research` object to the workflow; the selection itself is stripped. A client-supplied `research` object is rejected with 422.

Advisory boundary: research never approves, declines, scores, prices, or sets terms. Only `verified` (supported, cited) findings render; acceptance only freezes cited evidence into the decision snapshot and never changes the decision by itself. Bundle failures map precisely: transport/5xx → 503 `RESEARCH_UNAVAILABLE` (retryable: `error.fields.retryable == ["true"]`, retry or decide without research); missing/non-succeeded run, uncovered selection, or empty accepted set → 409 `RESEARCH_SELECTION_STALE` (non-retryable: re-review or decide without). Decisions without a selection never touch research and are never blocked by it.

## Loans

| Method and path                                   | Access  | Purpose                                  |
| ------------------------------------------------- | ------- | ---------------------------------------- |
| `GET /api/loans`                                  | User    | List loans (officer: all)                |
| `GET /api/loans/:id`                              | User    | Loan with installments, payments, alerts |
| `POST /api/loans/:id/alerts/:alertId/acknowledge` | Officer | Acknowledge one open alert               |

`GET /api/loans` response `200`: `{ "items": [loan] }` where each loan has `id`, `applicationId`, `reference`, `principalCents`, `termMonths`, `rateBps`, `monthlyPaymentCents`, `status`, `outstandingCents`, `nextDueDate`, `disbursedAt`.

`GET /api/loans/:id` response `200`: `{ "loan", "installments", "payments", "alerts" }`. `loan` has the list fields above. `installments[]` has `id`, `number`, `dueDate`, `principalCents`, `interestCents`, `totalCents`, `paidCents`, `status`, `paidAt`. Pass an entry's `id` as `installmentId` to demo pay. `payments[]` has `id`, `installmentId`, `amountCents`, `paidAt`, `source`. `alerts[]` has `id`, `installmentId`, `type`, `severity`, `status`, `acknowledgedBy`. Cross-applicant reads and bad ids return 404 `NOT_FOUND`.

Acknowledge response `200`: `{ "id": "<alert-uuid>", "status": "acknowledged" }`. Only `open` alerts change. A non-open alert returns 409 `ALERT_NOT_OPEN`. A missing alert returns 404. Paying an installment closes its open alerts but leaves acknowledged ones acknowledged.

## Demo endpoints

Officer only, and only when `DEMO_MODE=true`. Otherwise 403 `DEMO_MODE_DISABLED` (mode off) or 403 `FORBIDDEN` (not officer).

| Method and path                 | Purpose                                         |
| ------------------------------- | ----------------------------------------------- |
| `POST /api/demo/monitoring/run` | Run the monitoring sweep now                    |
| `POST /api/demo/loans/:id/pay`  | Pay one installment, close its open alerts      |
| `POST /api/demo/loans/:id/age`  | Move unpaid due dates back, then run monitoring |

Monitoring run request body: `{}`. Success `200`:

```json
{
	"markedOverdue": 2,
	"alertsCreated": 2,
	"loansUpdated": 1,
	"workflowId": "monitoring-manual-<uuid>"
}
```

If the sweep is still running after 30 seconds, the endpoint returns 202 `{ "workflowId": "monitoring-manual-<uuid>" }`. Poll the loan until an open alert appears.

Pay request body: `{ "installmentId": "<uuid>" }`. Success `200`:

```json
{
	"paymentId": "<uuid>",
	"status": "active",
	"outstandingCents": 12345,
	"nextDueDate": "<iso-date>",
	"loanId": "<uuid>"
}
```

An already-paid installment returns 409 `ALREADY_PAID`. A wrong installment id returns 404. Each payment emits a `payment.posted` event.

Age request body: `{ "days": 40 }` (`days` 0-3650; optional `installmentId` ages one installment). It moves unpaid installments back by `days` and then runs monitoring. Success `200`: `{ "aged": 60, "markedOverdue": 2, "alertsCreated": 2, "loansUpdated": 1, "workflowId": "monitoring-manual-<uuid>" }`. On a 30-second monitoring timeout it returns 202 `{ "aged": 60, "workflowId": "monitoring-manual-<uuid>" }`.

## Dashboard

Officer only.

| Method and path              | Purpose                                        |
| ---------------------------- | ---------------------------------------------- |
| `GET /api/dashboard/summary` | Application/loan counts, decision timing, feed |

Response `200`:

```json
{
	"applications": { "booked": 2, "declined": 1 },
	"loans": { "active": 2 },
	"avgDecisionSeconds": 12.5,
	"decidedApplications": 3,
	"recentFeed": [
		{
			"id": "<uuid>",
			"type": "loan.booked",
			"message": "...",
			"applicationId": "<uuid>",
			"loanId": "<uuid>",
			"occurredAt": "<iso>"
		}
	]
}
```

The feed holds the 20 most recent events from the portfolio read model.

## Policy

Officer only. All endpoints proxy to the policy service (`:4006`). Applicants
get 403 on every `/api/policy/*` route. The gateway applies a per-officer rate
limit (10/min, 429 `RATE_LIMITED`) and a 75 s upstream timeout.

| Method and path                                  | Purpose                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| `POST /api/policy/ask`                           | Cited answer from the approved policy corpus (navigator)          |
| `GET /api/policy/sections/:versionId/:sectionId` | One approved section for the citation drawer (`?token=` required) |
| `POST /api/policy/versions/:id/submit`           | Submit a draft version for approval (policy admin only)           |
| `POST /api/policy/versions/:id/approve`          | Approve a submitted version (policy admin only, no self-approval) |
| `POST /api/policy/versions/:id/retire`           | Retire an approved version (policy admin only)                    |

Ask body:

```json
{
	"question": "What is the minimum DSCR for an SME term loan?",
	"product": "sme_term_loan",
	"jurisdiction": "SG"
}
```

`product` is `personal_loan` or `sme_term_loan`; `jurisdiction` is an optional
two-letter code (defaults to `SG`). Success `200` carries `status`
(`succeeded`, `no_match`, `out_of_scope`, `identifier_blocked`,
`budget_exceeded`, `failed`, `needs_policy_owner`), `segments`, `citations`
(section id + version id + verifiable quote, never PII), and `limitations`.
Questions containing direct identifiers are refused as `identifier_blocked`
without logging the question text.

Rules:

- Feature disabled (`POLICY_ASSIST_ENABLED=false`): every policy route returns 503 `POLICY_DISABLED` and the UI hides.
- Section reads need the signed `?token=` issued with a citation; bad tokens, drafts, and out-of-range versions return 404 `NOT_FOUND`.
- Version writes need a policy admin (`policy_owner` with a case grant, or `compliance`): other officers get 403. `submit` on a non-draft returns 409 `NOT_DRAFT`; `approve` needs a prior `submit` (409 `NOT_SUBMITTED`), rejects self-approval (403 `SELF_APPROVAL`) and backdated `effectiveFrom` (422 `BACKDATED`).

The automatic case-policy review has no officer route: when `POLICY_ASSIST_ENABLED=true`,
research calls `POST /internal/policy/explain-case` server-side and accepted
citations appear in the case page Policy review section.

## Case assist (EN-01/02/03, EN-08 / E4)

Officer only. Every `/api/assist/*` route proxies to the applications service.
`ASSIST_ENABLED=false` makes every officer-facing assist route return 404;
the service-only internal hold/retention routes stay available. Applicants
get 403; a case actively assigned to another officer is a non-leaking 404.

| Method and path                             | Purpose                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GET /api/assist/cases/:id/evidence`        | EN-01 bundle: stable `sourceRef`s, source types, retention/legal hold, typed `unavailable`                    |
| `POST /api/assist/cases/:id/memos`          | Draft memo from the bundle (pending_review only); 201 fresh, 200 replay on identical evidence                 |
| `POST /api/assist/cases/:id/adverse-action` | EN-08 / E4 deterministic adverse-action letter from the terminal decline (declined only)                      |
| `POST /api/assist/cases/:id/artifacts`      | Validate and create a generic artifact (`credit_memo`, `policy_exception_memo`)                               |
| `GET /api/assist/cases/:id/artifacts?type=` | Version history for a case                                                                                    |
| `GET /api/assist/artifacts/:id`             | Artifact + content + citations                                                                                |
| `PATCH /api/assist/artifacts/:id`           | Edit a draft in place (revision compare-and-set); editing an approved artifact creates the next draft version |
| `POST /api/assist/artifacts/:id/approve`    | Explicit approval (`confirm: true`); re-validates citations, supersedes the prior approved version            |
| `POST /api/assist/artifacts/:id/tombstone`  | Soft delete (row retained; audited)                                                                           |

Artifact bodies are type-specific and strict. Validation failure returns `422`
`GENERATED_TEXT_INVALID` with typed `issues` (`SCHEMA_INVALID`,
`UNSUPPORTED_CLAIM`, `CITATION_*`, `DECISION_LANGUAGE`, `PII_DETECTED`,
`PROTECTED_ATTRIBUTE`, `FAIR_LENDING_PROXY`, `INTERNAL_REFERENCE`); nothing is persisted. Revision mismatch returns `409`
`VERSION_CONFLICT`, a live draft already exists `409` `DRAFT_EXISTS`, and a
terminal artifact `409` `ARTIFACT_IMMUTABLE`.

### Adverse action (EN-08 / E4)

Officer only. `POST /api/assist/cases/:id/adverse-action` builds a
deterministic adverse-action letter from the terminal declined decision: 3-4
principal reasons selected from the decision reason codes via the EN-08
taxonomy, each cited to decision-reason evidence. The case must be
`declined`; anything else returns 409 `CASE_NOT_DECLINED`. Success persists
an `adverse_action_letter` draft artifact and returns `201`:

```json
{
	"artifact": { "id": "<uuid>", "version": 1 },
	"principalReasons": [{ "code": "SCORE_TOO_LOW", "category": "...", "text": "..." }],
	"droppedReasonCodes": ["SECTOR_RISK"],
	"decisionId": "<uuid>",
	"jurisdiction": "SG",
	"profileVersion": "sg-feat-v2"
}
```

Artifact content: `title`, `applicantName`, `decisionId`, `jurisdiction`,
`profileVersion`, `decision`, `principalReasons[]` (`code`, `text`,
`citations`), `notices[]`, `contactPath`, `openItems`. `title` and `notices`
must match the profile exactly; `contactPath` must match
`ASSIST_ADVERSE_CONTACT_PATH`.

Fail-closed errors: `CASE_NOT_DECLINED` 409 (case or decision not declined),
`JURISDICTION_UNSUPPORTED` 409 (configured jurisdiction has no profile),
`DISCLOSURE_UNAVAILABLE` 422 (profile not approved or contact path missing),
`NEEDS_OFFICER_INPUT` 422 (unmapped/insufficient reason codes, missing
applicant name), `FAIR_LENDING_BLOCKED` 422 (deny-list or proxy hit on inputs),
`ADVERSE_PROFILE_INVALID` 422 (edit/approve drifts off the jurisdiction
profile, title, or notices), `ADVERSE_DECISION_MISMATCH` 422 (edit/approve
changes `decisionId`, invents a reason outside the decision, rewrites the
approved reason text, cites a different decision reason, or changes the contact
path; issue codes include `DECISION_ID_MISMATCH`,
`REASON_CODE_NOT_IN_DECISION`, `REASON_TEXT_MISMATCH`,
`CITATION_NOT_DECISION_REASON`, `CONTACT_PATH_MISMATCH`). Generic
`POST /api/assist/cases/:id/artifacts` no longer creates
`adverse_action_letter` — it returns 422 `DEDICATED_ROUTE_REQUIRED`. Edits and
approval still go through the existing artifact routes (`PATCH`, `/approve`);
both re-run the profile and decision binding, approved letters are immutable,
and edits create a new version. Generation-blocked fair-lending hits write an
`artifact.generate_blocked` audit row; edit/approve blocks write
`artifact.edit_blocked` / `artifact.approve_blocked`.

### Credit memo (agentic writer)

Officer only. `POST /api/assist/cases/:id/memos` assembles the EN-01 bundle
and drafts a `credit_memo` with the configured writer (`ASSIST_MEMO_WRITER`,
default `deterministic`; `agent` runs the bounded tool loop). The case must
be `pending_review`; anything else returns 409 `CASE_NOT_PENDING`. Success
persists a draft artifact and returns `201 { artifact }`. Identical evidence
replays the newest non-deleted memo instead of regenerating: `200
{ artifact, replayed: true }`. Edits preserve the generated trace; evidence
changes create a new version.

The artifact carries `agentTrace` (null for artifacts written before trace
persistence) and `evidenceHash`:

```json
{
	"artifact": {
		"id": "<uuid>",
		"version": 1,
		"evidenceHash": "<sha256-hex>",
		"agentTrace": {
			"writer": "agent",
			"agentVersion": "memo-agent-v1",
			"model": "deepseek/deepseek-v4.1-flash-1017",
			"promptVersion": "memo-agent-v1",
			"evidenceHash": "<sha256-hex>",
			"steps": 3,
			"toolCalls": [
				{ "step": 1, "name": "search_evidence", "resultCount": 4, "sourceTypes": ["score_reason"] }
			],
			"sourceRefs": ["score_reason:<id>:AMOUNT_ABOVE_AUTO_LIMIT"],
			"repairAttempted": false,
			"repairSucceeded": null,
			"fallbackReason": null,
			"inputTokens": 1200,
			"outputTokens": 800,
			"latencyMs": 2310
		}
	}
}
```

Fail-closed agent errors: `MEMO_AGENT_TIMEOUT` 504 (loop deadline hit),
`MEMO_AGENT_UNAVAILABLE` 502 (model error) or 503 (no key configured —
`ASSIST_MEMO_WRITER=agent` without `OPENROUTER_API_KEY` fails here),
`MEMO_AGENT_BUDGET` 422 (step, tool-call, or cost budget exceeded),
`MEMO_AGENT_INVALID` 422 (output failed validation after the repair
attempt; nothing persisted).

Internal service-only routes: `POST /internal/assist/artifacts/:id/holds`,
`POST /internal/assist/artifacts/:id/holds/:holdId/release`, and
`POST /internal/assist/retention/run`. These stay available while the
officer-facing flag is off so legal holds can be recorded and retention still
runs; they require the signed `service` identity.

## Health

| Method and path   | Access | Purpose                              |
| ----------------- | ------ | ------------------------------------ |
| `GET /api/health` | Public | Gateway and downstream service state |

Response `200`:

```json
{
	"status": "ok",
	"checks": {
		"db": { "ok": true },
		"kafka": { "ok": true },
		"temporal": { "ok": true },
		"outbox": { "backlog": 0, "deadLettered": 0 }
	},
	"services": {
		"applications": { "ok": true },
		"review": { "ok": true },
		"loans": { "ok": true },
		"portfolio": { "ok": true }
	}
}
```

`status` is `ok` only when gateway `db`, `kafka`, and `temporal` checks pass. Otherwise it is `degraded`. The `services` map is informational. It never flips the top-level status.

## Error codes

| Code                       | Status   | Meaning                                                                                                                                                                                      |
| -------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNAUTHENTICATED`          | 401      | Missing or invalid session; bad internal signature                                                                                                                                           |
| `INVALID_CREDENTIALS`      | 401      | Wrong email or password                                                                                                                                                                      |
| `FORBIDDEN`                | 403      | Wrong role for this endpoint                                                                                                                                                                 |
| `ORIGIN_FORBIDDEN`         | 403      | Production origin check failed                                                                                                                                                               |
| `DEMO_MODE_DISABLED`       | 403      | Demo endpoint called with `DEMO_MODE=false`                                                                                                                                                  |
| `NOT_FOUND`                | 404      | Missing row, bad uuid, or cross-applicant read                                                                                                                                               |
| `VALIDATION_ERROR`         | 400, 422 | Bad body: 400 on auth/submit/pay/age, 422 on review decisions                                                                                                                                |
| `INVALID_JSON`             | 400      | Body is not JSON                                                                                                                                                                             |
| `MISSING_IDEMPOTENCY_KEY`  | 400      | Submit without `Idempotency-Key`                                                                                                                                                             |
| `INVALID_CURSOR`           | 400      | Cursor is not `<ISO-8601>,<uuid>`                                                                                                                                                            |
| `BODY_TOO_LARGE`           | 413      | Body over 100,000 bytes                                                                                                                                                                      |
| `RATE_LIMITED`             | 429      | Login or submit limit hit                                                                                                                                                                    |
| `IDEMPOTENCY_CONFLICT`     | 409      | Key reused with a different payload                                                                                                                                                          |
| `TOO_MANY_APPLICATIONS`    | 409      | 3 non-terminal applications already                                                                                                                                                          |
| `DRAFT_REQUIRED`           | 409      | Profiled applicant used direct create; use draft → submit                                                                                                                                    |
| `TOO_MANY_DRAFTS`          | 409      | 3 active drafts already                                                                                                                                                                      |
| `NOT_DRAFT`                | 409      | Submit called on a non-draft application                                                                                                                                                     |
| `REQUIREMENTS_INCOMPLETE`  | 409      | Draft has hard blockers; `fields` maps `field:<path>` / `document:<kind>` to reason codes (`required\|stale\|expired\|unknown_date\|rejected\|missing\|consent\|identity_mismatch\|invalid`) |
| `DECISION_CONFLICT`        | 409      | Case already decided with another request                                                                                                                                                    |
| `BOOKING_INCOMPLETE`       | 409      | Approved decision not yet booked; saga still converging                                                                                                                                      |
| `CASE_NOT_PENDING`         | 409      | Case is not awaiting a decision                                                                                                                                                              |
| `CASE_NOT_RUNNING`         | 409      | Workflow is not running                                                                                                                                                                      |
| `DECISION_REJECTED`        | 422      | Workflow rejected the decision terms                                                                                                                                                         |
| `CONSENT_REQUIRED`         | 403      | AI research consent missing                                                                                                                                                                  |
| `RESEARCH_DISABLED`        | 404      | Agentic research feature flag off                                                                                                                                                            |
| `POLICY_DISABLED`          | 503      | Policy assist flag off; retry with the flag on or decide without policy                                                                                                                      |
| `RUN_NOT_SUCCEEDED`        | 409      | Finding reviewed before its run succeeded                                                                                                                                                    |
| `RESEARCH_UNAVAILABLE`     | 503      | Research bundle unfetchable; retry or decide without research                                                                                                                                |
| `RESEARCH_SELECTION_STALE` | 409      | Selection no longer resolves; re-review or decide without                                                                                                                                    |
| `ALREADY_PAID`             | 409      | Installment is already paid                                                                                                                                                                  |
| `MEMO_AGENT_TIMEOUT`       | 504      | Memo tool loop hit its deadline; retry or decide without a memo                                                                                                                              |
| `MEMO_AGENT_UNAVAILABLE`   | 502, 503 | Memo model error (502), or agent writer with no key (503); retry or decide without                                                                                                           |
| `MEMO_AGENT_BUDGET`        | 422      | Memo step, tool-call, or cost budget exceeded                                                                                                                                                |
| `MEMO_AGENT_INVALID`       | 422      | Memo output failed validation after repair; nothing persisted                                                                                                                                |
| `ALERT_NOT_OPEN`           | 409      | Alert is not open                                                                                                                                                                            |
| `BAD_GATEWAY`              | 502      | Downstream service or lookup failed                                                                                                                                                          |
| `DECISION_FAILED`          | 500      | Officer decision failed                                                                                                                                                                      |
| `INTERNAL_ERROR`           | 500      | Unhandled error                                                                                                                                                                              |

## Curl examples

Log in once and keep the cookie. Use a fresh `Idempotency-Key` per submit (`<uuid>` below is a placeholder; generate one per call).

```bash
BASE=http://127.0.0.1:3001
curl -s -c jar.txt -H 'content-type: application/json' \
  -d '{"email":"maria@example.com","password":"demo1234"}' \
  $BASE/api/auth/login
curl -s -b jar.txt $BASE/api/auth/me
```

Submit an application:

```bash
curl -s -b jar.txt -H 'content-type: application/json' \
  -H "Idempotency-Key: <uuid>" \
  -d '{"type":"individual","product":"personal_loan","amountCents":1200000,"termMonths":48,"purpose":"Home renovation","consents":[true,true,true],"identity":{"fullName":"Maria Demo","dob":"1990-05-14","nationalId":"MARIA42C1","email":"maria@example.com","phone":"+1-555-0100","address":"1 Demo Street","city":"Demo City"},"individual":{"employmentStatus":"employed","employerName":"Acme Corp","employmentYears":6,"monthlyIncomeCents":420000,"existingDebtCents":61000,"bankRelationshipYears":3}}' \
  $BASE/api/applications
```

List with a cursor and read one case:

```bash
APP_ID=<application-uuid>
curl -s -b jar.txt "$BASE/api/applications?limit=20"
curl -s -b jar.txt "$BASE/api/applications/$APP_ID"
```

As an officer, read the queue and decide:

```bash
curl -s -c officer-jar.txt -H 'content-type: application/json' \
  -d '{"email":"officer@example.com","password":"demo1234"}' \
  $BASE/api/auth/login
curl -s -b officer-jar.txt $BASE/api/review/queue
curl -s -b officer-jar.txt -H 'content-type: application/json' \
  -d '{"requestId":"<uuid>","outcome":"approve","approvedAmountCents":5000000,"termMonths":60,"notes":"Counter-offer: reduced to $50,000 on current cash flow."}' \
  "$BASE/api/review/$APP_ID/decision"
```

Run monitoring and log out:

```bash
curl -s -b officer-jar.txt -H 'content-type: application/json' -d '{}' \
  $BASE/api/demo/monitoring/run
curl -s -b jar.txt -X POST $BASE/api/auth/logout
```

---

## Internal service contracts (internal, not public)

This section is for developers extending services. These endpoints are not public. Every call needs a valid HMAC signature built with `INTERNAL_SECRET`. Do not expose them to browsers or external clients.

The gateway signs the authenticated user identity. Services trust the signed headers and never read cookies.

Canonical string, signed with HMAC-SHA256 and `INTERNAL_SECRET` (hex digest):

```text
METHOD\nPATH\nUSER_ID\nEMAIL(lowercased)\nROLE\nTS
```

- `METHOD`: upper-cased HTTP method.
- `PATH`: exact pathname the receiving service sees, no query string.
- `USER_ID`, `EMAIL` (lowercased before signing), `ROLE` (`applicant`, `officer`, or `service`): the authenticated user or automation principal.
- `TS`: milliseconds since epoch. Clock skew limit is 5 minutes.

Headers on every internal call: `x-user-id`, `x-user-role`, `x-user-email`, `x-internal-ts`, `x-internal-signature`, `x-request-id`. Missing or bad signatures return 401. A valid signature with the wrong role returns 403. Service `/health` endpoints stay public for orchestrators; `/api/*` and `/internal/*` need the signature.

| Endpoint                                          | Service       | Called by       | Role                                                                                                                                                                                                                                              |
| ------------------------------------------------- | ------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /internal/review/queue`                      | Applications  | Review          | Officer                                                                                                                                                                                                                                           |
| `GET /internal/applications/:id/decision`         | Applications  | Review          | Officer                                                                                                                                                                                                                                           |
| `GET /internal/applications/:id/case-facts`       | Applications  | Review          | Officer                                                                                                                                                                                                                                           |
| `GET /internal/applications/:id/research-context` | Applications  | Automation      | Service only (officer/applicant 403)                                                                                                                                                                                                              |
| `GET .../applications/:id/context/*`              | Applications  | Research        | Service only (officer/applicant 403); bounded officer-screen reads for the context analyst (`profile`, `accounts`, `transactions`, `metrics`, `financials`, `document-findings`, `applicant`, `credit-history`, `external-reports`, `kyc-checks`) |
| `GET /internal/loans/by-applicant/:userId`        | Loans         | Research        | Service only; `?applicationId&asOf` bound to the calling case (consent + applicant + as-of-day match, fail closed), audited                                                                                                                       |
| `GET /internal/stats`                             | Applications  | Portfolio       | Officer                                                                                                                                                                                                                                           |
| `GET /internal/loans/by-application/:id`          | Loans         | Gateway, review | Signed user; owner or officer                                                                                                                                                                                                                     |
| `GET /internal/stats`                             | Loans         | Portfolio       | Officer                                                                                                                                                                                                                                           |
| `POST /internal/research/runs/ensure`             | Research      | Review          | Officer (claims the case; cross-officer 404)                                                                                                                                                                                                      |
| `GET /internal/research/applications/:id/latest`  | Research      | Review          | Officer with an active grant, else 404                                                                                                                                                                                                            |
| `POST .../runs/:runId/view`                       | Research      | Review          | Officer with an active grant, else 404                                                                                                                                                                                                            |
| `GET .../runs/:runId/bundle`                      | Research      | Review          | Officer with an active grant, else 404                                                                                                                                                                                                            |
| `POST .../findings/:findingId/review`             | Research      | Review          | Officer with an active grant, else 404                                                                                                                                                                                                            |
| `POST .../runs/:runId/context/retry`              | Research      | Review (D4)     | Officer with an active grant; 202 async, terminal failed/skipped stage only, max one retry, no external rerun                                                                                                                                     |
| `POST .../context/signals/:signalId/review`       | Research      | Review (D4)     | Officer with an active grant; 201 + updated signal, append-only; cross-case 404, superseded 409                                                                                                                                                   |
| `POST .../context/purge`                          | Research      | Applications    | Service only; supersedes signals + nulls stored briefs on terminal stages, audited `context.purge`                                                                                                                                                |
| `GET .../audit` (auto-trigger history)            | Research      | Review          | Officer (first caller claims; later 404)                                                                                                                                                                                                          |
| `POST .../access/grants`                          | Research      | Automation      | Service only (officer/applicant 403)                                                                                                                                                                                                              |
| `POST .../access/revoke`                          | Research      | Automation      | Service only (officer/applicant 403)                                                                                                                                                                                                              |
| `GET /health`                                     | Every service | Any             | Public                                                                                                                                                                                                                                            |

`GET /internal/applications/:id/decision` returns `{ "status", "decision": { "id", "outcome", "requestId" } | null }`. `GET /internal/loans/by-application/:id` returns the loan summary with installment counts and enforces the same owner-or-officer rule as the public loan routes (cross-applicant reads are 404). `GET /internal/loans/by-applicant/:userId` is the context-analyst read instead: `?applicationId` and `?asOf` (`YYYY-MM-DD`, not in the future) are both required, `asOf` must equal the calling case's as-of day, and the loans service revalidates context consent plus applicant ownership against the applications service before reading (fail closed, no loan query on binding failure). Consent/applicant denials are 403/404 and audit `context.denied`; success audits `context.read` — ids and codes only, never PII. The stats endpoints return status-count maps for the dashboard.

Research access management (T00): `POST .../access/grants` takes a strict `{ "userId": "<uuid>", "accessRole": "assigned_officer"|"compliance"|"policy_owner"|"safeguarding" }` body and returns `201 { "grant" }`; unknown roles or bad ids are 422. `POST .../access/revoke` takes `{ "userId": "<uuid>" }` and returns `200 { "revoked": true }`, or 404 when no active grant exists. Both audit the change. `GET /internal/applications/:id/research-context` (service only) returns `{ "caseFacts": {<the same 16 keys as case-facts>}, "applicantUserId": "<uuid>", "contextAnalysisConsent": <boolean> }`; `applicantUserId` is internal routing data and never enters the agent prompt or trace. Officer `/case-facts` behavior is unchanged.

## Related

- [Run and verify](../getting-started.md) — run the demo against these endpoints.
- [Configuration](configuration.md) — base URLs, ports, secrets.
- [Architecture](../explanation/architecture.md) — request flow and trust boundaries.
- [Lifecycle](../explanation/lifecycle.md) — status values in responses.
- [Data and events](data-and-events.md) — ids, topics, and payloads behind the API.
