// Observability failure boundaries: constructor/hook faults degrade,
// never throw; the SDK's canonical AGENTO11Y_* names are the contract.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
	constructThrows: false,
	hooksThrows: false,
	detachThrows: false,
	detachCalls: 0,
};

vi.mock("@grafana/agento11y", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@grafana/agento11y")>();
	return { ...actual, Agento11yClient: Agento11yClientMock };
});

vi.mock("@grafana/agento11y/openai-agents", () => ({
	withAgento11yOpenAIAgentsHooks: () => {
		if (state.hooksThrows) throw new Error("hooks unavailable");
		return {
			detach: () => {
				state.detachCalls += 1;
				if (state.detachThrows) throw new Error("detach failed");
			},
		};
	},
}));

import { configFromEnv } from "@grafana/agento11y";
import { getObservability, resetObservability } from "../../src/observability.js";

function Agento11yClientMock(this: unknown): void {
	if (state.constructThrows) throw new Error("bad observability config");
}

// The Runner type is structural; hooks only need an object identity.
const runner = {} as never;

function envBackup(): Record<string, string | undefined> {
	return { ...process.env };
}

describe("observability failure boundary", () => {
	let backup: Record<string, string | undefined>;

	beforeEach(() => {
		backup = envBackup();
		state.constructThrows = false;
		state.hooksThrows = false;
		state.detachThrows = false;
		state.detachCalls = 0;
		resetObservability();
		delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
		delete process.env.OTEL_SDK_DISABLED;
		// The shared pipeline gates on AGENTO11Y ingest config (repo .env
		// sets these for real deployments); the client itself is mocked.
		process.env.AGENTO11Y_ENDPOINT = "http://127.0.0.1:4318";
		process.env.AGENTO11Y_AUTH_TOKEN = "test-token";
		return () => {
			for (const key of Object.keys(process.env)) {
				if (!(key in backup)) delete process.env[key];
			}
			Object.assign(process.env, backup);
			resetObservability();
		};
	});

	it("is degraded (not throwing) when the client constructor fails", () => {
		state.constructThrows = true;
		const obs = getObservability();
		expect(obs.status).toBe("degraded");
		expect(() =>
			obs.hooksFor(runner, { runId: "r", asOf: "a", promptVersion: "v", model: "m" }),
		).not.toThrow();
	});

	it("is ok only when the pipeline is configured, and hooks detach", () => {
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318";
		const obs = getObservability();
		expect(obs.status).toBe("ok");
		const hooks = obs.hooksFor(runner, { runId: "r", asOf: "a", promptVersion: "v", model: "m" });
		expect(() => hooks.detach()).not.toThrow();
		expect(state.detachCalls).toBe(1);
		expect(obs.status).toBe("ok");
	});

	it("flips to degraded when hook setup fails, still returning no-op hooks", () => {
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318";
		state.hooksThrows = true;
		const obs = getObservability();
		expect(obs.status).toBe("ok");
		const hooks = obs.hooksFor(runner, { runId: "r", asOf: "a", promptVersion: "v", model: "m" });
		expect(() => hooks.detach()).not.toThrow();
		expect(obs.status).toBe("degraded");
	});

	it("flips to degraded when detach itself throws", () => {
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318";
		state.detachThrows = true;
		const obs = getObservability();
		obs.hooksFor(runner, { runId: "r", asOf: "a", promptVersion: "v", model: "m" }).detach();
		expect(obs.status).toBe("degraded");
	});

	it("stays degraded without an OTLP endpoint (hermetic default)", () => {
		expect(getObservability().status).toBe("degraded");
	});
});

describe("agento11y env naming", () => {
	it("honors the canonical AGENTO11Y_* names (not BASE_URL/TOKEN)", () => {
		const cfg = configFromEnv({
			AGENTO11Y_ENDPOINT: "https://obs.example",
			AGENTO11Y_PROTOCOL: "http",
			AGENTO11Y_AUTH_MODE: "bearer",
			AGENTO11Y_AUTH_TOKEN: "secret",
		});
		expect(cfg.generationExport.endpoint).toBe("https://obs.example");
		expect(cfg.generationExport.protocol).toBe("http");
		expect(cfg.generationExport.auth?.mode).toBe("bearer");
		// Legacy invented names resolve to nothing.
		const legacy = configFromEnv({
			AGENTO11Y_BASE_URL: "https://obs.example",
			AGENTO11Y_TOKEN: "secret",
		});
		expect(legacy.generationExport.endpoint).not.toBe("https://obs.example");
	});
});
