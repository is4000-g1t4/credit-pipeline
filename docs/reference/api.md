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

| Method and path             | Access    | Purpose                                             |
| --------------------------- | --------- | --------------------------------------------------- |
| `POST /api/applications`    | Applicant | Submit an application (needs `Idempotency-Key`)     |
| `GET /api/applications`     | User      | List applications, newest first, cursor pages       |
| `GET /api/applications/:id` | User      | Full case detail; gateway composes the `loan` block |

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
		"address": "1 Demo Street"
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

Officer only. Both endpoints proxy to the review service.

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

| Code                      | Status   | Meaning                                                       |
| ------------------------- | -------- | ------------------------------------------------------------- |
| `UNAUTHENTICATED`         | 401      | Missing or invalid session; bad internal signature            |
| `INVALID_CREDENTIALS`     | 401      | Wrong email or password                                       |
| `FORBIDDEN`               | 403      | Wrong role for this endpoint                                  |
| `ORIGIN_FORBIDDEN`        | 403      | Production origin check failed                                |
| `DEMO_MODE_DISABLED`      | 403      | Demo endpoint called with `DEMO_MODE=false`                   |
| `NOT_FOUND`               | 404      | Missing row, bad uuid, or cross-applicant read                |
| `VALIDATION_ERROR`        | 400, 422 | Bad body: 400 on auth/submit/pay/age, 422 on review decisions |
| `INVALID_JSON`            | 400      | Body is not JSON                                              |
| `MISSING_IDEMPOTENCY_KEY` | 400      | Submit without `Idempotency-Key`                              |
| `INVALID_CURSOR`          | 400      | Cursor is not `<ISO-8601>,<uuid>`                             |
| `BODY_TOO_LARGE`          | 413      | Body over 100,000 bytes                                       |
| `RATE_LIMITED`            | 429      | Login or submit limit hit                                     |
| `IDEMPOTENCY_CONFLICT`    | 409      | Key reused with a different payload                           |
| `TOO_MANY_APPLICATIONS`   | 409      | 3 non-terminal applications already                           |
| `DECISION_CONFLICT`       | 409      | Case already decided with another request                     |
| `BOOKING_INCOMPLETE`      | 409      | Approved decision not yet booked; saga still converging       |
| `CASE_NOT_PENDING`        | 409      | Case is not awaiting a decision                               |
| `CASE_NOT_RUNNING`        | 409      | Workflow is not running                                       |
| `DECISION_REJECTED`       | 422      | Workflow rejected the decision terms                          |
| `ALREADY_PAID`            | 409      | Installment is already paid                                   |
| `ALERT_NOT_OPEN`          | 409      | Alert is not open                                             |
| `BAD_GATEWAY`             | 502      | Downstream service or lookup failed                           |
| `DECISION_FAILED`         | 500      | Officer decision failed                                       |
| `INTERNAL_ERROR`          | 500      | Unhandled error                                               |

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
  -d '{"type":"individual","product":"personal_loan","amountCents":1200000,"termMonths":48,"purpose":"Home renovation","consents":[true,true,true],"identity":{"fullName":"Maria Demo","dob":"1990-05-14","nationalId":"MARIA42C1","email":"maria@example.com","phone":"+1-555-0100","address":"1 Demo Street"},"individual":{"employmentStatus":"employed","employerName":"Acme Corp","employmentYears":6,"monthlyIncomeCents":420000,"existingDebtCents":61000,"bankRelationshipYears":3}}' \
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
- `USER_ID`, `EMAIL` (lowercased before signing), `ROLE` (`applicant` or `officer`): the authenticated user.
- `TS`: milliseconds since epoch. Clock skew limit is 5 minutes.

Headers on every internal call: `x-user-id`, `x-user-role`, `x-user-email`, `x-internal-ts`, `x-internal-signature`, `x-request-id`. Missing or bad signatures return 401. A valid signature with the wrong role returns 403. Service `/health` endpoints stay public for orchestrators; `/api/*` and `/internal/*` need the signature.

| Endpoint                                  | Service       | Called by       | Role                          |
| ----------------------------------------- | ------------- | --------------- | ----------------------------- |
| `GET /internal/review/queue`              | Applications  | Review          | Officer                       |
| `GET /internal/applications/:id/decision` | Applications  | Review          | Officer                       |
| `GET /internal/stats`                     | Applications  | Portfolio       | Officer                       |
| `GET /internal/loans/by-application/:id`  | Loans         | Gateway, review | Signed user; owner or officer |
| `GET /internal/stats`                     | Loans         | Portfolio       | Officer                       |
| `GET /health`                             | Every service | Any             | Public                        |

`GET /internal/applications/:id/decision` returns `{ "status", "decision": { "id", "outcome", "requestId" } | null }`. `GET /internal/loans/by-application/:id` returns the loan summary with installment counts and enforces the same owner-or-officer rule as the public loan routes (cross-applicant reads are 404). The stats endpoints return status-count maps for the dashboard.

## Related

- [Run and verify](../getting-started.md) — run the demo against these endpoints.
- [Configuration](configuration.md) — base URLs, ports, secrets.
- [Architecture](../explanation/architecture.md) — request flow and trust boundaries.
- [Lifecycle](../explanation/lifecycle.md) — status values in responses.
- [Data and events](data-and-events.md) — ids, topics, and payloads behind the API.
