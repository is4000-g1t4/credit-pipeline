# Configuration Reference

Every environment variable, its consumers, and its default. Audience: developer or operator configuring the stack. Outcome: a correct `.env` for local runs and containers.

## How loading works

1. Bun dev scripts pass `--env-file=../../.env` because each service runs with `cwd=apps/<name>`.
2. Each `env.ts` also calls `dotenv.config()` on the root `.env` for Node and Vitest.
3. `@t3-oss/env-core` validates the result at boot and fails fast on missing or bad values.
4. Real process environment wins over dotenv. Compose `environment:` wins over the root `.env`.
5. `SKIP_ENV_VALIDATION` bypasses validation. Use it for development and tests only.
6. Empty strings count as missing (`emptyStringAsUndefined: true`).
7. `NODE_ENV=production` enables the gateway origin allow-list and the `Secure` cookie flag.

## Variables

| Variable                    | Consumer                                              | Required / default                                           | Notes                                                                         |
| --------------------------- | ----------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `AUTH_DATABASE_URL`         | Gateway, `db:seed`, `db:migrate`                      | Required                                                     | `credit_auth` database                                                        |
| `APPLICATIONS_DATABASE_URL` | Applications, worker, `db:migrate`                    | Required                                                     | `credit_applications` database                                                |
| `LOANS_DATABASE_URL`        | Loans, worker, `db:migrate`                           | Required                                                     | `credit_loans` database                                                       |
| `PORTFOLIO_DATABASE_URL`    | Portfolio, `db:migrate`                               | Required                                                     | `credit_portfolio` database                                                   |
| `ADMIN_DATABASE_URL`        | `scripts/db-init.ts`                                  | Default `postgres://credit:credit@localhost:5432/postgres`   | Admin connection used to create databases; script-only                        |
| `SESSION_SECRET`            | Gateway                                               | Required, no default                                         | HMAC key for the session cookie; changing it logs out all users               |
| `INTERNAL_SECRET`           | Gateway, applications, review, loans, portfolio       | Required, no default                                         | Must be identical everywhere; signs internal calls                            |
| `TEMPORAL_ADDRESS`          | Gateway, applications, review, loans, worker          | Default `localhost:7233`                                     | Portfolio does not use it                                                     |
| `KAFKA_BROKERS`             | Gateway, portfolio, worker                            | Default `localhost:9092`                                     | Comma-separated; compose uses `kafka:29092`                                   |
| `APPLICATIONS_URL`          | Gateway, review, portfolio                            | Default `http://127.0.0.1:4001`                              | Compose: `http://applications:4001`                                           |
| `REVIEW_URL`                | Gateway                                               | Default `http://127.0.0.1:4002`                              | Compose: `http://review:4002`                                                 |
| `LOANS_URL`                 | Gateway, review, portfolio                            | Default `http://127.0.0.1:4003`                              | Compose: `http://loans:4003`                                                  |
| `PORTFOLIO_URL`             | Gateway                                               | Default `http://127.0.0.1:4004`                              | Compose: `http://portfolio:4004`                                              |
| `API_PORT`                  | Gateway                                               | Default `3001`                                               | Gateway bind port                                                             |
| `API_HOST`                  | Gateway                                               | Default `127.0.0.1`                                          | Compose sets `0.0.0.0`                                                        |
| `PORT`                      | Applications, review, loans, portfolio                | Default `4001` / `4002` / `4003` / `4004`                    | Compose sets each to its own port                                             |
| `HOST`                      | Applications, review, loans, portfolio                | Default `127.0.0.1`                                          | Compose sets `0.0.0.0`                                                        |
| `WEB_ORIGIN`                | Gateway                                               | Default `http://localhost:3000`                              | Exact origin checked only in production                                       |
| `DEMO_MODE`                 | Gateway, loans                                        | `true` / `false`, default `true`                             | Gates `/api/demo/*` and the UI demo panel                                     |
| `NODE_ENV`                  | Gateway                                               | `development` / `test` / `production`, default `development` | Production enables origin check and `Secure` cookies                          |
| `VITE_API_URL`              | None                                                  | Example only                                                 | Present in `.env.example`; no code reads it; the web app uses relative `/api` |
| `DB_WAIT_TIMEOUT_S`         | `scripts/db-wait.ts`                                  | Default `120`                                                | Seconds to wait for Postgres; script-only, not in `.env.example`              |
| `API_BASE`                  | `scripts/demo-check.ts`, `scripts/demo-monitor.ts`    | Default `http://127.0.0.1:3001`                              | Script-only, not in `.env.example`                                            |
| `LOG_LEVEL`                 | All services via `packages/service-kit/src/logger.ts` | Default `info`                                               | Standard pino level; not in `.env.example`                                    |
| `SKIP_ENV_VALIDATION`       | Every `env.ts`                                        | Optional                                                     | Bypasses validation; development and tests only                               |

## Ports

| Component     | Port                      | Notes                                                      |
| ------------- | ------------------------- | ---------------------------------------------------------- |
| Web (Vite)    | 3000                      | Nitro rule proxies `/api/**` to `127.0.0.1:3001/api/**`    |
| Gateway       | 3001                      | Binds `API_HOST`; serves `GET /api/health`                 |
| Applications  | 4001                      | `PORT` default 4001                                        |
| Review        | 4002                      | Stateless; no database                                     |
| Loans         | 4003                      | `DEMO_MODE` default true                                   |
| Portfolio     | 4004                      | Kafka consumer; no Temporal                                |
| Postgres 18   | 5432                      | One cluster: four service databases plus the Temporal pair |
| Kafka (KRaft) | 9092 host, 29092 internal | `PLAINTEXT_HOST` outside, `PLAINTEXT` inside compose       |
| Temporal      | 7233                      | Auto-setup against Postgres                                |
| Temporal UI   | 8080                      | Points at `temporal:7233`                                  |

## Secrets

`SESSION_SECRET` and `INTERNAL_SECRET` have no defaults. Generate a random 32-byte hex value for each. `INTERNAL_SECRET` must match in the gateway and every service that validates it. Changing `SESSION_SECRET` invalidates existing cookies. Never commit `.env`. Compose interpolates both secrets from the root `.env`.

Generate values with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Production effects of `NODE_ENV`

When `NODE_ENV=production`, the gateway rejects non-GET/HEAD/OPTIONS requests whose `Origin` header differs from `WEB_ORIGIN` (403 `ORIGIN_FORBIDDEN`), and sets the `Secure` flag on the session cookie. Keep `WEB_ORIGIN` exact, including scheme and port.

## Compose overrides

The overlay file `compose.services.yml` overrides host defaults for container networking: service URLs use `http://<service>:<port>`, hosts bind `0.0.0.0`, `KAFKA_BROKERS` is `kafka:29092`, and `TEMPORAL_ADDRESS` is `temporal:7233`. Secrets interpolate from the root `.env`. The web app stays local. Check the resolved config with:

```powershell
docker compose -f docker-compose.yml -f compose.services.yml --profile microservices config
```

## Minimal `.env` example

Use placeholders. Never paste real secrets into docs or chat.

```dotenv
AUTH_DATABASE_URL=postgres://credit:credit@localhost:5432/credit_auth
APPLICATIONS_DATABASE_URL=postgres://credit:credit@localhost:5432/credit_applications
LOANS_DATABASE_URL=postgres://credit:credit@localhost:5432/credit_loans
PORTFOLIO_DATABASE_URL=postgres://credit:credit@localhost:5432/credit_portfolio
SESSION_SECRET=<32-byte-hex-secret>
INTERNAL_SECRET=<32-byte-hex-secret>
TEMPORAL_ADDRESS=localhost:7233
KAFKA_BROKERS=localhost:9092
APPLICATIONS_URL=http://127.0.0.1:4001
REVIEW_URL=http://127.0.0.1:4002
LOANS_URL=http://127.0.0.1:4003
PORTFOLIO_URL=http://127.0.0.1:4004
API_PORT=3001
API_HOST=127.0.0.1
WEB_ORIGIN=http://localhost:3000
DEMO_MODE=true
NODE_ENV=development
```

`VITE_API_URL=/api` stays in `.env.example` as an unused example. No code reads it. Leave it out or keep it; it has no effect.

## Related

- [Run and verify](../getting-started.md) — use these values to start the demo.
- [API](api.md) — base URLs and auth behavior.
- [Docs entry point](../index.md) — docs entry point.
- [Troubleshooting](../operations/troubleshooting.md) — fix misconfiguration failures.
- [Extend the pipeline](../how-to/extend-the-pipeline.md) — add variables safely.
