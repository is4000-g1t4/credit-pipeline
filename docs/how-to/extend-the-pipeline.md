# Extend the pipeline

This page gives safe recipes. Audience: developers with a working checkout who add a capability. Outcome: the change lands without breaking contracts, migrations, or events.

Assumptions: the local stack runs (`pnpm dev`), and you have read [architecture](../explanation/architecture.md) and [lifecycle](../explanation/lifecycle.md).

## Add a gateway route and a service endpoint

Pattern: the gateway authenticates and proxies; the service owns the logic.

1. Add the route to the owning service with `Hono`, under `/api/...`. Enforce the role inside the service (applicant or officer check), not only in the gateway.
2. Build the app with `createService({name, routes, health})` from `@credit/service-kit`. `/health` stays public; `/api/*` and `/internal/*` get HMAC auth automatically.
3. Add the gateway route in `apps/gateway/src/app.ts`. Use `proxyTo` for plain proxying. For composed reads, follow the `GET /api/applications/:id` pattern: fetch upstream, then the second lookup; loan-style 404 becomes null, other failures become 502 `BAD_GATEWAY`.
4. Sign internal calls with `signInternalHeaders` from `@credit/service-kit`. The canonical message is `METHOD\nPATH\nUSER_ID\nEMAIL(lowercased)\nROLE\nTS`; `PATH` is the exact pathname the target sees. Keep the 5-minute skew in mind for tests: pass an explicit `ts`.
5. Add tests with the `stubGateway` fake from `@credit/service-kit/test` and a `fetchImpl` fake for the gateway. Do not start real services in unit tests.

Verify:

```powershell
pnpm typecheck
pnpm lint
pnpm test
```

## Add an event and a topic

1. Add the payload schema to `packages/core/src/schemas.ts` as a strict object, and register it in `eventPayloadSchemas` plus the `eventTypeSchema` union and `eventEnvelopeSchema`.
2. Add the topic mapping in `packages/core/src/events.ts` (`TOPICS`) and a `dedupe*` key builder.
3. Add the topic string to `scripts/kafka-init.ts` and run `pnpm kafka:init`.
4. Insert the outbox row in the same transaction as the state change with `insertOutbox` (service code) or the worker helper. Use `ON CONFLICT (dedupe_key) DO NOTHING` semantics; never insert outside the transaction.
5. Extend `feedMessageForEnvelope` in `apps/portfolio/src/events/consumer.ts` with allowlisted fields only. No identity fields; no new finance fields beyond the catalog.
6. Add unit tests: envelope validation, dedupe key, relay ordering, consumer projection.

Verify:

```powershell
pnpm kafka:init
pnpm --filter @credit/core test
pnpm test
```

## Add a database column and a migration

1. Edit only the owning service schema file under `packages/db/src/` (`auth.ts`, `applications.ts`, `loans.ts`, `portfolio.ts`). Never add a cross-database foreign key; use a plain UUID.
2. Import only the matching `@credit/db/*` subpath in service code. The ownership test greps services for cross-domain imports.
3. Generate the migration:

```powershell
pnpm --filter @credit/db db:generate
```

4. Check that only the intended `packages/db/drizzle/<domain>/` folder changed. Never hand-edit generated files.
5. Apply and test:

```powershell
pnpm db:migrate
pnpm --filter @credit/db test
pnpm test
```

## Change policy or scoring

Policy and scoring are pure functions in `packages/core/src/policy.ts` and `packages/core/src/scoring.ts`, versioned by `SCORECARD_VERSION = "scorecard-v1"` and `POLICY_VERSION = "policy-v1.0"` in `packages/core/src/constants.ts`.

1. Change the pure function only. Keep I/O in worker activities.
2. If the outcome shape changes, bump the version constant and keep snapshot readers compatible.
3. Add test vectors that pin the boundary you moved (score band, DTI/DSCR limit, auto-approve cap).
4. Run the worker suite, because workflows consume these functions.

Verify:

```powershell
pnpm --filter @credit/core test
pnpm --filter @credit/worker test
pnpm test
```

## Add a demo scenario check

1. Extend `scripts/demo-check.ts` for HTTP-level checks, or add a Playwright spec under `e2e/` for UI-level checks. Do not present seeded users without scenario evidence as verified paths.
2. Run against a running stack:

```powershell
pnpm demo:check
pnpm test:e2e
```

## Related

- [Architecture](../explanation/architecture.md) — trust boundary and failure domains
- [Data and events](../reference/data-and-events.md) — ownership, topics, outbox
- [Public and internal API](../reference/api.md) — routes and error codes
- [Configuration](../reference/configuration.md) — ports and environment
