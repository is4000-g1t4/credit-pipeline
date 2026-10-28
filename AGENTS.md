# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

End-to-end credit pipeline: apply → verify → gather data → score → policy
decision → human review → price/book → monitor. The decision pipeline is
deterministic. AI is advisory research and drafting only.

**Non-negotiable:** no AI stage may approve, decline, score, price, set terms,
or book. Do not add a path that lets model output change a score, decision,
terms, or booking. Validators, consent checks, and code gates are load-bearing;
never weaken one to make a test or eval pass.

Start with [docs/index.md](docs/index.md), then
[docs/explanation/architecture.md](docs/explanation/architecture.md) for the
request flow and trust boundary. Eval work starts at
[docs/eval/index.md](docs/eval/index.md).

## Layout

| Path                   | What lives there                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`             | TanStack Start UI; calls only same-origin `/api`.                                                                             |
| `apps/gateway`         | Auth/session, `/api` proxy, HMAC signing; owns `credit_auth`.                                                                 |
| `apps/applications`    | Cases, documents, assist, context reads; owns `credit_applications`.                                                          |
| `apps/review`          | Stateless officer review queue and decision updates.                                                                          |
| `apps/loans`           | Loans, installments, payments, EWS; owns `credit_loans`.                                                                      |
| `apps/portfolio`       | Activity feed and Kafka consumer; owns `credit_portfolio`.                                                                    |
| `apps/research`        | Advisory briefs/context; owns `credit_research`.                                                                              |
| `apps/policy`          | Policy navigator and case review; owns `credit_policy`.                                                                       |
| `apps/worker`          | Temporal workflows and activities; the only component that writes `credit_applications` + `credit_loans` in the booking saga. |
| `packages/core`        | Shared schemas, policy registry, pure domain logic.                                                                           |
| `packages/db`          | Drizzle schemas/migrations for every service database.                                                                        |
| `packages/service-kit` | Hono service factory, HMAC internal auth, errors, audit/outbox.                                                               |
| `docs/eval`            | Eval reports and the cross-agent model comparison.                                                                            |
| `scripts`              | Seed, demo, migration, and guardrail helpers.                                                                                 |

Database-per-service. Never add a cross-database foreign key, join, or direct
read of another service's database. Use signed internal HTTP or Kafka.

## Commands

```powershell
pnpm install
docker compose up -d --wait
pnpm setup                 # db wait/init/migrate/seed + kafka init
pnpm dev                   # gateway, services, worker, web
pnpm dev:services          # services only
```

Verification:

```powershell
pnpm typecheck
pnpm test
pnpm test:integration      # real Postgres/Temporal; stack required
pnpm test:e2e              # Playwright; starts its own stack
pnpm lint
pnpm exec oxfmt <files>    # format only the files you touched
```

Prefer package-scoped commands while iterating:

```powershell
pnpm --filter @credit/applications typecheck
pnpm --filter @credit/applications test
pnpm --filter @credit/worker exec vitest run test/refer.test.ts
```

If a package-scoped typecheck reports only the root `scripts/lib` workspace
resolution errors, report that separately; do not "fix" it by weakening app
types.

## Change rules

- Read the relevant feature doc in `docs/explanation/` and the affected
  package's tests before changing a boundary.
- Keep diffs scoped. Do not reformat unrelated files or rewrite prose.
- New behavior needs a test at the lowest layer that can prove it. Bug fixes
  need a regression test that fails before the fix.
- API or error-code changes: update `docs/reference/api.md` and the gateway/
  service tests.
- Database changes: add a Drizzle migration, run `pnpm db:migrate`, and keep
  service ownership intact.
- Money is integer cents. Dates are ISO UTC. IDs are UUIDs.
- Validate untrusted input at the boundary with the existing zod schemas.
- Use the existing logger and audit/outbox helpers; never log raw request
  bodies, document text, prompts, model output, PII, or secrets.
- Cross-applicant reads return 404, not 403. Service-only routes use
  `requireService` and signed HMAC headers.

## AI and advisory stages

- The deterministic pipeline decides. AI output is evidence/drafting only.
- Every AI feature stays behind its documented flag and consent checks. Flags
  default off in production code unless a report explicitly says otherwise.
- Use the production prompt, tools, validator, and model pin. Do not bypass a
  validator or invent a fallback that hides a failure.
- Never let model text become a score, decision, term, booking, or policy
  evaluation input.
- Model pins: context/policy/exception use Terra; brief/integrity/memo use Sol.
- Keep prompt/agent/validator versions recorded on traces and eval results.

## Evals

- Datasets and harnesses live in `apps/<app>/eval/`; reports live in
  `docs/eval/`.
- Add or update a row in `docs/eval/index.md` when adding an eval or changing a
  headline result.
- Every report states dataset, model/judge pins, pass definition, cost basis,
  raw result file, and caveats. Result JSONs are gitignored.
- Run the new/changed eval before quoting a number. Then run
  `pnpm eval:guardrails` if the feature is in its table.
- Held-out cases are not retuned after inspection. The policy-exception harness
  enforces a one-shot held-out marker.
- Prefer code/validator gates for `pass`; judge columns are advisory unless the
  report says otherwise.

## Commits

One focused commit per change. Use the repository's conventional subject
(`feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`), keep bullets short,
and do not stage unrelated user changes or generated result JSON. Never commit
`.env`, credentials, document blobs, or PII. If an agent materially authored
the change, add the co-author trailer.
