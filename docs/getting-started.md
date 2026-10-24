# Run and Verify the Demo

Use this guide to run the full demo and prove it works. Audience: grader or operator with a working checkout. Outcome: a healthy stack with all four demo scenarios verified.

Start from the quickstart in `../README.md`. That page owns first-run setup. This page adds verification and recovery.

## 1. Start the stack

Copy `.env.example` to `.env` and set `SESSION_SECRET` and `INTERNAL_SECRET` (see `reference/configuration.md`). Then run:

```powershell
pnpm install
docker compose up -d --wait
pnpm setup
pnpm dev
```

`pnpm setup` waits for Postgres, creates databases, creates Kafka topics, migrates, and seeds demo users. `pnpm dev` starts the gateway (`:3001`), six services (`:4001`-`:4006`), the worker, and the web app (`:3000`).

## 2. Check health

Open the gateway health endpoint:

```powershell
curl http://127.0.0.1:3001/api/health
```

Expect `"status": "ok"` with `db`, `kafka`, and `temporal` up. The `services` map is informational only. It does not change the top-level status. If health is not `ok`, see `operations/troubleshooting.md`.

## 3. Log in and find the screens

Open `http://localhost:3000`. Log in with password `demo1234` (see demo users below).

| Screen             | Route               | Who            |
| ------------------ | ------------------- | -------------- |
| New application    | `/apply`            | Applicant      |
| Application detail | `/applications/:id` | Owner, officer |
| Review queue       | `/officer/review`   | Officer        |
| Loan detail        | `/loans/:id`        | Owner, officer |

The application page polls until the status is terminal. The loan page shows a demo-controls panel for officers when demo mode is on.

## 4. Run the four scenarios

For the canonical run, start from a clean database (see step 6). The full click-through lives in `../README.md`. Expected outcomes:

| Scenario                      | Input                                                                                                                                           | Expected result                                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Maria auto-approve            | Individual, personal loan, $12,000 / 48 months, employed 6 years, $4,200/mo income, $610/mo debts, 3 bank years                                 | `booked`, score 777 / grade A, loan with 48 installments, next due date set, no alerts                                            |
| Tomás refer and counter-offer | SME term loan, $60,000 / 60 months, hospitality, 4 years trading, 9 employees, $610,000 revenue, $3,800/mo free cash flow, $300/mo debt service | `pending_review` with `AMOUNT_ABOVE_AUTO_LIMIT` and `SECTOR_REVIEW`; officer approves at $50,000 / 60 months; `booked` at $50,000 |
| Sam auto-decline              | Individual, $10,000 / 36 months, employed 1 year, $2,800 income, $950 debts                                                                     | `declined` with `SCORE_TOO_LOW` and negative factors; no loan                                                                     |
| Monitoring on the Tomás loan  | Officer ages the loan 40 days, runs monitoring, acknowledges the alert, pays the next installment                                               | One `payment_overdue` alert; acknowledged; payment posted; no open alerts                                                         |

A `pending_review` or `declined` status is a correct result. Do not treat it as a failure.

Exact request payloads live in `../e2e/maria.spec.ts` and `../e2e/tomas.spec.ts` (UI path) and `../scripts/demo-check.ts` (HTTP path, amounts in cents).

Alex (`alex@example.com`) and Lena (`lena@bakery.example`) are seeded users but have no scripted verification. Do not use them as pass or fail checks.

## 5. Verify without the browser

`pnpm demo:check` drives Maria, Sam, Tomás, and monitoring over HTTP. It starts nothing. It needs a healthy stack. It prints `PASS` or `FAIL` per check and exits non-zero on failure.

```powershell
pnpm demo:check
```

`pnpm demo:monitor` runs one monitoring sweep as the officer and prints counts. If monitoring is still running after 30 seconds, it prints the `workflowId` and exits. Poll the loan page for the result.

```powershell
pnpm demo:monitor
```

`pnpm test:e2e` runs seven Playwright specs (`maria`, `tomas`, `sam`, `monitoring`, `research`, `documents`, `breadtalk`) against `http://127.0.0.1:3000`. Its global setup always starts a worker, reuses a healthy gateway, services, and web when up (it starts only what is down), and stops only the processes it started. It needs Docker Compose running. Install the browser once with `pnpm exec playwright install chromium`.

## 6. Recover a half-run demo

Each applicant can hold at most 3 non-terminal applications. The 4th submit returns 409 `TOO_MANY_APPLICATIONS`. A half-finished run also leaves stale rows. Reset with:

```powershell
docker compose down -v
docker compose up -d --wait
pnpm setup
```

This wipes databases and Kafka. If you upgrade Postgres 17 data to Postgres 18, stop the stack (`docker compose down`), delete the volume (`docker volume rm project_pgdata`), then `up` and `pnpm setup`. Warning: this deletes all local database and Temporal data.

If a crashed run leaves a stale dev server, find the listener on ports 3000, 3001, or 4001-4006 and stop that process only. Never stop all Node processes. Full symptom tables live in `operations/troubleshooting.md`.

## 7. Demo users

Password is `demo1234` for all users. There is no signup route.

| Email                        | Role      | Demo path                                      |
| ---------------------------- | --------- | ---------------------------------------------- |
| `maria@example.com`          | Applicant | Auto-approve ($12k / 48m, booked, 777/A)       |
| `alex@example.com`           | Applicant | Refer path                                     |
| `sam@example.com`            | Applicant | Auto-decline (`SCORE_TOO_LOW`)                 |
| `tomas@cafe-aurora.example`  | Applicant | SME refer, officer counter-offer $50k, booked  |
| `lena@bakery.example`        | Applicant | SME auto-approve                               |
| `officer@example.com`        | Officer   | Review queue, decisions, demo controls         |
| `senior.officer@example.com` | Officer   | Same as officer; not in the UI quick-fill list |

## 8. Demo-only warnings

Do not use real personal data. Passwords are published. There is no CSRF token (cookie uses `SameSite=Lax`, JSON bodies, and a production origin check). Rate limits are in-memory per process. Bureau, bank, and verification data are deterministic mocks. The verification and external-data cards carry "Mock data" badges in the UI.

## 9. Phase 2 advisory research (optional)

Research is off by default and the demo never needs it. To enable it, set in the root `.env`:

```dotenv
RESEARCH_DATABASE_URL=postgres://credit:credit@localhost:5432/credit_research
AGENTS_ENABLED=true
AGENT_CASE_BRIEF_ENABLED=true
OPENROUTER_API_KEY=<key>
TAVILY_API_KEY=<key>
```

then `pnpm db:migrate` (creates the `credit_research` tables) and `pnpm dev` (starts research on `:4005`). Without `RESEARCH_DATABASE_URL`, `pnpm db:migrate` skips the research database with a clear log and Phase 1 setup still passes. With the flags off, every research route returns 404 `RESEARCH_DISABLED` and the UI panel hides; research needs `pending_review` status plus AI research consent, and it never decides a case. Optional auto-trigger on referral (`AGENT_AUTO_TRIGGER_ENABLED=true`, group `credit-research-auto`): at most one `trigger=auto` run per referral (durable event log — redeliveries replay the original outcome even after a status/consent change), UTC-day auto-only caps/budget-guarded, first-officer-claims-on-read (empty audit history claims nothing) — skip reasons surface at `GET /api/review/:id/research/audit` and on the case page (auto badge, skip copy, assigned-to-another-officer state). Detail: `reference/api.md` (research section) and `reference/configuration.md` (research variables).

## Related

- [README](../README.md) — quickstart and full click-through narrative.
- [API](reference/api.md) — endpoint contracts used by the checks.
- [Configuration](reference/configuration.md) — variables and ports.
- [Troubleshooting](operations/troubleshooting.md) — recovery for each failure.
- [Architecture](explanation/architecture.md) — how the demo flows through services.
- [Lifecycle](explanation/lifecycle.md) — what each status means.
