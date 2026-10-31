// Shared construction of the integrity runner and run deps, used by the Bun API
// (server.ts) and the Node agent worker (agent-worker.ts). Keep it free of
// runtime-specific imports so both can load it.
import type { Db } from "@credit/db/applications";
import type { Logger } from "@credit/service-kit";
import { createAgentsIntegrityRunner } from "../agents/integrity/index.js";
import type { loadEnv } from "../env.js";
import type { IntegrityRunDeps } from "./runs.js";
import type { IntegrityAgentRunner } from "./types.js";

type Env = ReturnType<typeof loadEnv>;

export function createIntegrityRunnerFromEnv(
	env: Env,
	logger: Logger,
): IntegrityAgentRunner | null {
	return env.integrity.agentEnabled && env.integrity.openRouterApiKey
		? createAgentsIntegrityRunner({
				apiKey: env.integrity.openRouterApiKey,
				baseUrl: env.integrity.openRouterBaseUrl,
				model: env.integrity.model,
				agentVersion: env.integrity.agentVersion,
				promptVersion: env.integrity.promptVersion,
				maxToolCalls: env.integrity.maxToolCalls,
				maxOutputTokens: env.integrity.maxOutputTokens,
				timeoutMs: env.integrity.timeoutMs,
				logger,
			})
		: null;
}

/**
 * Queued integrity runs are dispatched only when a model runner exists and a
 * feature flag is on (the condition the old polling worker started under).
 */
export function integrityDispatchEnabled(env: Env, runner: IntegrityAgentRunner | null): boolean {
	return runner !== null && (env.integrity.enabled || env.integrity.fraudReviewEnabled);
}

export function integrityRunDepsFromEnv(input: {
	env: Env;
	db: Db;
	logger: Logger;
	runner: IntegrityAgentRunner | null;
	starter?: IntegrityRunDeps["starter"];
}): IntegrityRunDeps {
	return {
		db: input.db,
		config: input.env.integrity,
		runner: input.runner,
		logger: input.logger,
		starter: input.starter ?? null,
	};
}
