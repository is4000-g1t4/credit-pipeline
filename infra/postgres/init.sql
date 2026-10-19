-- Database-per-service (Wave P2) + Temporal databases. Runs only on first
-- init of the pgdata volume. \gexec works around "CREATE DATABASE cannot
-- run inside a transaction block". Existing volumes (e.g. PG17 data) are
-- provisioned instead by `pnpm db:init` (scripts/db-init.ts).
SELECT 'CREATE DATABASE credit_auth'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'credit_auth')\gexec
SELECT 'CREATE DATABASE credit_applications'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'credit_applications')\gexec
SELECT 'CREATE DATABASE credit_loans'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'credit_loans')\gexec
SELECT 'CREATE DATABASE credit_portfolio'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'credit_portfolio')\gexec
SELECT 'CREATE DATABASE temporal'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'temporal')\gexec
SELECT 'CREATE DATABASE temporal_visibility'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'temporal_visibility')\gexec
