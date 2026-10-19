import { fileURLToPath } from "node:url";
import { createEnv } from "@t3-oss/env-core";
import dotenv from "dotenv";
import { z } from "zod";

// Root env is passed by the Bun dev script (`--env-file=../../.env`);
// dotenv covers Node/Vitest imports. t3-env validates and types it.
dotenv.config({
	path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

const parsed = createEnv({
	server: {
		APPLICATIONS_DATABASE_URL: z.string().min(1),
		TEMPORAL_ADDRESS: z.string().min(1).default("localhost:7233"),
		INTERNAL_SECRET: z.string().min(1),
		PORT: z.coerce.number().int().min(1).max(65_535).default(4001),
		HOST: z.string().min(1).default("127.0.0.1"),
	},
	runtimeEnv: process.env,
	emptyStringAsUndefined: true,
	skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});

export const env = {
	databaseUrl: parsed.APPLICATIONS_DATABASE_URL,
	temporalAddress: parsed.TEMPORAL_ADDRESS,
	internalSecret: parsed.INTERNAL_SECRET,
	port: parsed.PORT,
	host: parsed.HOST,
};

export type ApplicationsEnv = typeof env;

export function loadEnv(): ApplicationsEnv {
	return env;
}
