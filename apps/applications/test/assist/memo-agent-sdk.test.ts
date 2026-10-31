// createAgentsMemoRunner construction test: no DB, no network. The
// fetch impl throws on any call, so a passing run proves no HTTP happens.
import { describe, expect, it } from "vitest";
import type { EvidenceBundle } from "@credit/core";
import type { applications } from "@credit/db/applications";
import { createAgentsMemoRunner } from "../../src/agents/memo-writer/index.js";

process.env.OTEL_SDK_DISABLED = "true";

function noNetworkFetch(): typeof fetch {
	return (async () => {
		throw new Error("network disabled");
	}) as typeof fetch;
}

const application = {
	id: "55555555-5555-4555-8555-555555555555",
	reference: "APP-2026-0001",
	type: "sme",
	product: "sme_term_loan",
} as unknown as typeof applications.$inferSelect;

const evidence: EvidenceBundle = {
	applicationId: application.id,
	asOf: "2026-06-30T00:00:00.000Z",
	assembledAt: "2026-06-30T01:00:00.000Z",
	items: [],
	unavailable: [],
};

describe("createAgentsMemoRunner", () => {
	it("constructs a runner without touching the network", async () => {
		const runner = createAgentsMemoRunner({
			apiKey: "test-key",
			baseUrl: "https://example.invalid",
			model: "test-model",
			maxToolCalls: 4,
			maxOutputTokens: 1_000,
			timeoutMs: 1_000,
			fetchImpl: noNetworkFetch(),
		});
		expect(typeof runner.run).toBe("function");
	});

	it("fails closed with MODEL_ERROR when no API key is configured", async () => {
		const runner = createAgentsMemoRunner({
			apiKey: "",
			baseUrl: "https://example.invalid",
			model: "test-model",
			maxToolCalls: 4,
			maxOutputTokens: 1_000,
			timeoutMs: 1_000,
			fetchImpl: noNetworkFetch(),
		});
		const error = await runner
			.run({
				application,
				evidence,
				signal: AbortSignal.timeout(1_000),
				maxTurns: 8,
			})
			.catch((err: unknown) => err);
		expect(error).toMatchObject({ name: "MemoAgentError", code: "MODEL_ERROR" });
	});
});
