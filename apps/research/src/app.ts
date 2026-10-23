import { type Db } from "@credit/db/research";
import type { Sql } from "postgres";
import {
	checkDb,
	createLogger,
	createService,
	type Logger,
	type ServiceApp,
} from "@credit/service-kit";
import type { AgentRunner } from "./agent.js";
import { getAutoTriggerStatus } from "./auto-trigger.js";
import type { ContextAgentRunner } from "./context-agent.js";
import type { ResearchEnv } from "./env.js";
import { getObservability, type Observability } from "./observability.js";
import type { LanguageRepair } from "./repair.js";
import { researchRoutes } from "./routes.js";
import type { SupportJudge } from "./support.js";
import type { PolicyRunner } from "./policy-stage.js";

export interface ResearchDeps {
	db: Db;
	sql: Sql;
	env: ResearchEnv;
	logger: Logger;
	runner: AgentRunner;
	judge: SupportJudge;
	repair: LanguageRepair;
	observability?: Observability;
	contextRunner: ContextAgentRunner;
	/** Test seam: fresh context-consent probe; default reads research-context over HMAC. */
	fetchContextConsent?: (applicationId: string) => Promise<boolean>;
	/** T03/T04 automatic case policy review; absent fails the policy stage only. */
	policyRunner?: PolicyRunner;
}

/** Test seam: pass fakes for runner/judge/repair; production wires the real ones. */
export function createApp(deps: ResearchDeps): ServiceApp {
	const observability = deps.observability ?? getObservability();
	const routes: ServiceApp = researchRoutes({
		db: deps.db,
		env: deps.env,
		logger: deps.logger,
		runner: deps.runner,
		judge: deps.judge,
		repair: deps.repair,
		observability,
		contextRunner: deps.contextRunner,
		fetchContextConsent: deps.fetchContextConsent,
		policyRunner: deps.policyRunner,
	});
	return createService({
		name: "research",
		secret: deps.env.internalSecret,
		logger: deps.logger,
		routes,
		health: async () => {
			const db = await checkDb(() => deps.sql`SELECT 1`);
			const config = checkConfig(deps.env);
			// Informational only: a degraded Grafana pipeline never fails
			// readiness (it never fails a run or decision either). The
			// extra `status` field rides the checks map like checkOutbox's
			// backlog counters — readiness reads `ok` alone.
			const observabilityInfo = { ok: true, status: observability.status };
			// Informational only: the auto-trigger consumer is best-effort
			// like Grafana (Kafka down never fails readiness).
			const auto = getAutoTriggerStatus();
			const autoTrigger = { ok: true, enabled: auto.enabled, connected: auto.connected };
			return { db, config, observability: observabilityInfo, autoTrigger };
		},
	});
}

/** DB + config readiness. Observability is informational (see above),
 * never part of readiness. Keys are required only when the feature is
 * enabled; a disabled deployment is ready without them. Runs stay
 * fail-closed: a missing key still finalizes the run as config_error. */
export function checkConfig(env: ResearchEnv): { ok: boolean; error?: string } {
	if (!env.agentsEnabled) return { ok: true };
	if (!env.openrouterApiKey || !env.tavilyApiKey) {
		return { ok: false, error: "research keys are not configured" };
	}
	// Boot guard (§5): the context stage budget must not exceed the
	// external budget — auto caps reserve their sum per in-flight run.
	if (env.contextMaxCostUsd > env.maxCostUsd) {
		return { ok: false, error: "context stage budget exceeds the external budget" };
	}
	return { ok: true };
}

export { createLogger };
