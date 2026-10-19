import { createDb } from "@credit/db";
import { createLogger, createTemporalGateway } from "@credit/service-kit";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const logger = createLogger("applications");
const { db, sql } = createDb(env.databaseUrl);
const gateway = createTemporalGateway({ address: env.temporalAddress });

const app = createApp({ db, sql, env, gateway, logger });

// Bun entry: `bun --watch --env-file=../../.env src/server.ts` (see
// package.json dev). Bun serves the default export; `app.ts` stays a pure
// Hono factory so tests keep importing it directly under Node/Vitest.
export default {
	port: env.port,
	hostname: env.host,
	// Bun's default 10s idle timeout would pre-empt the 45s demo/review calls.
	idleTimeout: 60,
	fetch(req: Request) {
		return app.fetch(req);
	},
};

console.log(`applications listening on http://${env.host}:${env.port}`);
