// Shared runtime wiring for the two research Node entries: the HTTP server
// (server.ts) and the Temporal agent worker (agent-worker.ts). Both build the
// same real runners/judge/repair/observability so a run behaves identically
// wherever it executes.
import { createOpenRouterClient, type RetryEvent } from "@credit/agent-kit";
import { createAgentRunStarter, type AgentRunStarter } from "@credit/agent-kit/temporal/client";
import { AGENT_TASK_QUEUES } from "@credit/agent-kit/temporal/types";
import { createDb } from "@credit/db/research";
import { createLogger } from "@credit/service-kit";
import { createRealCaseAssistantRunner } from "./agents/case-assistant/index.js";
import {
	createLlmLanguageRepair,
	createLlmSupportJudge,
	createRealRunner,
	createTavilyClient,
} from "./agents/case-brief/index.js";
import { createRealContextRunner } from "./agents/context-analyst/index.js";
import { createHttpPolicyRunner } from "./agents/policy-review/index.js";
import { aggregateRun } from "./aggregate.js";
import { loadEnv } from "./env.js";
import { latestRunForApplication } from "./lifecycle.js";
import { getObservability } from "./observability.js";

export function createResearchRuntime() {
	const env = loadEnv();
	const logger = createLogger("research");
	const { db, sql } = createDb(env.databaseUrl);

	// Transient failures (408/409/429/5xx, network errors) retry through
	// agent-kit's retrying fetch. Only metadata is logged, never bodies.
	const logRetry =
		(agent: string, what: string) =>
		({ attempt, reason, status, delayMs }: RetryEvent): void => {
			logger.warn({ agent, attempt, reason, status, delayMs }, `${what} retry`);
		};
	const modelClient = (agent: string) =>
		createOpenRouterClient({
			apiKey: env.openrouterApiKey || "unconfigured",
			retry: { onRetry: logRetry(agent, "model call") },
		});
	const tavily = createTavilyClient({
		apiKey: env.tavilyApiKey,
		retry: { onRetry: logRetry("case-brief", "tavily request") },
	});
	const briefClient = modelClient("case-brief");
	const contextClient = modelClient("context-analyst");
	const caseAssistantClient = modelClient("case-assistant");
	// Same cached instance createApp defaults to: direct repair/judge calls join
	// the run conversation without a second pipeline.
	const observability = getObservability();
	const runner = createRealRunner({ env, tavily, openai: briefClient });
	const judge = createLlmSupportJudge(briefClient, env.agentModel, { observability });
	const repair = createLlmLanguageRepair(briefClient, env.agentModel, { observability });
	const contextRunner = createRealContextRunner({ env, openai: contextClient });
	const policyRunner = createHttpPolicyRunner(env);
	const caseAssistant = createRealCaseAssistantRunner({
		env,
		openai: caseAssistantClient,
		// The assistant may cite the case's latest succeeded external brief.
		// Research owns that DB, so the runner never crosses a service boundary.
		loadExternalSummary: async (applicationId) => {
			const run = await latestRunForApplication(db, applicationId);
			if (!run || run.status !== "succeeded") return null;
			const aggregate = await aggregateRun(db, run, env.autoTriggerServiceUserId, {
				includeContext: false,
				includePolicy: false,
			});
			return aggregate.brief ?? null;
		},
	});
	const execDeps = {
		db,
		env,
		logger,
		runner,
		judge,
		repair,
		observability,
		contextRunner,
		policyRunner,
	};
	return { ...execDeps, sql, caseAssistant, execDeps };
}

/** Workflow starter on the research task queue (lazy connect; Bun-safe client). */
export function createResearchStarter(temporalAddress: string): AgentRunStarter {
	return createAgentRunStarter({
		address: temporalAddress,
		taskQueue: AGENT_TASK_QUEUES.research,
	});
}
