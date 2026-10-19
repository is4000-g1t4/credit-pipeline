import { fileURLToPath } from "node:url";
import { createEnv } from "@t3-oss/env-core";
import dotenv from "dotenv";
import { z } from "zod";

// The Temporal worker runs on Node (not Bun), so dotenv loads the workspace
// root .env here; t3-env validates the two DB handles plus infra endpoints.
dotenv.config({
	path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

const parsed = createEnv({
	server: {
		APPLICATIONS_DATABASE_URL: z.string().min(1),
		LOANS_DATABASE_URL: z.string().min(1),
		TEMPORAL_ADDRESS: z.string().min(1).default("localhost:7233"),
		KAFKA_BROKERS: z.string().min(1).default("localhost:9092"),
	},
	runtimeEnv: process.env,
	emptyStringAsUndefined: true,
	skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});

export const workerEnv = {
	applicationsDatabaseUrl: parsed.APPLICATIONS_DATABASE_URL,
	loansDatabaseUrl: parsed.LOANS_DATABASE_URL,
	temporalAddress: parsed.TEMPORAL_ADDRESS,
	kafkaBrokers: parsed.KAFKA_BROKERS,
};

export type WorkerEnv = typeof workerEnv;
