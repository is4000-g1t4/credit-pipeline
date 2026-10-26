import { fileURLToPath } from "node:url";
import { createEnv } from "@t3-oss/env-core";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({
	path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

const schema = {
	POLICY_DATABASE_URL: z
		.string()
		.min(1)
		.default("postgres://credit:credit@localhost:5432/credit_policy"),
	PORT: z.coerce.number().int().min(1).max(65_535).default(4006),
	HOST: z.string().min(1).default("127.0.0.1"),
	// Gateway-signed user identity. The policy service accepts only this on /api/*.
	INTERNAL_SECRET: z.string().min(1).default("dev-internal-secret"),
	// Dedicated research→policy secret on /internal/*; never the gateway secret.
	POLICY_INTERNAL_SECRET: z.string().min(1).default("dev-policy-internal-secret"),
	POLICY_CASE_TOKEN_SECRET: z.string().min(1).default("dev-policy-case-token-secret"),
	POLICY_CITATION_SECRET: z.string().min(1).default("dev-policy-citation-secret"),
	POLICY_AUDIT_HASH_SECRET: z.string().min(1).default("dev-policy-audit-secret"),
	// EN-07 second HMAC: the policy service is the intended consumer of the
	// applications rule-failure contract.
	POLICY_RULE_CONTEXT_SECRET: z.string().min(16).default("dev-policy-rule-context-secret"),
	POLICY_EXCEPTION_DAILY_BUDGET_USD: z.coerce.number().min(0).default(2),
	OPENROUTER_API_KEY: z.string().default(""),
	OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
	POLICY_ASSIST_ENABLED: z.string().default("false"),
	POLICY_AGENT_MODEL: z.string().min(1).default("deepseek/deepseek-v4.1-flash-1017"),
	POLICY_AGENT_TEMPERATURE: z.coerce.number().min(0).max(1).default(0),
	// DeepSeek emits reasoning tokens; 2k was exhausted on multi-section
	// case prompts, yielding an empty content field. 6k leaves room for the
	// JSON answer while the per-query cost cap still bounds spend.
	POLICY_AGENT_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(8_000).default(6_000),
	POLICY_AGENT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(60_000),
	POLICY_CASE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(45_000),
	POLICY_AGENT_MAX_COST_USD: z.coerce.number().min(0).default(0.1),
	POLICY_CASE_MAX_COST_USD: z.coerce.number().min(0).default(0.2),
	POLICY_NAV_DAILY_BUDGET_USD: z.coerce.number().min(0).default(2),
	POLICY_CASE_DAILY_BUDGET_USD: z.coerce.number().min(0).default(2),
	POLICY_ACTOR_DAILY_BUDGET_USD: z.coerce.number().min(0).default(1),
	POLICY_RESERVATION_TTL_SECONDS: z.coerce.number().int().min(1).default(180),
	POLICY_EMBEDDING_MODEL: z.string().min(1).default("voyageai/voyage-4-large"),
	POLICY_EMBEDDING_DIMENSIONS: z.coerce.number().int().min(1).max(16_000).default(1024),
	POLICY_EMBEDDING_PROVIDERS: z.string().default(""),
	POLICY_ANSWERER_PROVIDER_ORDER: z.string().default(""),
	POLICY_RETRIEVAL_TOP_K: z.coerce.number().int().min(1).max(20).default(8),
	POLICY_JURISDICTION: z
		.string()
		.regex(/^[A-Z]{2}$/)
		.default("SG"),
	POLICY_EDITOR_PRINCIPAL: z.string().min(1).default("service:policy_editor"),
	DEMO_MODE: z.string().default("false"),
	AUTH_DATABASE_URL: z.string().optional(),
};

const parsed = createEnv({
	server: schema,
	runtimeEnv: process.env,
	emptyStringAsUndefined: true,
	skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});

export const env = {
	databaseUrl: parsed.POLICY_DATABASE_URL,
	port: parsed.PORT,
	host: parsed.HOST,
	internalSecret: parsed.INTERNAL_SECRET,
	policyInternalSecret: parsed.POLICY_INTERNAL_SECRET,
	caseTokenSecret: parsed.POLICY_CASE_TOKEN_SECRET,
	citationSecret: parsed.POLICY_CITATION_SECRET,
	auditHashSecret: parsed.POLICY_AUDIT_HASH_SECRET,
	ruleContextSecret: parsed.POLICY_RULE_CONTEXT_SECRET,
	policyExceptionDailyBudgetUsd: parsed.POLICY_EXCEPTION_DAILY_BUDGET_USD,
	openrouterApiKey: parsed.OPENROUTER_API_KEY,
	openrouterBaseUrl: parsed.OPENROUTER_BASE_URL,
	assistEnabled: parsed.POLICY_ASSIST_ENABLED.trim().toLowerCase() === "true",
	agentModel: parsed.POLICY_AGENT_MODEL,
	agentTemperature: parsed.POLICY_AGENT_TEMPERATURE,
	agentMaxOutputTokens: parsed.POLICY_AGENT_MAX_OUTPUT_TOKENS,
	agentTimeoutMs: parsed.POLICY_AGENT_TIMEOUT_MS,
	caseTimeoutMs: parsed.POLICY_CASE_TIMEOUT_MS,
	agentMaxCostUsd: parsed.POLICY_AGENT_MAX_COST_USD,
	caseMaxCostUsd: parsed.POLICY_CASE_MAX_COST_USD,
	navDailyBudgetUsd: parsed.POLICY_NAV_DAILY_BUDGET_USD,
	caseDailyBudgetUsd: parsed.POLICY_CASE_DAILY_BUDGET_USD,
	actorDailyBudgetUsd: parsed.POLICY_ACTOR_DAILY_BUDGET_USD,
	reservationTtlSeconds: parsed.POLICY_RESERVATION_TTL_SECONDS,
	embeddingModel: parsed.POLICY_EMBEDDING_MODEL,
	embeddingDimensions: parsed.POLICY_EMBEDDING_DIMENSIONS,
	embeddingProviders: parsed.POLICY_EMBEDDING_PROVIDERS,
	answererProviderOrder: parsed.POLICY_ANSWERER_PROVIDER_ORDER,
	retrievalTopK: parsed.POLICY_RETRIEVAL_TOP_K,
	jurisdiction: parsed.POLICY_JURISDICTION,
	editorPrincipal: parsed.POLICY_EDITOR_PRINCIPAL,
	demoMode: parsed.DEMO_MODE.trim().toLowerCase() === "true",
	authDatabaseUrl: parsed.AUTH_DATABASE_URL,
};

export type PolicyEnv = typeof env;
export const loadEnv = (): PolicyEnv => env;
