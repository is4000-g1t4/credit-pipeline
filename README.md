# Creditworthiness Pipeline — Phase 1 + Phase 2 advisory research

Docs: [docs/index.md](docs/index.md).

End-to-end credit pipeline: apply → verify → gather data → score → policy
decision → human review → price & book → monitor. The pipeline itself uses
deterministic mocks throughout (labelled "Mock data" in the UI). Phase 2
adds an advisory agent-research brief (approved LLM + Tavily cited sources,
officer-triggered or auto-triggered on referral, never decisive) behind `AGENTS_ENABLED` +
`AGENT_CASE_BRIEF_ENABLED`. Architecture: [docs/explanation/architecture.md](docs/explanation/architecture.md).

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
pnpm dev                        # gateway :3001 + services :4001-4006 + worker + web :3000 in parallel
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

## Document workflow (T01/T02, behind a flag)

Applicant or assigned-officer PDF/PNG/JPEG uploads are malware-scanned
(ClamAV), encrypted at rest (AES-256-GCM), and text-extracted (PDF text layer
or image OCR) with page/offset citations. An officer-only deterministic
cross-check cites name/registration mismatches; chase requests are
**draft-only** (created after opening the original, never sent). Documents
never affect the credit decision and never appear in logs or Grafana.

Enable locally (restart the applications service afterwards):

```powershell
# .env
DOCUMENT_FEATURE_ENABLED=true
DOCUMENT_ENCRYPTION_KEY=<base64-32-bytes>  # node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
DOCUMENT_STORAGE_DIR=.data/documents
CLAMAV_HOST=127.0.0.1
CLAMAV_PORT=3310
```

The scanner needs a ClamAV daemon: run one locally on `:3310`, or start the
`microservices` overlay (`compose.services.yml` runs `clamav:3310` with
`CLAMAV_HOST=clamav` plus the encrypted `documents` volume). Image OCR uses
the vendored `apps/applications/assets/tesseract/eng.traineddata.gz`; set
`DOCUMENT_OCR_DATA_DIR` only to override it (no runtime CDN). Text PDFs need
no OCR assets. Missing key/scanner fails uploads closed (503)
without affecting readiness or decisions; the UI panel hides while the flag
is off and the mock Verification checklist is untouched.

v1 limitations: scanned/image-only PDFs yield `needs_chase` (no PDF-image
OCR); ID files store bytes only (no page text, always needs-chase);
assigned-officer only (no specialist access — claim the case first, other
officers see a non-leaking "not available"); chase drafts are never sent;
retention is 90 days with legal-hold blocking (full DSAR automation stays
T16). E2E: `e2e/documents.spec.ts` (+ `e2e/fixtures/mismatch.pdf`) runs the
full path when the stack above is configured, otherwise it skips with the
required env.

## Case-assist enablers (EN-01/02/03, behind a flag)

The shared substrate for the credit-memo, policy-exception, and
adverse-action features lives in the applications service:

- **EN-01 evidence bundle** — `GET /api/assist/cases/:id/evidence` returns the
  case evidence with stable `sourceRef` keys (the five backlog sources:
  document/page/offset, context signal, external evidence, policy section,
  score/reason; plus `case_fact` for structured request/entity fields), source
  type, retention/legal-hold metadata, and typed `unavailable` entries. Case
  access is officer + non-draft + not another officer's assignment; document
  text additionally requires the active `assigned_officer` grant.
- **EN-02 artifact lifecycle** — generic versioned artifacts (`credit_memo`,
  `policy_exception_memo`, `adverse_action_letter`) with optimistic
  concurrency, a DB trigger that freezes approved content, tombstone-only
  deletion, append-only audit, retention, and legal holds. A further edit of
  an approved artifact creates the next version; approval supersedes the old
  one.
- **EN-03 shared validator** — strict per-type schema, citation existence and
  exact-quote checks against the bundle, decision-language scan, and direct
  PII / protected-attribute scans. Invalid output returns typed issues and is
  never persisted.

`POST /api/assist/cases/:id/memos` is the end-to-end consumer: it assembles
evidence, drafts with the configured writer (deterministic template by
default, no LLM and no decision language; `ASSIST_MEMO_WRITER=agent` runs a
bounded tool loop over allowlisted evidence tools with one
validation/repair attempt), validates, and stores a draft artifact with its
agent trace. Identical evidence replays the same artifact (`200 replayed`)
instead of regenerating. It requires a `pending_review`
case. The officer review page shows the memo above the decision panel
(sections/claims with citation chips, open items, officer questions, an
explicit-confirm approval, and the metadata-only agent trace); the panel
hides while the flag is off. `POST /api/assist/cases/:id/adverse-action` (EN-08 / E4) is the
declined-case counterpart: it selects 3-4 principal reasons from the decision
reason codes via the EN-08 taxonomy and stores an `adverse_action_letter`
draft under the configured jurisdiction profile (`ASSIST_ADVERSE_*`; see
[docs/explanation/adverse-action.md](docs/explanation/adverse-action.md)).
Generic artifact routes are under `/api/assist/cases/:id/artifacts` and
`/api/assist/artifacts/:id` (`PATCH`, `/approve`, `/tombstone`). All routes are
officer-only; applicants get 403 and another officer's assigned case is a
non-leaking 404.

Enable locally (restart the applications service afterwards):

```powershell
# .env
ASSIST_ENABLED=true
ASSIST_RETENTION_DAYS=90
ASSIST_ADVERSE_JURISDICTION=SG
# Required; blank makes the adverse-action route fail closed with 422.
ASSIST_ADVERSE_CONTACT_PATH=
ASSIST_ADVERSE_PROMPT_VERSION=adverse-letter-v1
```

With the flag off every officer-facing assist route returns 404; the
service-only hold/retention routes stay available so legal holds can still be
recorded and retention still runs. The validator and evidence
contract are pure exports from `@credit/core`; the applications module is
`apps/applications/src/assist/`. Tests: `pnpm --filter @credit/applications
test:integration` (real Postgres; route tests use a fake research upstream).
`e2e/assist.spec.ts` runs the happy path when the flag is on (draft with
trace assertions, idempotent replay, approval, plus a review-UI memo/trace
assertion) and the flag-off 404 case when it is off.

## Demo customer fixtures (T17/D2a, CLI-only)

`fixtures/demo/manifest.json` is the checked-in source of truth
(`DEMO_AS_OF=2026-06-30`, version + SHA-256 pinned in
`scripts/lib/manifest.ts`): synthetic customer profiles, masked accounts,
transactions, and text-PDF evidence for `breadtalk` (SME with stale
statement/financials — the submit-blocker demo), `alex` (fresh individual),
and `sparse` (verified KYC, no accounts — the insufficient-data persona).
Customer evidence is encrypted under the disjoint `CUSTOMER_STORAGE_DIR`
root with customer AAD; the T01 app sweep can never touch it (a separate
customer sweep tombstones expired rows under the same per-customer lock the
reuse path takes).

```powershell
pnpm demo:seed                      # DEMO_MODE + hash gate; idempotent, never touches drafts
pnpm demo:case --persona=breadtalk  # draft + fresh id/registration copies + stale app copies (blocked)
pnpm demo:verify --persona=breadtalk --phase=pre-refresh
pnpm demo:refresh-evidence --persona=breadtalk  # fresh customer docs only — still blocked
# applicant reuses the fresh docs via POST /api/applications/:id/documents/reuse, then:
pnpm demo:submit --persona=breadtalk # real submit endpoint (409 until ready, one transition)
pnpm demo:verify --persona=breadtalk --phase=post-submit
pnpm demo:reset --dry-run           # preview; add --yes with DEMO_RESET_ALLOWED=true to run (never prod)
```

`demo:seed`/`demo:case` re-runs converge fixture-owned rows but skip any
draft the applicant touched (uploads, edits, or submit). The T18 context
analyst starts from a bounded officer-screen snapshot then drills in via a read-only internal tool loop (transactions,
credit history, external reports, KYC checks, loans) — advisory only; the applicant UI arrives in D2b/D3; `demo:verify`
reports those seams instead of failing on them.

## Command reference

| Command                                            | What it does                                                                                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                                         | gateway + 6 services + worker + web in parallel                                                                                           |
| `pnpm dev:services`                                | gateway + 4 services (no research/policy/worker/web)                                                                                      |
| `pnpm typecheck`                                   | `tsc --noEmit` in every package + `scripts/` + `e2e/`                                                                                     |
| `pnpm lint` / `pnpm format` / `pnpm format:check`  | `oxlint` / `oxfmt .` / `oxfmt --check .`                                                                                                  |
| `pnpm test`                                        | all workspace unit suites, compose-free                                                                                                   |
| `pnpm test:integration`                            | gateway (15) + applications (11) + loans (5) + portfolio (5) + review (19) + worker (10) + research (38) integration = 103, needs compose |
| `pnpm test:e2e`                                    | Playwright (9 specs), boots worker/gateway/services/web itself, needs compose                                                             |
| `pnpm demo:check`                                  | scripted HTTP smoke (Maria/Sam/Tomás + monitoring/pay), needs the stack                                                                   |
| `pnpm demo:monitor`                                | officer login + `POST /demo/monitoring/run`, prints counts                                                                                |
| `pnpm demo:seed`                                   | idempotent T17 fixture load (users/customers/evidence, `DEMO_MODE` + manifest hash gate), needs DB                                        |
| `pnpm demo:case --persona=<key>`                   | deterministic fixture draft + initial evidence (BreadTalk blocks on stale docs), needs DB                                                 |
| `pnpm demo:refresh-evidence --persona=<key>`       | add fresh customer evidence only (never attaches), needs DB                                                                               |
| `pnpm demo:submit --persona=<key>`                 | submit the fixture draft via the real endpoint, needs the stack                                                                           |
| `pnpm demo:verify --persona=<key> --phase=<phase>` | read-only fixture checks (`pre-refresh`/`post-refresh`/`post-attach`/`post-submit`), needs DB                                             |
| `pnpm demo:reset --dry-run` / `--yes`              | guarded compose reset (volumes + roots + reseed); `--dry-run` prints the plan, `--yes` runs it — never in production                      |
| `pnpm db:wait`                                     | polls `pg_isready` in the postgres container (timeout `DB_WAIT_TIMEOUT_S`, default 120)                                                   |
| `pnpm db:init`                                     | creates the 6 service DBs (+ Temporal pair) if missing — self-provisions existing clusters                                                |
| `pnpm kafka:init`                                  | creates the 7 SPEC FR-10.1 topics (3 partitions, RF 1), idempotent                                                                        |
| `pnpm setup`                                       | `db:wait && db:init && kafka:init && db:migrate && db:seed`                                                                               |
| `pnpm build`                                       | recursive `--if-present` build                                                                                                            |

## Ports & env

| Service        | Port | Notes                                                                                                                                                                                                                                                      |
| -------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| web (Vite)     | 3000 | proxies `/api` → `127.0.0.1:3001`                                                                                                                                                                                                                          |
| gateway (Hono) | 3001 | binds `API_HOST` (default 127.0.0.1); `GET /api/health` → `{status:"ok"}` + `services` map                                                                                                                                                                 |
| postgres 18    | 5432 | one cluster, six databases: `credit_auth` (gateway) · `credit_applications` · `credit_loans` · `credit_portfolio` · `credit_research` · `credit_policy`; init SQL creates all eight (+ `temporal` pair); volume mounts `/var/lib/postgresql` (PG18 layout) |
| kafka (KRaft)  | 9092 | host listener; internal `kafka:29092` for future in-compose clients                                                                                                                                                                                        |
| temporal       | 7233 | auto-setup against the postgres service                                                                                                                                                                                                                    |
| temporal-ui    | 8080 | pointed at `temporal:7233`                                                                                                                                                                                                                                 |
| applications   | 4001 | P1a microservice: intake + case detail (no loan block)                                                                                                                                                                                                     |
| review         | 4002 | stateless: queue + officer decisions (no DB)                                                                                                                                                                                                               |
| loans          | 4003 | P1a microservice: loans, alerts, demo controls, internal loan lookup                                                                                                                                                                                       |
| portfolio      | 4004 | dashboard summary + Kafka consumer                                                                                                                                                                                                                         |
| research       | 4005 | Phase 2 advisory briefs (Node here for the Grafana/OpenTelemetry stack; Agents itself runs on Bun); owns `credit_research`; runs only when `AGENTS_ENABLED` + `AGENT_CASE_BRIEF_ENABLED`                                                                                        |
| policy         | 4006 | credit-policy register + officer navigator (Bun); owns `credit_policy`; answers only when `POLICY_ASSIST_ENABLED=true`                                                                                                                                     |

Environment files are loaded explicitly ? Bun's dev scripts pass
`--env-file=../../.env`, Node (worker/research/tests) uses `dotenv` ? and validated by
**t3-env** (`@t3-oss/env-core`) with per-app zod schemas, so a missing or
invalid variable fails fast at boot (except `db:migrate`, which skips the
research database with a clear log when `RESEARCH_DATABASE_URL` is unset —
set it to enable Phase 2). Bun does auto-load `.env` from its cwd,
but services run with cwd=`apps/<name>`, hence the explicit root path.
`scripts/*` run with cwd = root under Bun. Never commit `.env` (gitignored).
The gateway reads `APPLICATIONS_URL`/`REVIEW_URL`/`LOANS_URL`/`PORTFOLIO_URL`
(defaulting to `http://127.0.0.1:4001`?`:4004`) plus `INTERNAL_SECRET` for
signing downstream requests; review additionally reads `RESEARCH_URL`
(default `http://127.0.0.1:4005`); `compose.services.yml` overrides the URLs for
container networking (`http://applications:4001`, ?).
a crashed run can leave a stale server behind. Find it with
`Get-NetTCPConnection -LocalPort 3000,3001,4001,4002,4003,4004,4005,4006 -State Listen` and stop that
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
  db:init` (creates the six service DBs if missing).
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
                                                  ├─ loans (4003) + portfolio (4004, Kafka consumer); signed HMAC identity downstream, no cookies
                                                   ├─ research (4005, Node): review only, officer-gated advisory briefs
                                                   └─ policy (4006): officer navigator + case-policy review (`POLICY_ASSIST_ENABLED` only)
Worker: workflows/activities · dual outbox relay loops · reconciler · schedule bootstrap
Kafka (9092) ← relays → portfolio consumer → activity_feed
```

Postgres 18 is the system of record (one cluster, six databases — see
above); Kafka is an integration/read-model bus; Temporal owns long-running
state; officer decisions arrive via Temporal update sent by the stateless
review service (booking itself is a worker saga across the applications +
loans DBs: decision → loan → booked flip, each step idempotent); the
gateway never mutates decisions. The application detail `loan`
block is composed by the gateway from the loans service. Outbox prevents
dual-write loss. Advisory research never decides: the officer accepts cited
findings, the decision carries only the selection (`agentRunId` +
`acceptedFindingIds`), review freezes exactly the used findings into the
decision snapshot, and the bundle's `viewedAt` is the deciding officer's
latest view. Package boundaries: core pure; db per-service
schemas/client/seed; service-kit shared internals; gateway auth+proxy;
services core+db+kit; worker core+db; web HTTP + core types. Full detail: [docs/explanation/architecture.md](docs/explanation/architecture.md).

## Service decomposition (P1a + P1b, monolith removed)

Seven independently runnable backend apps plus a shared kit. The old monolith is
deleted — the gateway owns `/api/*` on :3001 and the UI contract is
unchanged (paths, envelopes, cookie session, health shape + `services`).

- `packages/service-kit` (`@credit/service-kit`): error envelope, pino
  logger factory, `createService({name, routes, health})` (public `/health`
  → `{status, service, checks}`; internal auth on `/api/*` + `/internal/*`),
  HMAC internal auth, `internalFetch` signed client, Temporal gateway,
  outbox/audit writers. Test fakes behind `@credit/service-kit/test`.
- `apps/gateway` (3001): login/logout/me (scrypt, HMAC cookie, 10/min/email +
  30/min/IP login limits, 5/min/user submit limit), officer/demo gating, signed proxy
  to the downstream services, detail composition (`loan` via
  `GET /internal/loans/by-application/:id`; lookup 404 → `loan:null`, other
  failure → 502), aggregated health. Tests inject `fetchImpl` (no real
  services).
- `apps/applications` (4001), `apps/review` (4002, stateless — no DB),
  `apps/loans` (4003), `apps/portfolio` (4004, owns the Kafka consumer).
  Each validates its own `*_DATABASE_URL` (review: none — it takes
  `APPLICATIONS_URL`/`LOANS_URL`/`RESEARCH_URL` instead), `PORT` (own
  default), `INTERNAL_SECRET` at boot (plus `TEMPORAL_ADDRESS`, and
  `DEMO_MODE` for loans). `pnpm dev:services` runs gateway + all four pipeline services.
- `apps/research` (4005, **Node here for the Grafana/OpenTelemetry stack**;
  `@openai/agents` itself runs under Bun): advisory cited briefs on
  `pending_review` cases with AI
  research consent. Owns `credit_research`; runs only when `AGENTS_ENABLED` +
  `AGENT_CASE_BRIEF_ENABLED`. Served by stdlib `node:http` + `app.fetch`
  (no extra server dep). Grafana observability is best-effort: a degraded
  pipeline never fails readiness, a run, or a decision.
- `apps/policy` (4006): versioned credit-policy register, pgvector index,
  officer navigator and case-policy review. Owns `credit_policy`; answers only
  when `POLICY_ASSIST_ENABLED=true`.

**Internal auth.** The P1b gateway authenticates the end user, then signs
`HMAC-SHA256(method\npath\nuserId\nemail(lowercased)\nrole\nts\nbodyHash\nrequestId)` with `INTERNAL_SECRET`
(`x-user-id`, `x-user-role`, `x-user-email`, `x-internal-ts`,
`x-internal-signature`, `x-body-sha256`, `x-request-id`; 5-minute skew; constant-time
compare). `path` is the exact pathname the target sees in `c.req.path`.
Services trust the signed identity — no cookies. Unsigned, body-swapped, or replayed → 401,
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
model); research → `credit_research` (agent runs, evidence, findings, reviews, views); policy owns `credit_policy` (versioned corpus, index, spend ledger). No cross-database foreign keys — references are plain uuids.
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
exists only as a local canary), research + worker (`node:26-slim`, research via
`node --import tsx`). Container networking is wired via `environment:`
(`AUTH/APPLICATIONS/LOANS/PORTFOLIO_DATABASE_URL=@postgres`, `TEMPORAL_ADDRESS=temporal:7233`,
`KAFKA_BROKERS=kafka:29092`, `APPLICATIONS_URL=http://applications:4001`, `RESEARCH_URL=http://research:4005`,
…); secrets interpolate from the root `.env`. Ports 3001/4001–4005 are
published, each service has a fetch healthcheck (`bun -e` for Bun, `node -e` for research), and everything
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
  26 passes our full unit + integration suite and the 9 Playwright specs but is outside
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
