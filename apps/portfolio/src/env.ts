import { fileURLToPath } from "node:url";
import { createEnv } from "@t3-oss/env-core";
import dotenv from "dotenv";
import { z } from "zod";

// Root env via `--env-file=../../.env` (Bun) and dotenv (Node/Vitest).
// Portfolio owns the read model, so it also validates Kafka + sibling URLs.
dotenv.config({
	path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

const parsed = createEnv({
	server: {
		PORTFOLIO_DATABASE_URL: z.string().min(1),
		KAFKA_BROKERS: z.string().min(1).default("localhost:9092"),
		APPLICATIONS_URL: z.string().url().default("http://127.0.0.1:4001"),
		LOANS_URL: z.string().url().default("http://127.0.0.1:4003"),
		INTERNAL_SECRET: z.string().min(1),
		PORT: z.coerce.number().int().min(1).max(65_535).default(4004),
		HOST: z.string().min(1).default("127.0.0.1"),
	},
	runtimeEnv: process.env,
	emptyStringAsUndefined: true,
	skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});

export const env = {
	databaseUrl: parsed.PORTFOLIO_DATABASE_URL,
	kafkaBrokers: parsed.KAFKA_BROKERS,
	applicationsUrl: parsed.APPLICATIONS_URL,
	loansUrl: parsed.LOANS_URL,
	internalSecret: parsed.INTERNAL_SECRET,
	port: parsed.PORT,
	host: parsed.HOST,
};

export type PortfolioEnv = typeof env;

export function loadEnv(): PortfolioEnv {
	return env;
}
