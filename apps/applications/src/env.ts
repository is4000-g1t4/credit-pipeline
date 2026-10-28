import { fileURLToPath } from "node:url";
import { resolveWorkspacePath } from "@credit/service-kit";
import { MAX_UPLOAD_BYTES } from "@credit/service-kit";
import { createEnv } from "@t3-oss/env-core";
import dotenv from "dotenv";
import { z } from "zod";

// Root env is passed by the Bun dev script (`--env-file=../../.env`);
// dotenv covers Node/Vitest imports. t3-env validates and types it.
dotenv.config({
	path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

const optionalSecret = z.preprocess(
	(value) => (value === "" ? undefined : value),
	z.string().min(16).optional(),
);

const parsed = createEnv({
	server: {
		APPLICATIONS_DATABASE_URL: z.string().min(1),
		TEMPORAL_ADDRESS: z.string().min(1).default("localhost:7233"),
		INTERNAL_SECRET: z.string().min(1),
		PORT: z.coerce.number().int().min(1).max(65_535).default(4001),
		HOST: z.string().min(1).default("127.0.0.1"),
		// T01 document workflow (SPEC-t01-t02 §10). Everything carries a
		// safe default; the feature flag stays off until D1 lands. The
		// encryption key is optional here so the service still boots (and
		// stays gateway-healthy) without it — document uploads fail
		// closed later when the key is missing.
		DOCUMENT_FEATURE_ENABLED: z.enum(["true", "false"]).default("false"),
		DOCUMENT_STORAGE_DIR: z.string().min(1).default(".data/documents"),
		DOCUMENT_ENCRYPTION_KEY: z.string().min(1).optional(),
		DOCUMENT_KEY_ID: z.string().min(1).default("v1"),
		DOCUMENT_PREVIOUS_KEYS: z.string().min(1).optional(),
		DOCUMENT_MAX_BYTES: z.coerce.number().int().positive().default(10_485_760),
		DOCUMENT_MAX_PAGES: z.coerce.number().int().positive().default(20),
		DOCUMENT_MAX_PAGE_TEXT_BYTES: z.coerce.number().int().positive().default(262_144),
		DOCUMENT_MAX_TOTAL_TEXT_BYTES: z.coerce.number().int().positive().default(2_097_152),
		DOCUMENT_MAX_PIXELS: z.coerce.number().int().positive().default(16_000_000),
		DOCUMENT_UPLOAD_DEADLINE_MS: z.coerce.number().int().positive().default(35_000),
		DOCUMENT_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
		DOCUMENT_SCAN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
		DOCUMENT_OCR_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
		DOCUMENT_OCR_CONCURRENCY: z.coerce.number().int().positive().default(2),
		DOCUMENT_UPLOAD_RATE_PER_MIN: z.coerce.number().int().positive().default(5),
		DOCUMENT_OCR_DATA_DIR: z
			.string()
			.min(1)
			.default(fileURLToPath(new URL("../assets/tesseract", import.meta.url))),
		DOCUMENT_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
		DOCUMENT_SCANNER: z.string().min(1).default("clamd"),
		CLAMAV_HOST: z.string().min(1).default("127.0.0.1"),
		CLAMAV_PORT: z.coerce.number().int().min(1).max(65_535).default(3310),
		DOCUMENT_CROSSCHECK_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.7),
		// T17 customer evidence + intake (SPEC-t17-t18 §2/§5). The customer
		// blob root is disjoint from DOCUMENT_STORAGE_DIR so the T01 app
		// orphan sweep can never touch it. DEMO_AS_OF is the fixed fixture
		// clock (the D2 manifest owns the canonical value).
		CUSTOMER_STORAGE_DIR: z.string().min(1).default(".data/customer-documents"),
		CUSTOMER_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
		// T18 internal context reads (SPEC-t17-t18 §3.2/§3.3/§5, D3a).
		// Thresholds feed the deterministic v1 candidate signals; page and
		// account caps bound the service-only routes. Upper bounds fail
		// closed at boot so an operator cannot widen the tool budget.
		CONTEXT_HISTORY_MONTHS: z.coerce.number().int().min(1).max(36).default(6),
		CONTEXT_NEGATIVE_BALANCE_DAYS: z.coerce.number().int().min(1).default(3),
		CONTEXT_REVENUE_CONCENTRATION_PCT: z.coerce.number().min(1).max(100).default(40),
		CONTEXT_CASH_DEPOSIT_PCT: z.coerce.number().min(1).max(100).default(25),
		CONTEXT_FCF_VARIANCE_PCT: z.coerce.number().min(1).max(100).default(30),
		CONTEXT_CURSOR_SECRET: z.string().min(16).optional(),
		CONTEXT_TRANSACTIONS_PAGE_LIMIT: z.coerce.number().int().min(1).max(500).default(500),
		CONTEXT_TRANSACTIONS_MAX_PAGES: z.coerce.number().int().min(1).max(10).default(2),
		CONTEXT_METRICS_MAX_ACCOUNTS: z.coerce.number().int().min(1).max(10).default(10),
		DEMO_MODE: z.enum(["true", "false"]).default("false"),
		DEMO_AS_OF: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
			.default("2026-06-30"),
		// D2a demo fixtures/reset (SPEC-t17-t18 §2.5): the seed version must
		// match the manifest; reset is destructive and never allowed in prod.
		DEMO_SEED_VERSION: z.string().min(1).default("1"),
		DEMO_RESET_ALLOWED: z.enum(["true", "false"]).default("false"),
		NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
		// T18 context purge callback (SPEC-t17-t18 §4): when context consent
		// is withdrawn, PATCH best-effort notifies the research service
		// (service HMAC) to purge stored brief/signals. Unset (tests, local
		// dev without research) disables the callback — read gating on the
		// live consent flag still hides prior context immediately.
		RESEARCH_URL: z.string().url().optional(),
		// EN-01/02/03 case assist (evidence bundle, artifacts, generated-text
		// validation). Off by default: every assist route 404s while disabled.
		ASSIST_ENABLED: z.enum(["true", "false"]).default("false"),
		ASSIST_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
		ASSIST_RESEARCH_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),
		ASSIST_MODEL: z.string().min(1).default("deterministic"),
		ASSIST_PROMPT_VERSION: z.string().min(1).default("memo-template-v1"),
		// Agentic credit-memo writer (SPEC agentic-memo, wave B). `agent`
		// runs the bounded OpenRouter tool loop; default stays deterministic.
		ASSIST_MEMO_WRITER: z.enum(["deterministic", "agent"]).default("deterministic"),
		// Not model-compared: the memo eval is scripted
		// (docs/eval/applications/MEMO-AGENT-RESULTS.md).
		ASSIST_MEMO_MODEL: z.string().min(1).default("openai/gpt-6.1-sol"),
		ASSIST_MEMO_PROMPT_VERSION: z.string().min(1).default("memo-agent-v1"),
		ASSIST_MEMO_AGENT_VERSION: z.string().min(1).default("memo-agent-v1"),
		ASSIST_MEMO_MAX_STEPS: z.coerce.number().int().min(1).max(64).default(30),
		ASSIST_MEMO_MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(100).default(40),
		ASSIST_MEMO_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(90_000),
		ASSIST_MEMO_MAX_COST_USD: z.coerce.number().min(0).default(0.25),
		ASSIST_MEMO_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(32_000).default(4_000),
		OPENROUTER_API_KEY: z.string().min(1).optional(),
		OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
		// EN-08 adverse-action taxonomy/profile. SG is the v1 default; US is
		// available but must be selected explicitly. An unsupported value
		// disables the adverse-action route with a typed error.
		ASSIST_ADVERSE_JURISDICTION: z.string().min(1).default("SG"),
		// Required for a legal notice: an empty value fails the route closed
		// with 422 rather than pointing applicants at a placeholder domain.
		ASSIST_ADVERSE_CONTACT_PATH: z.string().default(""),
		ASSIST_ADVERSE_PROMPT_VERSION: z.string().min(1).default("adverse-letter-v1"),
		// E3 case policy/exception navigator. Off by default. Secrets are
		// optional while the flag is off; the feature gate validates them.
		ASSIST_POLICY_EXCEPTION_ENABLED: z.enum(["true", "false"]).default("false"),
		ASSIST_POLICY_EXCEPTION_RETENTION_DAYS: z.coerce.number().int().positive().default(2_555),
		POLICY_URL: z.preprocess(
			(value) => (value === "" ? undefined : value),
			z.string().url().optional(),
		),
		POLICY_INTERNAL_SECRET: optionalSecret,
		POLICY_RULE_CONTEXT_SECRET: optionalSecret,
		POLICY_AUDIT_HASH_SECRET: optionalSecret,
		ASSIST_POLICY_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(10_000),
		// Tie with Sol on quality; Terra is the cost pick:
		// docs/eval/applications/POLICY-EXCEPTION-MODELS-RESULTS.md.
		POLICY_EXCEPTION_MODEL: z.string().min(1).default("openai/gpt-6.1-terra"),
		POLICY_EXCEPTION_PROMPT_VERSION: z.string().min(1).default("policy-exception-v1"),
		POLICY_EXCEPTION_AGENT_VERSION: z.string().min(1).default("policy-exception-agent-v1"),
		POLICY_EXCEPTION_VALIDATOR_VERSION: z.string().min(1).default("policy-exception-validator-v1"),
		POLICY_EXCEPTION_MAX_STEPS: z.coerce.number().int().min(1).max(64).default(30),
		POLICY_EXCEPTION_MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(100).default(40),
		POLICY_EXCEPTION_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(120_000),
		POLICY_EXCEPTION_MAX_COST_USD: z.coerce.number().min(0).default(0.35),
		POLICY_EXCEPTION_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(32_000).default(8_000),
		POLICY_EXCEPTION_RATE_PER_MIN: z.coerce.number().int().min(1).max(120).default(10),
		// E2 document integrity + EN-05 fraud review. Flags default off; the
		// deterministic panel works without a model. The advisory brief needs
		// both feature flags and its own agent flag.
		DOCUMENT_INTEGRITY_ENABLED: z.enum(["true", "false"]).default("false"),
		FRAUD_REVIEW_ENABLED: z.enum(["true", "false"]).default("false"),
		DOCUMENT_INTEGRITY_AGENT_ENABLED: z.enum(["true", "false"]).default("false"),
		DOCUMENT_INTEGRITY_TRIAGE_ENABLED: z.enum(["true", "false"]).default("false"),
		// Document-integrity winner:
		// docs/eval/applications/INTEGRITY-MODELS-RESULTS.md.
		DOCUMENT_INTEGRITY_MODEL: z.string().min(1).default("openai/gpt-6.1-sol"),
		DOCUMENT_INTEGRITY_PROMPT_VERSION: z.string().min(1).default("integrity-analysis-v1"),
		DOCUMENT_INTEGRITY_AGENT_VERSION: z.string().min(1).default("integrity-agent-v1"),
		DOCUMENT_INTEGRITY_TRIAGE_PROMPT_VERSION: z.string().min(1).default("integrity-triage-v1"),
		DOCUMENT_INTEGRITY_MAX_STEPS: z.coerce.number().int().min(1).max(64).default(24),
		DOCUMENT_INTEGRITY_MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(100).default(32),
		DOCUMENT_INTEGRITY_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(90_000),
		DOCUMENT_INTEGRITY_MAX_COST_USD: z.coerce.number().min(0).default(0.25),
		DOCUMENT_INTEGRITY_MAX_OUTPUT_TOKENS: z.coerce
			.number()
			.int()
			.min(256)
			.max(32_000)
			.default(4_000),
		DOCUMENT_INTEGRITY_FLAG_SEVERITY: z.enum(["low", "medium", "high"]).default("high"),
		DOCUMENT_INTEGRITY_RETENTION_DAYS: z.coerce.number().int().positive().default(365),
		DOCUMENT_INTEGRITY_SYSTEM_USER_ID: z
			.string()
			.uuid()
			.default("00000000-0000-0000-0000-000000000000"),
		DOCUMENT_INTEGRITY_MAX_RUNS_PER_HASH: z.coerce.number().int().min(1).max(10).default(3),
		// HTTP body cap for the multipart upload path only (10 MB file +
		// overhead); every other /api/* route keeps the 100 KB JSON bound.
		DOCUMENT_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(MAX_UPLOAD_BYTES),
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
	documentUploadMaxBytes: parsed.DOCUMENT_UPLOAD_MAX_BYTES,
	documents: {
		featureEnabled: parsed.DOCUMENT_FEATURE_ENABLED === "true",
		// Relative roots anchor at the workspace root: services run with
		// cwd=package dir under `pnpm --filter`, scripts with cwd=root.
		storageDir: resolveWorkspacePath(parsed.DOCUMENT_STORAGE_DIR),
		encryptionKey: parsed.DOCUMENT_ENCRYPTION_KEY,
		keyId: parsed.DOCUMENT_KEY_ID,
		previousKeys: parsed.DOCUMENT_PREVIOUS_KEYS,
		maxBytes: parsed.DOCUMENT_MAX_BYTES,
		maxPages: parsed.DOCUMENT_MAX_PAGES,
		maxPageTextBytes: parsed.DOCUMENT_MAX_PAGE_TEXT_BYTES,
		maxTotalTextBytes: parsed.DOCUMENT_MAX_TOTAL_TEXT_BYTES,
		maxPixels: parsed.DOCUMENT_MAX_PIXELS,
		uploadDeadlineMs: parsed.DOCUMENT_UPLOAD_DEADLINE_MS,
		lockTimeoutMs: parsed.DOCUMENT_LOCK_TIMEOUT_MS,
		scanTimeoutMs: parsed.DOCUMENT_SCAN_TIMEOUT_MS,
		ocrTimeoutMs: parsed.DOCUMENT_OCR_TIMEOUT_MS,
		ocrConcurrency: parsed.DOCUMENT_OCR_CONCURRENCY,
		uploadRatePerMin: parsed.DOCUMENT_UPLOAD_RATE_PER_MIN,
		ocrDataDir: parsed.DOCUMENT_OCR_DATA_DIR,
		retentionDays: parsed.DOCUMENT_RETENTION_DAYS,
		scanner: parsed.DOCUMENT_SCANNER,
		clamavHost: parsed.CLAMAV_HOST,
		clamavPort: parsed.CLAMAV_PORT,
		crosscheckMinConfidence: parsed.DOCUMENT_CROSSCHECK_MIN_CONFIDENCE,
	},
	customer: {
		storageDir: resolveWorkspacePath(parsed.CUSTOMER_STORAGE_DIR),
		retentionDays: parsed.CUSTOMER_RETENTION_DAYS,
	},
	context: {
		historyMonths: parsed.CONTEXT_HISTORY_MONTHS,
		negativeBalanceDays: parsed.CONTEXT_NEGATIVE_BALANCE_DAYS,
		revenueConcentrationPct: parsed.CONTEXT_REVENUE_CONCENTRATION_PCT,
		cashDepositSharePct: parsed.CONTEXT_CASH_DEPOSIT_PCT,
		fcfVariancePct: parsed.CONTEXT_FCF_VARIANCE_PCT,
		cursorSecret: parsed.CONTEXT_CURSOR_SECRET,
		pageLimit: parsed.CONTEXT_TRANSACTIONS_PAGE_LIMIT,
		maxPages: parsed.CONTEXT_TRANSACTIONS_MAX_PAGES,
		maxAccounts: parsed.CONTEXT_METRICS_MAX_ACCOUNTS,
	},
	demo: {
		mode: parsed.DEMO_MODE === "true",
		asOf: new Date(`${parsed.DEMO_AS_OF}T00:00:00Z`),
		asOfRaw: parsed.DEMO_AS_OF,
		seedVersion: parsed.DEMO_SEED_VERSION,
		resetAllowed: parsed.DEMO_RESET_ALLOWED === "true",
	},
	researchUrl: parsed.RESEARCH_URL,
	assist: {
		enabled: parsed.ASSIST_ENABLED === "true",
		retentionDays: parsed.ASSIST_RETENTION_DAYS,
		researchUrl: parsed.RESEARCH_URL ?? null,
		researchTimeoutMs: parsed.ASSIST_RESEARCH_TIMEOUT_MS,
		internalSecret: parsed.INTERNAL_SECRET,
		model: parsed.ASSIST_MODEL,
		promptVersion: parsed.ASSIST_PROMPT_VERSION,
		memoWriter: parsed.ASSIST_MEMO_WRITER,
		memoModel: parsed.ASSIST_MEMO_MODEL,
		memoPromptVersion: parsed.ASSIST_MEMO_PROMPT_VERSION,
		memoAgentVersion: parsed.ASSIST_MEMO_AGENT_VERSION,
		memoMaxSteps: parsed.ASSIST_MEMO_MAX_STEPS,
		memoMaxToolCalls: parsed.ASSIST_MEMO_MAX_TOOL_CALLS,
		memoTimeoutMs: parsed.ASSIST_MEMO_TIMEOUT_MS,
		memoMaxCostUsd: parsed.ASSIST_MEMO_MAX_COST_USD,
		memoMaxOutputTokens: parsed.ASSIST_MEMO_MAX_OUTPUT_TOKENS,
		openRouterApiKey: parsed.OPENROUTER_API_KEY ?? null,
		openRouterBaseUrl: parsed.OPENROUTER_BASE_URL,
		adverseJurisdiction: parsed.ASSIST_ADVERSE_JURISDICTION,
		adverseContactPath: parsed.ASSIST_ADVERSE_CONTACT_PATH,
		adversePromptVersion: parsed.ASSIST_ADVERSE_PROMPT_VERSION,
		policyExceptionEnabled: parsed.ASSIST_POLICY_EXCEPTION_ENABLED === "true",
		policyExceptionRetentionDays: parsed.ASSIST_POLICY_EXCEPTION_RETENTION_DAYS,
		policyExceptionModel: parsed.POLICY_EXCEPTION_MODEL,
		policyExceptionPromptVersion: parsed.POLICY_EXCEPTION_PROMPT_VERSION,
		policyExceptionAgentVersion: parsed.POLICY_EXCEPTION_AGENT_VERSION,
		policyExceptionValidatorVersion: parsed.POLICY_EXCEPTION_VALIDATOR_VERSION,
		policyExceptionMaxSteps: parsed.POLICY_EXCEPTION_MAX_STEPS,
		policyExceptionMaxToolCalls: parsed.POLICY_EXCEPTION_MAX_TOOL_CALLS,
		policyExceptionTimeoutMs: parsed.POLICY_EXCEPTION_TIMEOUT_MS,
		policyExceptionMaxCostUsd: parsed.POLICY_EXCEPTION_MAX_COST_USD,
		policyExceptionMaxOutputTokens: parsed.POLICY_EXCEPTION_MAX_OUTPUT_TOKENS,
		policyExceptionRatePerMin: parsed.POLICY_EXCEPTION_RATE_PER_MIN,
		policyUrl: parsed.POLICY_URL ?? null,
		policyInternalSecret: parsed.POLICY_INTERNAL_SECRET ?? null,
		policyRuleContextSecret: parsed.POLICY_RULE_CONTEXT_SECRET ?? null,
		policyAuditHashSecret: parsed.POLICY_AUDIT_HASH_SECRET ?? null,
		policyTimeoutMs: parsed.ASSIST_POLICY_TIMEOUT_MS,
	},
	integrity: {
		enabled: parsed.DOCUMENT_INTEGRITY_ENABLED === "true",
		fraudReviewEnabled: parsed.FRAUD_REVIEW_ENABLED === "true",
		agentEnabled: parsed.DOCUMENT_INTEGRITY_AGENT_ENABLED === "true",
		triageEnabled: parsed.DOCUMENT_INTEGRITY_TRIAGE_ENABLED === "true",
		model: parsed.DOCUMENT_INTEGRITY_MODEL,
		promptVersion: parsed.DOCUMENT_INTEGRITY_PROMPT_VERSION,
		agentVersion: parsed.DOCUMENT_INTEGRITY_AGENT_VERSION,
		triagePromptVersion: parsed.DOCUMENT_INTEGRITY_TRIAGE_PROMPT_VERSION,
		maxSteps: parsed.DOCUMENT_INTEGRITY_MAX_STEPS,
		maxToolCalls: parsed.DOCUMENT_INTEGRITY_MAX_TOOL_CALLS,
		timeoutMs: parsed.DOCUMENT_INTEGRITY_TIMEOUT_MS,
		maxCostUsd: parsed.DOCUMENT_INTEGRITY_MAX_COST_USD,
		maxOutputTokens: parsed.DOCUMENT_INTEGRITY_MAX_OUTPUT_TOKENS,
		flagSeverity: parsed.DOCUMENT_INTEGRITY_FLAG_SEVERITY,
		retentionDays: parsed.DOCUMENT_INTEGRITY_RETENTION_DAYS,
		systemUserId: parsed.DOCUMENT_INTEGRITY_SYSTEM_USER_ID,
		maxRunsPerHash: parsed.DOCUMENT_INTEGRITY_MAX_RUNS_PER_HASH,
		openRouterApiKey: parsed.OPENROUTER_API_KEY ?? null,
		openRouterBaseUrl: parsed.OPENROUTER_BASE_URL,
	},
	nodeEnv: parsed.NODE_ENV,
};

export type ApplicationsEnv = typeof env;

export function loadEnv(): ApplicationsEnv {
	return env;
}
