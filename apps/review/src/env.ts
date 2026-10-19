import { fileURLToPath } from "node:url";
import { createEnv } from "@t3-oss/env-core";
import dotenv from "dotenv";
import { z } from "zod";

// Root env via `--env-file=../../.env` (Bun) and dotenv (Node/Vitest).
// Review is stateless, so it validates only URLs, Temporal and the shared
// internal secret.
dotenv.config({
	path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

const parsed = createEnv({
	server: {
		APPLICATIONS_URL: z.string().url().default("http://127.0.0.1:4001"),
		LOANS_URL: z.string().url().default("http://127.0.0.1:4003"),
		TEMPORAL_ADDRESS: z.string().min(1).default("localhost:7233"),
		INTERNAL_SECRET: z.string().min(1),
		PORT: z.coerce.number().int().min(1).max(65_535).default(4002),
		HOST: z.string().min(1).default("127.0.0.1"),
	},
	runtimeEnv: process.env,
	emptyStringAsUndefined: true,
	skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});

export const env = {
	applicationsUrl: parsed.APPLICATIONS_URL,
	loansUrl: parsed.LOANS_URL,
	temporalAddress: parsed.TEMPORAL_ADDRESS,
	internalSecret: parsed.INTERNAL_SECRET,
	port: parsed.PORT,
	host: parsed.HOST,
};

export type ReviewEnv = typeof env;

export function loadEnv(): ReviewEnv {
	return env;
}
