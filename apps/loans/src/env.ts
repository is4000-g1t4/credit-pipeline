import { fileURLToPath } from "node:url";
import { createEnv } from "@t3-oss/env-core";
import dotenv from "dotenv";
import { z } from "zod";

// Root env via `--env-file=../../.env` (Bun) and dotenv (Node/Vitest).
dotenv.config({
	path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

const parsed = createEnv({
	server: {
		LOANS_DATABASE_URL: z.string().min(1),
		TEMPORAL_ADDRESS: z.string().min(1).default("localhost:7233"),
		INTERNAL_SECRET: z.string().min(1),
		DEMO_MODE: z.enum(["true", "false"]).default("true"),
		PORT: z.coerce.number().int().min(1).max(65_535).default(4003),
		HOST: z.string().min(1).default("127.0.0.1"),
	},
	runtimeEnv: process.env,
	emptyStringAsUndefined: true,
	skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});

export const env = {
	databaseUrl: parsed.LOANS_DATABASE_URL,
	temporalAddress: parsed.TEMPORAL_ADDRESS,
	internalSecret: parsed.INTERNAL_SECRET,
	demoMode: parsed.DEMO_MODE === "true",
	port: parsed.PORT,
	host: parsed.HOST,
};

export type LoansEnv = typeof env;

export function loadEnv(): LoansEnv {
	return env;
}
