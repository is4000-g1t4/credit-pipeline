# Creditworthiness Pipeline — Phase 1

Docs: [docs/index.md](docs/index.md).

End-to-end credit pipeline: apply → verify → gather data → score → policy
decision → human review → price & book → monitor. Traditional pipeline only:
deterministic mocks throughout (labelled "Mock data" in the UI), no LLM or
real providers. Architecture: [docs/explanation/architecture.md](docs/explanation/architecture.md).

## Prereqs

- Node ≥ 22 (`.nvmrc` pins 26.9.0 — the worker runs on Node 26; see the
  Temporal caveat below)
- Bun 1.4.4 (API/gateway/services, web build, and root `db:*`/`kafka:*`/`demo:*` scripts)
- pnpm 12 (`packageManager` pins 12.11.2)
- Docker Desktop (Compose v2)

## Quickstart

```powershell
cp .env.example .env   # then set a real SESSION_SECRET
pnpm install                    # non-interactive; build scripts pre-approved in pnpm-workspace.yaml (allowBuilds)
docker compose up -d --wait     # postgres, kafka, temporal, temporal-ui
pnpm setup                      # db:wait -> db:init -> kafka:init -> db:migrate -> db:seed
pnpm dev                        # gateway :3001 + services :4001-4004 + worker + web :3000 in parallel
```

Then open http://localhost:3000 and log in (password `demo1234`, see table).
Health: `GET http://127.0.0.1:3001/api/health` → `{status:"ok"}` with
db/kafka/temporal up.

## Seed users (password `demo1234`, no signup)

| Email                        | Role      | Demo path                                        |
| ---------------------------- | --------- | ------------------------------------------------ |
| `maria@example.com`          | applicant | auto-approve ($12k/48m → booked, 777/A)          |
| `alex@example.com`           | applicant | refer → officer declines                         |
| `sam@example.com`            | applicant | auto-decline (`SCORE_TOO_LOW`)                   |
| `tomas@cafe-aurora.example`  | applicant | SME refer → officer counter-offers $50k → booked |
| `lena@bakery.example`        | applicant | SME auto-approve                                 |
| `officer@example.com`        | officer   | review queue, decisions, demo controls           |
| `senior.officer@example.com` | officer   | same                                             |

## Demo click-through (as a grader would run it)

Start from a clean DB for the canonical run (`docker compose down -v`,
then the quickstart above). Each application page polls every 2s until the
status is terminal.

1. **Maria auto path.** Login `maria@example.com` → New application →
   individual, **$12,000 / 48m**, identity (any valid values; email must stay
   `maria@example.com`), employed 6y, income $4,200/mo, debts $610/mo,
   relationship 3y → consent ×3 → submit. The application page shows
   processing, then **booked** with **Score 777 / grade A**. Open the loan:
   48 installments, next due date, no alerts.
2. **Tomás refer path.** Login `tomas@cafe-aurora.example` → New
   application → SME, **$60,000 / 60m**, Café Aurora, hospitality, 4 years,
   9 employees, revenue $610,000, FCF $3,800/mo, debt service $300/mo →
   submit. Status becomes **pending_review** with `AMOUNT_ABOVE_AUTO_LIMIT` +
   `SECTOR_REVIEW` (+ score band) reasons. Login `officer@example.com` →
   Review queue → open the case (it stays queued until decided) → approve at
   **$50,000 / 60m** with a note → **booked** at $50,000; the case page shows
   the officer terms.
3. **Sam decline path.** Login `sam@example.com` → New application →
   individual, **$10,000 / 36m**, employed 1y, income $2,800/mo, debts
   $950/mo → submit. Status becomes **declined** with `SCORE_TOO_LOW` plus
   negative factors; no officer step, no loan.
4. **Monitoring demo** (officer, on Tomás's loan). Open the loan → Demo
   controls → Age **40 days** → Run monitoring → a `payment_overdue` alert
   appears → Acknowledge → Pay next installment → a payment shows and no
   alert stays open.

Headless equivalents: `pnpm demo:check` (full three-scenario HTTP smoke),
`pnpm demo:monitor` (one monitoring run), `pnpm test:e2e` (Playwright,
starts its own worker/gateway/services/web and stops them afterwards).

## Command reference

| Command                                           | What it does                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `pnpm dev`                                        | gateway + 4 services + worker + web in parallel                                            |
| `pnpm dev:services`                               | gateway + 4 services (no worker/web)                                                       |
| `pnpm typecheck`                                  | `tsc --noEmit` in every package + `scripts/` + `e2e/`                                      |
| `pnpm lint` / `pnpm format` / `pnpm format:check` | `oxlint` / `oxfmt .` / `oxfmt --check .`                                                   |
| `pnpm test`                                       | unit tests, compose-free (core 77 ? db 9 ? service-kit 6 ? gateway 5 ? worker 27 = 124)    |
| `pnpm test:integration`                           | gateway (14) + services (6+4+5+5) + worker (8) integration = 42, needs compose             |
| `pnpm test:e2e`                                   | Playwright (4 specs), boots worker/gateway/services/web itself, needs compose              |
| `pnpm demo:check`                                 | scripted HTTP smoke (Maria/Sam/Tomás + monitoring/pay), needs the stack                    |
| `pnpm demo:monitor`                               | officer login + `POST /demo/monitoring/run`, prints counts                                 |
| `pnpm db:wait`                                    | polls `pg_isready` in the postgres container (timeout `DB_WAIT_TIMEOUT_S`, default 120)    |
| `pnpm db:init`                                    | creates the 4 service DBs (+ Temporal pair) if missing — self-provisions existing clusters |
| `pnpm kafka:init`                                 | creates the 7 SPEC FR-10.1 topics (3 partitions, RF 1), idempotent                         |
| `pnpm setup`                                      | `db:wait && db:init && kafka:init && db:migrate && db:seed`                                |
| `pnpm build`                                      | recursive `--if-present` build                                                             |

## Ports & env

| Service        | Port | Notes                                                                                                                                                                                                               |
| -------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| web (Vite)     | 3000 | proxies `/api` → `127.0.0.1:3001`                                                                                                                                                                                   |
| gateway (Hono) | 3001 | binds `API_HOST` (default 127.0.0.1); `GET /api/health` → `{status:"ok"}` + `services` map                                                                                                                          |
| postgres 18    | 5432 | one cluster, four databases: `credit_auth` (gateway) · `credit_applications` · `credit_loans` · `credit_portfolio`; init SQL creates all six (+ `temporal` pair); volume mounts `/var/lib/postgresql` (PG18 layout) |
| kafka (KRaft)  | 9092 | host listener; internal `kafka:29092` for future in-compose clients                                                                                                                                                 |
| temporal       | 7233 | auto-setup against the postgres service                                                                                                                                                                             |
| temporal-ui    | 8080 | pointed at `temporal:7233`                                                                                                                                                                                          |
| applications   | 4001 | P1a microservice: intake + case detail (no loan block)                                                                                                                                                              |
| review         | 4002 | stateless: queue + officer decisions (no DB)                                                                                                                                                                        |
| loans          | 4003 | P1a microservice: loans, alerts, demo controls, internal loan lookup                                                                                                                                                |
| portfolio      | 4004 | dashboard summary + Kafka consumer                                                                                                                                                                                  |

Environment files are loaded explicitly ? Bun's dev scripts pass
`--env-file=../../.env`, Node (worker/tests) uses `dotenv` ? and validated by
**t3-env** (`@t3-oss/env-core`) with per-app zod schemas, so a missing or
invalid variable fails fast at boot. Bun does auto-load `.env` from its cwd,
but services run with cwd=`apps/<name>`, hence the explicit root path.
`scripts/*` run with cwd = root under Bun. Never commit `.env` (gitignored).
The gateway reads `APPLICATIONS_URL`/`REVIEW_URL`/`LOANS_URL`/`PORTFOLIO_URL`
(defaulting to `http://127.0.0.1:4001`?`:4004`) plus `INTERNAL_SECRET` for
signing downstream requests; `compose.services.yml` overrides the URLs for
container networking (`http://applications:4001`, ?).
a crashed run can leave a stale server behind. Find it with
`Get-NetTCPConnection -LocalPort 3000,3001,4001,4002,4003,4004 -State Listen` and stop that
PID only — never `Stop-Process -Name node` (that kills unrelated tooling).

- **Full reset.** `docker compose down -v` wipes DB + Kafka, then re-run the
  quickstart (`up -d --wait` → `setup`). Needed when non-terminal
  applications pile up (at most 3 per applicant; the 4th submit is 409) or
  after a half-finished demo run.
- **Postgres 17 → 18 one-time reset (P2).** A PG17 volume cannot be opened
  by PG18, and PG18 additionally requires the volume at
  `/var/lib/postgresql` (not `…/data`) — so the upgrade is a volume reset:
  `docker compose down`, `docker volume rm project_pgdata`, `docker compose
  up -d --wait`, `pnpm setup`. Fresh volumes self-provision via
  `infra/postgres/init.sql`; existing clusters self-provision via `pnpm
  db:init` (creates the four service DBs if missing).
- **Benign warnings.** KafkaJS on Node 26 prints a harmless
  `TimeoutNegativeWarning` from its internal `requestQueue` (clamped to 1ms);
  dotenv prints a `◇ injected env` line on import; Temporal SDK warns that
  the test server lacks `activity_failure_include_heartbeat` (unit tests
  only). All safe to ignore.
- **Windows notes.** Use PowerShell (`cp` here means `Copy-Item`; there is no
  `head`/`tail`/`sed` — use `Select-Object`). spawning `.cmd` shims needs a
  shell; the E2E setup/teardown already handles that.
- **Playwright browsers.** `pnpm exec playwright install chromium` (one-off;
  cached under `%LOCALAPPDATA%\ms-playwright`).
- **Queue looked empty once (W5 wobble).** A referred case left the queue
  between two reads because it had terminal-transitioned (decided) in
  between. The Tomás E2E spec pins this: it asserts the created case is in
  `/api/review/queue` **and** still `pending_review` immediately before the
  officer decision is sent.

## Architecture & data flow

```
Browser → TanStack Start (3000) → /api proxy → Gateway (3001, cookie auth)
                                                  ├─ credit_auth (session users, db probe)
                                                  ├─ applications (4001) + review (4002, stateless, Temporal client → Temporal (7233) ← Worker)
                                                  └─ loans (4003) + portfolio (4004, Kafka consumer); signed HMAC identity downstream, no cookies
Worker: workflows/activities · dual outbox relay loops · reconciler · schedule bootstrap
Kafka (9092) ← relays → portfolio consumer → activity_feed
```

Postgres 18 is the system of record (one cluster, four databases — see
above); Kafka is an integration/read-model bus; Temporal owns long-running
state; officer decisions arrive via Temporal update sent by the stateless
review service (booking itself is a worker saga across the applications +
loans DBs: decision → loan → booked flip, each step idempotent); the
gateway never mutates decisions. The application detail `loan`
block is composed by the gateway from the loans service. Outbox prevents
dual-write loss. Package boundaries: core pure; db per-service
schemas/client/seed; service-kit shared internals; gateway auth+proxy;
services core+db+kit; worker core+db; web HTTP + core types. Full detail: [docs/explanation/architecture.md](docs/explanation/architecture.md).

## Service decomposition (P1a + P1b, monolith removed)

Five independently runnable Bun apps plus a shared kit. The old monolith is
deleted — the gateway owns `/api/*` on :3001 and the UI contract is
unchanged (paths, envelopes, cookie session, health shape + `services`).

- `packages/service-kit` (`@credit/service-kit`): error envelope, pino
  logger factory, `createService({name, routes, health})` (public `/health`
  → `{status, service, checks}`; internal auth on `/api/*` + `/internal/*`),
  HMAC internal auth, `internalFetch` signed client, Temporal gateway,
  outbox/audit writers. Test fakes behind `@credit/service-kit/test`.
- `apps/gateway` (3001): login/logout/me (scrypt, HMAC cookie, 10/min/email +
  30/min/IP login limits, 5/min/user submit limit), officer/demo gating, signed proxy
  to the four services, detail composition (`loan` via
  `GET /internal/loans/by-application/:id`; lookup 404 → `loan:null`, other
  failure → 502), aggregated health. Tests inject `fetchImpl` (no real
  services).
- `apps/applications` (4001), `apps/review` (4002, stateless — no DB),
  `apps/loans` (4003), `apps/portfolio` (4004, owns the Kafka consumer).
  Each validates its own `*_DATABASE_URL` (review: none — it takes
  `APPLICATIONS_URL`/`LOANS_URL` instead), `PORT` (own
  default), `INTERNAL_SECRET` at boot (plus `TEMPORAL_ADDRESS`, and
  `DEMO_MODE` for loans). `pnpm dev:services` runs gateway + all four.

**Internal auth.** The P1b gateway authenticates the end user, then signs
`HMAC-SHA256(method\npath\nuserId\nemail(lowercased)\nrole\nts)` with `INTERNAL_SECRET`
(`x-user-id`, `x-user-role`, `x-user-email`, `x-internal-ts`,
`x-internal-signature`, `x-request-id`; 5-minute skew; constant-time
compare). `path` is the exact pathname the target sees in `c.req.path`.
Services trust the signed identity — no cookies. Unsigned → 401,
role-mismatched → 403. Application detail omits `loan`; the gateway
composes it via `GET /internal/loans/by-application/:id` (loan summary +
paid/overdue counts).

**Database-per-service (P2).** Each service owns one Postgres 18 database
and imports only its `@credit/db/*` subpath (a `db.test.ts` ownership test
greps every service for cross-domain imports): gateway → `credit_auth`
(`users`); applications → `credit_applications` (pipeline + decisions +
audit/outbox); loans → `credit_loans` (ledger + audit/outbox, with
denormalised `application_reference`/`applicant_user_id`/`product` so it
never joins applications); portfolio → `credit_portfolio` (Kafka read
model). No cross-database foreign keys — references are plain uuids.
Review is **stateless** (queue/decision state via the applications/loans
internal APIs + Temporal); the worker orchestrates across the two writer
DBs (booking saga + one outbox relay each) and never touches
auth/portfolio.

## Orchestration (`compose.services.yml`)

The default compose workflow is unchanged (infra only). The overlay runs the
whole backend in containers under the `microservices` profile:

```powershell
docker compose -f docker-compose.yml -f compose.services.yml --profile microservices up -d --wait
docker compose -f docker-compose.yml -f compose.services.yml --profile microservices down
```

What it starts: a one-shot `deps` installer (`node:26-slim`, Linux-native
`pnpm install --frozen-lockfile` into a `svc-node-modules` volume shadowing
`/app/node_modules`), then gateway + applications + review + loans +
portfolio (`oven/bun:1.4.3` — the newest numeric tag on Docker Hub; 1.4.4
exists only as a local canary) and the worker (`node:26-slim`,
`node --import tsx`). Container networking is wired via `environment:`
(`AUTH/APPLICATIONS/LOANS/PORTFOLIO_DATABASE_URL=@postgres`, `TEMPORAL_ADDRESS=temporal:7233`,
`KAFKA_BROKERS=kafka:29092`, `APPLICATIONS_URL=http://applications:4001`,
…); secrets interpolate from the root `.env`. Ports 3001/4001–4004 are
published, each Bun service has a `bun -e` fetch healthcheck, and everything
waits on `deps` + healthy infra. The web app stays local (`pnpm
--filter @credit/web dev`). Note: `down` stops the base infra too; and a
container `pnpm install` over the bind mount can leave a stale Windows
`node_modules/.vitest-cache` behind — delete it if `pnpm test` hits EPERM
(known environmental issue, also noted below).

## Versions (pinned exact, via the `catalog:` section in `pnpm-workspace.yaml`)

Node 26.9.0 (local) · Bun 1.4.4 · pnpm 12.11.2 · TypeScript 7.0.2 ·
tsx 4.23.15 · @t3-oss/env-core 0.13.11 · dotenv 18.0.8 · kafkajs 2.2.4 · oxlint 1.88.0 ·
oxfmt 0.73.0 · hono 4.13.13 (served by Bun; no `@hono/node-server`) ·
@temporalio/client 1.24.0 (worker adds `@temporalio/worker` in W3) ·
react 19.3.1 · @tanstack/react-start 1.169.3 · @tanstack/react-router 1.170.45 ·
vite 8.3.4 · @vitejs/plugin-react 6.1.2 · tailwindcss 4.3.3 ·
@tailwindcss/vite 4.3.3 · nitro 3.0.260903-beta · @playwright/test 1.64.1.

Docker: `postgres:18-alpine` · `apache/kafka:3.9.0` ·
`temporalio/auto-setup:1.28.0` · `temporalio/ui:2.34.0` · overlay:
`oven/bun:1.4.3` · `node:26-slim`.

## Notes

- **Worker runs on Node 26; Temporal officially supports 20/22/24.**
  26 passes our full suite (109 unit + 35 integration + 4 E2E) but is outside
  the support matrix — if the worker ever acts up, Node 24 LTS is the first
  thing to try (`.nvmrc` pins the 26 we test on).
- **TS 7 kept (7.0.2).** It needed two small fixes, both correct anyway:
  `packages/core` now declares the `@types/node` it always imported, and pins
  `"types": ["node"]` (TS 7 no longer auto-discovers `@types` through pnpm's
  symlinked layout — `node:` imports failed as "absolute URI" without it).
- **oxlint offs (all documented false positives here):**
  `react/react-in-jsx-scope` (React 19 automatic runtime),
  `no-await-in-loop` (relay/consumer/monitoring loops are sequentially
  ordered by SPEC FR-6.6/FR-10.4), `unicorn/no-array-sort` (every site sorts a
  fresh copy), `unicorn/prefer-set-has` (2-item const list). Everything else
  in `.oxlintrc.json` is enforced: `eqeqeq` is error, correctness is error.
- **TS 5.9 dropped `module: "bundler"`** — web uses `module: ESNext` +
  `moduleResolution: Bundler` (equivalent for Vite typechecking).
- **tsx kills unsettled top-level await** (exit 13) — the worker idles with a
  heartbeat `setInterval`, not a pending promise.
- **dotenv 18 auto-injects `.env` from cwd on import** (the `◇ injected env`
  line) — apps additionally load root `.env` explicitly; the explicit call wins.
- **KafkaJS on Node 26 prints a harmless `TimeoutNegativeWarning`** from its
  internal `requestQueue` (clamped to 1ms); topics still create fine.
- **Kafka healthcheck needs the full path** `/opt/kafka/bin/kafka-topics.sh`
  (`/opt/kafka/bin` is not on `PATH` in `apache/kafka:3.9.0`).
- `pnpm approve-builds --all` was run once to persist `allowBuilds`
  (`esbuild`, `protobufjs`) in `pnpm-workspace.yaml` — fresh checkouts install
  non-interactively. If a new dep needs build scripts, re-run it.
- `apps/web/src/routeTree.gen.ts` is generated but **committed**, so a clean
  checkout passes `pnpm typecheck` without running dev/build first.
- E2E spawns dev servers via shell redirection because Node rejects raw fds
  in `spawn` stdio on Windows (EINVAL); teardown reaps the tree with
  `taskkill /T`. PIDs are recorded in `e2e/.e2e-pids.json`, logs in
  `e2e/logs/` (both gitignored).
- Demo only — do not use real PII; published passwords; no CSRF token
  (SameSite + JSON + origin allow-list); in-memory rate limits.
