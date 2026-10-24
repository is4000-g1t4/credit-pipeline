// Readiness (Wave 6): a compliant disabled deployment is healthy with no
// Grafana and no model/tool keys. Observability is informational only —
// DB + config decide readiness. Runs stay fail-closed (see agent/tavily
// "not configured" → config_error).
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { stubAgentRunner } from "../../src/agent.js";
import { checkConfig, createApp, createLogger } from "../../src/app.js";
import { stubContextRunner } from "../../src/context-agent.js";
import { loadEnv } from "../../src/env.js";
import { stubLanguageRepair } from "../../src/repair.js";
import { stubSupportJudge } from "../../src/support.js";
import { degradedObservability } from "../helper.js";

process.env.LOG_LEVEL ??= "silent";

function healthApp(overrides: Partial<ReturnType<typeof loadEnv>> = {}) {
	const env = { ...loadEnv(), ...overrides };
	const sql = (async () => []) as unknown as Sql;
	return createApp({
		db: {} as never,
		sql,
		env,
		logger: createLogger("research-health-test"),
		runner: stubAgentRunner({ brief: null, fetched: [] }),
		judge: stubSupportJudge(),
		repair: stubLanguageRepair(),
		observability: degradedObservability,
		contextRunner: stubContextRunner({ outputs: [] }),
	});
}

describe("checkConfig", () => {
	it("is ready without keys when the feature is disabled", () => {
		const env = { ...loadEnv(), agentsEnabled: false, openrouterApiKey: "", tavilyApiKey: "" };
		expect(checkConfig(env)).toEqual({ ok: true });
	});

	it("requires both keys when enabled", () => {
		const base = { ...loadEnv(), agentsEnabled: true };
		expect(checkConfig({ ...base, openrouterApiKey: "", tavilyApiKey: "" }).ok).toBe(false);
		expect(checkConfig({ ...base, openrouterApiKey: "k", tavilyApiKey: "" }).ok).toBe(false);
		expect(checkConfig({ ...base, openrouterApiKey: "k", tavilyApiKey: "t" })).toEqual({
			ok: true,
		});
	});

	it("refuses a context budget above the external budget", () => {
		const base = { ...loadEnv(), agentsEnabled: true, openrouterApiKey: "k", tavilyApiKey: "t" };
		expect(checkConfig({ ...base, maxCostUsd: 0.15, contextMaxCostUsd: 0.1 })).toEqual({
			ok: true,
		});
		expect(checkConfig({ ...base, maxCostUsd: 0.1, contextMaxCostUsd: 0.15 }).ok).toBe(false);
	});
});

describe("GET /health (disabled, no Grafana, no keys)", () => {
	it("reports ok on DB + config; observability is informational", async () => {
		const app = healthApp({ agentsEnabled: false, openrouterApiKey: "", tavilyApiKey: "" });
		const res = await app.request("/health");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			status: string;
			checks: Record<string, { ok: boolean; status?: string }>;
		};
		expect(body.status).toBe("ok");
		expect(body.checks.db.ok).toBe(true);
		expect(body.checks.config).toEqual({ ok: true });
		expect(body.checks.observability).toEqual({ ok: true, status: "degraded" });
	});

	it("is degraded when enabled without keys", async () => {
		const app = healthApp({ agentsEnabled: true, openrouterApiKey: "", tavilyApiKey: "" });
		const res = await app.request("/health");
		const body = (await res.json()) as { status: string };
		expect(body.status).toBe("degraded");
	});
});
