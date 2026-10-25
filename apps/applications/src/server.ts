import { createDb } from "@credit/db";
import { createLogger, createTemporalGateway } from "@credit/service-kit";
import { assertDemoBoot } from "@credit/core";
import { createApp } from "./app.js";
import { createOpenRouterMemoModel, startArtifactRetention } from "./assist/index.js";
import { configFromEnv } from "./documents/index.js";
import { startDocumentMaintenance } from "./documents/retention.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const logger = createLogger("applications");
const { db, sql } = createDb(env.databaseUrl);
const gateway = createTemporalGateway({ address: env.temporalAddress });

// D2a boot gate (SPEC-t17-t18 §4/§5): reset-allowed in production refuses to
// boot; in DEMO_MODE both blob roots must be demo-allowlisted (reset wipes
// them, so a mispointed root must fail fast, not at 3am).
assertDemoBoot({
	demoMode: env.demo.mode,
	nodeEnv: env.nodeEnv,
	demoResetAllowed: env.demo.resetAllowed,
	documentStorageDir: configFromEnv(env).storageDir,
	customerStorageDir: env.customer.storageDir,
});

const app = createApp({
	db,
	sql,
	env,
	gateway,
	logger,
	// Agent writer only: without an OpenRouter key there is no model, so the
	// memo route fails closed with a typed 503. Never fail process startup.
	assist:
		env.assist.memoWriter === "agent" && env.assist.openRouterApiKey
			? {
					memoModel: createOpenRouterMemoModel({
						apiKey: env.assist.openRouterApiKey,
						baseUrl: env.assist.openRouterBaseUrl,
						model: env.assist.memoModel,
						maxOutputTokens: env.assist.memoMaxOutputTokens,
						timeoutMs: env.assist.memoTimeoutMs,
					}),
				}
			: undefined,
});

// D1b document maintenance (SPEC-t01-t02 §6): boot + daily sweep of
// document orphans and retention. Retention runs even with the upload
// feature flag off; the orphan sweep needs blob storage (dir + key).
// T17: the app sweep stays scoped to the T01 application root — the
// customer evidence root rides the separate D2a customer sweep (same
// per-customer lock as reuse) below.
const documentConfig = configFromEnv(env);
startDocumentMaintenance({
	db,
	lockTimeoutMs: documentConfig.lockTimeoutMs,
	storageDir: documentConfig.storageDir,
	uploadDeadlineMs: documentConfig.uploadDeadlineMs,
	storageConfigured: documentConfig.storageDir.length > 0 && !!documentConfig.encryptionKey,
	customerStorageDir: env.customer.storageDir,
	// Fixture-owned customer rows expire on the fixture clock in demo mode;
	// live rows always use the wall clock.
	customerDemoAsOf: env.demo.mode ? env.demo.asOf : undefined,
	logger,
});

// EN-02 artifact retention: boot + daily tombstone sweep. It runs even when
// the assist flag is off so a disabled feature still honours retention.
startArtifactRetention({ db, logger });

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
