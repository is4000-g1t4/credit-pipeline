import { fileURLToPath } from "node:url";
import { assertProductionSecrets } from "@credit/service-kit";
import { createEnv } from "@t3-oss/env-core";
import dotenv from "dotenv";
import { z } from "zod";

// Bun auto-loads `.env` from its cwd; services run with cwd=apps/<name>, so
// package scripts pass the workspace root explicitly:
//   bun --watch --env-file=../../.env src/server.ts
// dotenv covers Node/Vitest imports (and direct `tsx` runs). t3-env then
// validates whatever ended up in process.env and fails fast with typed errors.
dotenv.config({
	path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

const parsed = createEnv({
	server: {
		NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
		API_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
		API_HOST: z.string().min(1).default("127.0.0.1"),
		SESSION_SECRET: z.string().min(1),
		INTERNAL_SECRET: z.string().min(1),
		AUTH_DATABASE_URL: z.string().min(1),
		TEMPORAL_ADDRESS: z.string().min(1).default("localhost:7233"),
		KAFKA_BROKERS: z.string().min(1).default("localhost:9092"),
		DEMO_MODE: z.enum(["true", "false"]).default("true"),
		WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
		APPLICATIONS_URL: z.string().url().default("http://127.0.0.1:4001"),
		REVIEW_URL: z.string().url().default("http://127.0.0.1:4002"),
		LOANS_URL: z.string().url().default("http://127.0.0.1:4003"),
		PORTFOLIO_URL: z.string().url().default("http://127.0.0.1:4004"),
		POLICY_URL: z.string().url().default("http://127.0.0.1:4006"),
		POLICY_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(75000),
		POLICY_ASK_RATE_PER_MIN: z.coerce.number().int().positive().default(10),
	},
	runtimeEnv: process.env,
	emptyStringAsUndefined: true,
	skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});

// Production refuses weak/default secrets (names only in the error).
// Enforced even with SKIP_ENV_VALIDATION (that flag only skips the zod schema).
assertProductionSecrets(
	{
		SESSION_SECRET: parsed.SESSION_SECRET,
		INTERNAL_SECRET: parsed.INTERNAL_SECRET,
	},
	{ nodeEnv: parsed.NODE_ENV },
);

/** Validated gateway config in the shape the app already consumes. */
export const env = {
	nodeEnv: parsed.NODE_ENV,
	demoMode: parsed.DEMO_MODE === "true",
	sessionSecret: parsed.SESSION_SECRET,
	internalSecret: parsed.INTERNAL_SECRET,
	databaseUrl: parsed.AUTH_DATABASE_URL,
	temporalAddress: parsed.TEMPORAL_ADDRESS,
	kafkaBrokers: parsed.KAFKA_BROKERS,
	webOrigin: parsed.WEB_ORIGIN,
	apiPort: parsed.API_PORT,
	apiHost: parsed.API_HOST,
	applicationsUrl: parsed.APPLICATIONS_URL,
	reviewUrl: parsed.REVIEW_URL,
	loansUrl: parsed.LOANS_URL,
	portfolioUrl: parsed.PORTFOLIO_URL,
	policyUrl: parsed.POLICY_URL,
	policyUpstreamTimeoutMs: parsed.POLICY_UPSTREAM_TIMEOUT_MS,
	policyAskRatePerMin: parsed.POLICY_ASK_RATE_PER_MIN,
};

export type GatewayEnv = typeof env;

/** Kept as the server/test seam; validation happens once at module load. */
export function loadEnv(): GatewayEnv {
	return env;
}
