import type { Sql } from "postgres";
import { checkDb, createService, type Logger, type ServiceApp } from "@credit/service-kit";
import type { PolicyEnv } from "./env.js";
import { createPolicyRoutes } from "./routes.js";
import type { Embedder, PolicyAnswerer, PolicyStore } from "./store.js";

export interface PolicyAppDeps {
	sql: Sql;
	env: PolicyEnv;
	logger: Logger;
	store: PolicyStore;
	embedder: Embedder;
	answerer: PolicyAnswerer;
}

export function checkConfig(env: PolicyEnv): { ok: boolean; error?: string } {
	if (!env.assistEnabled) return { ok: true };
	if (!env.openrouterApiKey) return { ok: false, error: "OPENROUTER_API_KEY is not configured" };
	if (!env.citationSecret || !env.auditHashSecret || !env.caseTokenSecret) {
		return { ok: false, error: "policy signing secrets are not configured" };
	}
	return { ok: true };
}

export function createApp(deps: PolicyAppDeps): ServiceApp {
	const routes = createPolicyRoutes({
		store: deps.store,
		embedder: deps.embedder,
		answerer: deps.answerer,
		env: deps.env,
		logger: deps.logger,
	});
	return createService({
		name: "policy",
		secret: deps.env.internalSecret,
		// /api/* is the gateway identity signed with INTERNAL_SECRET;
		// /internal/* is the research service with its own secret.
		apiSecret: deps.env.internalSecret,
		internalSecret: deps.env.policyInternalSecret,
		logger: deps.logger,
		routes,
		health: async () => ({
			db: await checkDb(() => deps.sql`SELECT 1`),
			config: checkConfig(deps.env),
		}),
	});
}
