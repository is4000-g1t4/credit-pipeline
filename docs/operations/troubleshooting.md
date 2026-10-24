# Troubleshooting

This page restores a broken stack. Audience: operators and developers with a local checkout. Outcome: each symptom maps to a check and a safe action.

Triage order: `docker compose ps`, then gateway health, then the failing service health, then Temporal UI on 8080, then logs.

## Gateway health

```powershell
curl http://127.0.0.1:3001/api/health
```

`status` is `ok` only when the gateway's own `db`, `kafka`, and `temporal` checks pass (1-second timeout each). The `services` map (applications, review, loans, portfolio) is informational and never flips the top-level status. `checks.outbox` aggregates backlog and dead-letter counts from the applications and loans health checks. Source: `apps/gateway/src/health.ts`.

## Symptom tables

### Startup and infrastructure

| Symptom                                           | Check                                                  | Action                                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Gateway `status: degraded`, `checks.db.ok: false` | `docker compose ps`; is postgres up?                   | `docker compose up -d --wait`; then `pnpm db:wait`                                                                            |
| `checks.kafka.ok: false`                          | Is the kafka container up?                             | `docker compose up -d --wait`; then `pnpm kafka:init`                                                                         |
| `checks.temporal.ok: false`                       | Is temporal up? Open UI on 8080                        | `docker compose up -d --wait`; restart the worker                                                                             |
| `services.<name>.ok: false`                       | `curl http://127.0.0.1:4001/health` (and 4002–4006)    | Start the missing service (`pnpm dev` or `pnpm dev:services`); review checks only temporal, portfolio checks db plus consumer |
| `consumer not connected` in portfolio health      | Kafka down or consumer retrying                        | Wait for the 1-second retry loop; check Kafka; read portfolio logs                                                            |
| Worker exits or acts strangely                    | Node version; Temporal supports 20/22/24, repo pins 26 | Try Node 24 LTS first                                                                                                         |

### Auth and request errors

| Symptom                                           | Check                                                                 | Action                                                                          |
| ------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 401 `UNAUTHENTICATED` on `/api/*`                 | Session cookie missing, expired (7 days), or `SESSION_SECRET` changed | Log in again at http://localhost:3000                                           |
| 401 `INVALID_CREDENTIALS` on login                | Wrong email or password                                               | Seed users take password `demo1234`; re-run `pnpm db:seed` if users are missing |
| 429 `RATE_LIMITED` on login                       | More than 10 logins per minute per email, or 30 per minute per IP     | Wait one minute; limits are in-memory per process                               |
| 429 on submit                                     | More than 5 submits per minute per user                               | Wait one minute                                                                 |
| 401 `invalid internal signature` between services | `INTERNAL_SECRET` differs between gateway and services                | Set one identical `INTERNAL_SECRET` everywhere and restart                      |
| 403 `FORBIDDEN` on officer routes                 | Signed-in user is an applicant                                        | Log in as `officer@example.com`                                                 |
| 403 `DEMO_MODE_DISABLED`                          | `DEMO_MODE=false`                                                     | Set `DEMO_MODE=true` and restart gateway and loans                              |
| 403 `ORIGIN_FORBIDDEN`                            | Production origin check; `Origin` must equal `WEB_ORIGIN`             | Fix `WEB_ORIGIN` or call same-origin through the web proxy                      |
| 413 `BODY_TOO_LARGE`                              | Body over 100,000 bytes on `/api/*`                                   | Shrink the payload                                                              |
| 404 on another applicant's case or loan           | Cross-applicant reads return 404 by design                            | Use the owning applicant or an officer account                                  |

### Application and decision errors

| Symptom                                        | Check                                                          | Action                                                                                                                                                                                                               |
| ---------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400 `MISSING_IDEMPOTENCY_KEY` on submit        | `Idempotency-Key` header absent                                | Send a unique key per new application; reuse the key for retries                                                                                                                                                     |
| 409 `IDEMPOTENCY_CONFLICT`                     | Same key, different body                                       | Reuse the original body, or use a new key for a new application                                                                                                                                                      |
| 409 `TOO_MANY_APPLICATIONS`                    | Applicant holds 3 non-terminal cases                           | Decide or reset; for a demo, run the full reset below                                                                                                                                                                |
| 409 `DECISION_CONFLICT` or `CASE_NOT_PENDING`  | Case already decided, or not in `pending_review`               | Re-read the case; replay with the same `requestId` to get the original result                                                                                                                                        |
| 409 `BOOKING_INCOMPLETE` on decision replay    | Approved but not yet booked; saga still converging             | Retry later with the same `requestId`; the reconciler repairs it only after the workflow has ended and the case is 15 min stale. Reloading the panel creates a new `requestId` and then returns `DECISION_CONFLICT`. |
| 422 `DECISION_REJECTED`                        | Terms breach amount, term, DTI, or DSCR rules                  | Lower the amount, fix the term (12–60), and re-send                                                                                                                                                                  |
| 502 `BAD_GATEWAY` on detail or dashboard       | A downstream service or lookup failed                          | Check the `services` map and the failing service health; restart it                                                                                                                                                  |
| Case stuck in `submitted`                      | Worker not running, or workflow never started                  | Start the worker; the reconciler starts unstarted cases within ~30 s                                                                                                                                                 |
| Case stuck in `processing` or `pending_review` | Workflow ended without a decision, or booking still converging | An undecided case fails or expires within ~15 min of inactivity; an approved-but-unbooked case is repaired (never failed) — check Temporal UI                                                                        |
| Review queue looks empty right after a refer   | The case was decided between reads                             | Re-read the case status before deciding                                                                                                                                                                              |

### Outbox, feed, and monitoring

| Symptom                                | Check                                            | Action                                                                                               |
| -------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Outbox `backlog` grows                 | Kafka down, or relay failing                     | Restore Kafka; the relay resumes in `seq` order                                                      |
| Outbox `deadLettered` grows            | A row failed 10 times                            | Read `last_error` in `outbox_events`; fix the cause; re-insert if needed                             |
| Dashboard feed is empty                | Consumer not connected, or events not published  | Check portfolio health `consumer`; check outbox backlog; run `pnpm kafka:init` if topics are missing |
| Monitoring returns 202 `{workflowId}`  | Normal: the run exceeded 30 s                    | Wait and re-read loans and alerts; the workflow finishes in the background                           |
| No `payment_overdue` alert after aging | Monitoring has not run, or installments are paid | Call age (it runs monitoring), or run monitoring directly                                            |
| 409 `ALREADY_PAID` on pay              | Installment is already paid                      | Read the loan; pay the next unpaid installment                                                       |
| 409 `ALERT_NOT_OPEN` on acknowledge    | Alert is acknowledged or closed                  | Read the alerts list; only `open` alerts can be acknowledged                                         |

### Local environment

| Symptom                                              | Check                                                                                   | Action                                                                                                                |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Port 3000, 3001, or 4001–4006 already in use         | `Get-NetTCPConnection -LocalPort 3000,3001,4001,4002,4003,4004,4005,4006 -State Listen` | Stop only that PID. Never `Stop-Process -Name node`; it kills unrelated tooling                                       |
| Stale demo state (piled-up cases, half-run demo)     | Non-terminal count per applicant                                                        | Full reset: `docker compose down -v`, `docker compose up -d --wait`, `pnpm setup`                                     |
| Postgres 17 volume fails on Postgres 18              | Old volume layout                                                                       | One-time reset: `docker compose down`, `docker volume rm project_pgdata`, `docker compose up -d --wait`, `pnpm setup` |
| `pnpm test` hits EPERM on Windows                    | Stale `node_modules/.vitest-cache` after a container install                            | Delete `node_modules/.vitest-cache` and re-run                                                                        |
| Playwright browsers missing                          | `e2e` fails to launch chromium                                                          | `pnpm exec playwright install chromium`                                                                               |
| KafkaJS `TimeoutNegativeWarning` on Node 26          | Benign                                                                                  | Ignore; topics still create                                                                                           |
| dotenv `injected env` line                           | Benign                                                                                  | Ignore                                                                                                                |
| Temporal test-server heartbeat warning in unit tests | Benign, tests only                                                                      | Ignore                                                                                                                |

## Compose overlay

The overlay runs the backend in containers under the `microservices` profile:

```powershell
docker compose -f docker-compose.yml -f compose.services.yml --profile microservices up -d --wait
docker compose -f docker-compose.yml -f compose.services.yml --profile microservices down
```

Notes: `down` stops the base infra too. The web app stays local (`pnpm --filter @credit/web dev`). A container install can leave a stale Windows `node_modules/.vitest-cache`; delete it if tests hit EPERM.

## What not to do

- Do not stop all Node processes to clear a port. Stop only the listener PID.
- Do not assume `down` keeps infra. It stops postgres, kafka, and temporal too.
- Do not treat mock bureau, bank, score, or policy data as real providers. All demo data is synthetic.
- Do not use real personal data. The demo is synthetic only.

## Related

- [Getting started](../getting-started.md) — clean run and verification
- [Configuration](../reference/configuration.md) — ports, secrets, demo mode
- [Architecture](../explanation/architecture.md) — failure domains
- [Lifecycle](../explanation/lifecycle.md) — stuck cases and expiry
