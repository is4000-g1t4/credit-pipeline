# Credit policy service (T03/T04)

Owns the credit-policy register, pgvector index, officer navigator, and the
automatic case-policy review route. See
`.scratch/specs/t03-t04-policy-corpus-and-navigator.md`.

## Local setup

```sh
pnpm db:init
pnpm db:migrate
pnpm --filter @credit/policy seed
POLICY_ASSIST_ENABLED=true pnpm dev
```

`seed` loads the reviewed Markdown under `policies/credit/` as approved demo
versions and builds the active `voyageai/voyage-4-large` index (1024 dims).
Set `POLICY_ASSIST_ENABLED=true` in `.env` (or the shell) to turn on the
navigator and the automatic case stage. The service is off by default.

Officer UI: `/officer/policies`. Case citations appear automatically in the
case page's **Policy review** section after the internal-context stage.

## Embedding eval

```sh
pnpm --filter @credit/policy eval:embedding
```

Results are written under `eval/results/`. The 2026-10-23 run selected
`voyageai/voyage-4-large` (1024 dims); see `eval/RESULTS.md`.

## Import / approval

`pnpm --filter @credit/policy import:draft -- --file=...` writes a draft with
the configured editor service principal. It does not approve. Approval is
the authenticated `/api/policy/versions/:id/approve` route and requires the
active-index chunks to be present; draft import intentionally does not build
them.

## Secrets

`POLICY_INTERNAL_SECRET` is the research→policy HMAC (distinct from the
gateway `INTERNAL_SECRET`). `POLICY_CASE_TOKEN_SECRET` binds a case token to
run/application/actor/as-of; `POLICY_CITATION_SECRET` signs section-drawer
tokens. Use real values in production.
