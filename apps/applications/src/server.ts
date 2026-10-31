import { createAgentRunStarter } from "@credit/agent-kit/temporal/client";
import { AGENT_TASK_QUEUES } from "@credit/agent-kit/temporal/types";
import { createDb } from "@credit/db";
import { createLogger, createTemporalGateway } from "@credit/service-kit";
import { assertDemoBoot } from "@credit/service-kit";
import { createApp } from "./app.js";
import {
	createAgentsPolicyExceptionRunner,
	createHttpPolicyClient,
} from "./agents/policy-exception/index.js";
import { createAgentsMemoRunner, startArtifactRetention } from "./assist/index.js";
import { applicationObservability } from "./observability.js";
import { createIntegrityRunnerFromEnv, integrityDispatchEnabled } from "./integrity/wiring.js";
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

const integrityRunner = createIntegrityRunnerFromEnv(env, logger);
// Integrity runs execute in the Node agent worker (src/agent-worker.ts); the
// API only starts their Temporal workflows, and only when a model runner exists
// and a feature flag is on.
const integrityStarter = integrityDispatchEnabled(env, integrityRunner)
	? createAgentRunStarter({
			address: env.temporalAddress,
			taskQueue: AGENT_TASK_QUEUES.applications,
		})
	: null;

// Start the OTel providers before any agent client is used. Metadata-only;
// a missing endpoint/token degrades observability, never the service.
applicationObservability();

const app = createApp({
	db,
	sql,
	env,
	gateway,
	logger,
	// Agent writer only: without an OpenRouter key there is no runner, so
	// the memo route fails closed with a typed 503. Never fail process startup.
	assist: {
		...(env.assist.memoWriter === "agent" && env.assist.openRouterApiKey
			? {
					memoAgentRunner: createAgentsMemoRunner({
						apiKey: env.assist.openRouterApiKey,
						baseUrl: env.assist.openRouterBaseUrl,
						model: env.assist.memoModel,
						agentVersion: env.assist.memoAgentVersion,
						promptVersion: env.assist.memoPromptVersion,
						maxToolCalls: env.assist.memoMaxToolCalls,
						maxOutputTokens: env.assist.memoMaxOutputTokens,
						timeoutMs: env.assist.memoTimeoutMs,
						logger,
					}),
				}
			: {}),
		...(env.assist.policyUrl && env.assist.policyInternalSecret
			? {
					policyClient: createHttpPolicyClient({
						baseUrl: env.assist.policyUrl,
						secret: env.assist.policyInternalSecret,
						timeoutMs: env.assist.policyTimeoutMs,
					}),
				}
			: {}),
		...(env.assist.policyExceptionEnabled &&
		env.assist.openRouterApiKey &&
		env.assist.policyUrl &&
		env.assist.policyInternalSecret
			? {
					// ponytail: single shared runner; per-request officer identity
					// rides the policy-client audit via the route actor when scaled.
					policyExceptionAgentRunner: createAgentsPolicyExceptionRunner({
						apiKey: env.assist.openRouterApiKey,
						baseUrl: env.assist.openRouterBaseUrl,
						model: env.assist.policyExceptionModel,
						agentVersion: env.assist.policyExceptionAgentVersion,
						promptVersion: env.assist.policyExceptionPromptVersion,
						validatorVersion: env.assist.policyExceptionValidatorVersion,
						artifactType: "policy_exception_memo",
						maxToolCalls: env.assist.policyExceptionMaxToolCalls,
						maxOutputTokens: env.assist.policyExceptionMaxOutputTokens,
						timeoutMs: env.assist.policyExceptionTimeoutMs,
						logger,
						policyClient: createHttpPolicyClient({
							baseUrl: env.assist.policyUrl,
							secret: env.assist.policyInternalSecret,
							timeoutMs: env.assist.policyTimeoutMs,
						}),
						actorId: "00000000-0000-0000-0000-000000000000",
						actorRole: "officer",
					}),
				}
			: {}),
	},
	integrity: { agentRunner: integrityRunner ?? undefined, starter: integrityStarter },
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
	fraudReviewEnabled: env.integrity.fraudReviewEnabled,
	logger,
});

// EN-02 artifact retention: boot + daily tombstone sweep. It runs even when
// the assist flag is off so a disabled feature still honours retention.
startArtifactRetention({
	db,
	logger,
	fraudReviewEnabled: env.integrity.fraudReviewEnabled,
});

// Bun entry: `bun --watch --env-file=../../.env src/server.ts` (see
// package.json dev). Bun serves the default export; `app.ts` stays a pure
// Hono factory so tests keep importing it directly under Node/Vitest.
export default {
	port: env.port,
	hostname: env.host,
	// Bun's default 10s idle timeout would pre-empt long demo/review calls;
	// agentic memo generation can take ~80s, so keep this above the
	// applications-side memo timeout (max 255).
	idleTimeout: 180,
	fetch(req: Request) {
		return app.fetch(req);
	},
};

console.log(`applications listening on http://${env.host}:${env.port}`);
