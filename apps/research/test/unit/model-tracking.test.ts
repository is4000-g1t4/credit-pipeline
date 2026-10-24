// Direct-call model tracking (Wave 7): repair/judge generations share the run
// conversation with usage/timing metadata only — never prompts, outputs,
// names, cities, quotes, or tool args. Degraded observability still executes.
import { beforeEach, describe, expect, it, vi } from "vitest";

const recorded = {
	starts: [] as Array<Record<string, unknown>>,
	results: [] as Array<Record<string, unknown>>,
	callErrors: [] as Array<unknown>,
	ends: 0,
	toolStarts: [] as Array<Record<string, unknown>>,
	toolResults: [] as Array<Record<string, unknown>>,
	toolCallErrors: [] as Array<unknown>,
	toolEnds: 0,
};
const state = { startThrows: false, toolStartThrows: false };

function testRecorder(
	onResult: (r: unknown) => void,
	onCallError: (e: unknown) => void,
	onEnd: () => void,
) {
	return {
		setResult: (r: unknown) => {
			onResult(r as Record<string, unknown>);
		},
		setCallError: (e: unknown) => {
			onCallError(e);
		},
		end: () => {
			onEnd();
		},
		getError: () => undefined,
	};
}

vi.mock("@grafana/agento11y", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@grafana/agento11y")>();
	return {
		...actual,
		Agento11yClient: class {
			startGeneration(start: unknown) {
				if (state.startThrows) throw new Error("exporter down");
				recorded.starts.push(start as Record<string, unknown>);
				return testRecorder(
					(r) => recorded.results.push(r as Record<string, unknown>),
					(e) => recorded.callErrors.push(e),
					() => {
						recorded.ends += 1;
					},
				);
			}
			startToolExecution(start: unknown) {
				if (state.toolStartThrows) throw new Error("exporter down");
				recorded.toolStarts.push(start as Record<string, unknown>);
				return testRecorder(
					(r) => recorded.toolResults.push(r as Record<string, unknown>),
					(e) => recorded.toolCallErrors.push(e),
					() => {
						recorded.toolEnds += 1;
					},
				);
			}
		},
	};
});

import {
	getObservability,
	resetObservability,
	type ModelCallOpts,
	type Observability,
} from "../../src/observability.js";
import { createLlmLanguageRepair } from "../../src/repair.js";
import { createLlmSupportJudge, judgeWithRepair } from "../../src/support.js";
import { fakeOpenAi, modelBrief } from "../fixtures.js";

const MODEL = "deepseek/deepseek-v3.2-exp";
const RUN_ID = "run-123";

function envBackup(): Record<string, string | undefined> {
	return { ...process.env };
}

/** Fake observer: records tracked ops, never sees prompts or outputs. */
function recordingObserver() {
	const calls: ModelCallOpts[] = [];
	const tools: Array<{ runId: string; toolName: string; model?: string }> = [];
	const obs: Observability = {
		status: "ok",
		hooksFor: () => ({ detach: () => {} }),
		trackModelCall: async (opts, fn) => {
			calls.push({ ...opts });
			return fn();
		},
		trackToolExecution: async (opts, fn) => {
			tools.push({ ...opts });
			return fn();
		},
	};
	return { obs, calls, tools };
}

describe("direct-call tracking through the factories", () => {
	it("tracks language repair as one generation under the run conversation", async () => {
		const { obs, calls } = recordingObserver();
		const repair = createLlmLanguageRepair(
			fakeOpenAi([
				{
					summary: "Registry shows timely filings in the public record.",
					findings: [
						{
							claim: "Acme Ltd filed accounts for the year ending March 2025 on time.",
							whyItMatters: "Timely filing is part of the public record.",
						},
					],
				},
			]),
			MODEL,
			{ observability: obs },
		);
		const out = await repair(modelBrief(), { runId: RUN_ID });
		expect(calls).toEqual([{ runId: RUN_ID, model: MODEL, operation: "language_repair" }]);
		// Budget accounting is untouched: the same usage object flows through.
		expect(out.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
		expect(out.brief.summary).toBe("Registry shows timely filings in the public record.");
	});

	it("tracks each judge attempt (initial + repair retry) as support_judge", async () => {
		const { obs, calls } = recordingObserver();
		const judge = createLlmSupportJudge(
			fakeOpenAi([
				{ verdict: "unsupported", span: null },
				{ verdict: "supported", span: "filed accounts" },
			]),
			MODEL,
			{ observability: obs },
		);
		const out = await judgeWithRepair(
			"Acme Ltd filed accounts.",
			"Acme Ltd filed accounts.",
			judge,
			{
				runId: RUN_ID,
			},
		);
		expect(out.verdict).toBe("supported");
		expect(out.repaired).toBe(true);
		expect(calls).toEqual([
			{ runId: RUN_ID, model: MODEL, operation: "support_judge" },
			{ runId: RUN_ID, model: MODEL, operation: "support_judge" },
		]);
	});

	it("runs untracked without a run id, still succeeding", async () => {
		const { obs, calls } = recordingObserver();
		const repair = createLlmLanguageRepair(
			fakeOpenAi([
				{
					summary: "Registry shows timely filings in the public record.",
					findings: [
						{
							claim: "Acme Ltd filed accounts for the year ending March 2025 on time.",
							whyItMatters: "Timely filing is part of the public record.",
						},
					],
				},
			]),
			MODEL,
			{ observability: obs },
		);
		const out = await repair(modelBrief());
		expect(calls).toEqual([]);
		expect(out.brief.summary).toBe("Registry shows timely filings in the public record.");
	});
});

describe("trackModelCall generation payload", () => {
	let backup: Record<string, string | undefined>;

	beforeEach(() => {
		backup = envBackup();
		recorded.starts = [];
		recorded.results = [];
		recorded.callErrors = [];
		recorded.ends = 0;
		recorded.toolStarts = [];
		recorded.toolResults = [];
		recorded.toolCallErrors = [];
		recorded.toolEnds = 0;
		state.startThrows = false;
		state.toolStartThrows = false;
		resetObservability();
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318";
		delete process.env.OTEL_SDK_DISABLED;
		return () => {
			for (const key of Object.keys(process.env)) {
				if (!(key in backup)) delete process.env[key];
			}
			Object.assign(process.env, backup);
			resetObservability();
		};
	});

	it("sends metadata-only generations: no prompts, outputs, names, or places", async () => {
		const obs = getObservability();
		// Content the wrapper must never see: only usage flows back out of fn.
		const claim = "Acme Ltd filed accounts for the year ending March 2025 on time.";
		const city = "Leeds";
		const result = await obs.trackModelCall(
			{ runId: RUN_ID, model: MODEL, operation: "support_judge" },
			async () => ({ verdict: "supported" as const, usage: { inputTokens: 7, outputTokens: 3 } }),
		);
		expect(result.verdict).toBe("supported");
		expect(recorded.starts).toHaveLength(1);
		const start = recorded.starts[0];
		expect(start.conversationId).toBe(RUN_ID);
		expect(start.model).toEqual({ provider: "openrouter", name: MODEL });
		expect(start.operationName).toBe("support_judge");
		expect(start.contentCapture).toBe("metadata_only");
		expect(recorded.results).toHaveLength(1);
		expect(recorded.results[0].usage).toEqual({ inputTokens: 7, outputTokens: 3 });
		expect(recorded.results[0].metadata).toMatchObject({
			operation: "support_judge",
			model: MODEL,
			inputTokens: 7,
			outputTokens: 3,
		});
		expect(typeof (recorded.results[0].metadata as Record<string, unknown>).durationMs).toBe(
			"number",
		);
		expect(recorded.ends).toBe(1);
		// Nothing but ids, model names, operations, and counts may leave the process.
		const leaked = JSON.stringify({ start, result: recorded.results[0] });
		expect(leaked).not.toContain(claim);
		expect(leaked).not.toContain(city);
		expect(leaked).not.toContain("Jane Doe");
		expect(start).not.toHaveProperty("input");
		expect(start).not.toHaveProperty("output");
		expect(start).not.toHaveProperty("systemPrompt");
	});

	it("tracks the agent operation the same way", async () => {
		const obs = getObservability();
		await obs.trackModelCall({ runId: RUN_ID, model: MODEL, operation: "agent" }, async () => ({}));
		expect(recorded.starts[0].operationName).toBe("agent");
		expect(recorded.starts[0].conversationId).toBe(RUN_ID);
	});

	it("reads OpenAI prompt_tokens/completion_tokens for usage metadata", async () => {
		const obs = getObservability();
		await obs.trackModelCall(
			{ runId: RUN_ID, model: MODEL, operation: "support_judge" },
			async () => ({
				choices: [{ message: { content: "{}" } }],
				usage: { prompt_tokens: 11, completion_tokens: 6 },
			}),
		);
		expect(recorded.results).toHaveLength(1);
		expect(recorded.results[0].usage).toEqual({ inputTokens: 11, outputTokens: 6 });
		expect(recorded.results[0].metadata).toMatchObject({
			operation: "support_judge",
			inputTokens: 11,
			outputTokens: 6,
		});
	});

	it("still executes when the client is down (degraded)", async () => {
		state.startThrows = true;
		const obs = getObservability();
		const out = await obs.trackModelCall(
			{ runId: RUN_ID, model: MODEL, operation: "language_repair" },
			async () => "repaired",
		);
		expect(out).toBe("repaired");
		expect(recorded.starts).toHaveLength(0);
	});

	it("propagates model errors and records them", async () => {
		const obs = getObservability();
		const failure = new Error("model unavailable");
		await expect(
			obs.trackModelCall({ runId: RUN_ID, model: MODEL, operation: "support_judge" }, () =>
				Promise.reject(failure),
			),
		).rejects.toBe(failure);
		expect(recorded.callErrors).toHaveLength(1);
		expect(recorded.ends).toBe(1);
	});
});

describe("trackToolExecution payload", () => {
	let backup: Record<string, string | undefined>;

	beforeEach(() => {
		backup = envBackup();
		recorded.toolStarts = [];
		recorded.toolResults = [];
		recorded.toolCallErrors = [];
		recorded.toolEnds = 0;
		state.toolStartThrows = false;
		resetObservability();
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318";
		delete process.env.OTEL_SDK_DISABLED;
		return () => {
			for (const key of Object.keys(process.env)) {
				if (!(key in backup)) delete process.env[key];
			}
			Object.assign(process.env, backup);
			resetObservability();
		};
	});

	it("records tool name and conversation only: never arguments or results", async () => {
		const obs = getObservability();
		const out = await obs.trackToolExecution(
			{ runId: RUN_ID, toolName: "search_sources", model: MODEL },
			async () => "tool output with Acme Ltd in Leeds",
		);
		expect(out).toBe("tool output with Acme Ltd in Leeds");
		expect(recorded.toolStarts).toHaveLength(1);
		const start = recorded.toolStarts[0];
		expect(start.toolName).toBe("search_sources");
		expect(start.conversationId).toBe(RUN_ID);
		expect(start.requestModel).toBe(MODEL);
		expect(start.requestProvider).toBe("openrouter");
		expect(recorded.toolResults).toHaveLength(1);
		expect(recorded.toolResults[0]).not.toHaveProperty("arguments");
		expect(recorded.toolResults[0]).not.toHaveProperty("result");
		expect(recorded.toolEnds).toBe(1);
		const leaked = JSON.stringify({ start, result: recorded.toolResults[0] });
		expect(leaked).not.toContain("Acme Ltd");
		expect(leaked).not.toContain("Leeds");
	});

	it("still executes when the client is down (degraded)", async () => {
		state.toolStartThrows = true;
		const obs = getObservability();
		const out = await obs.trackToolExecution(
			{ runId: RUN_ID, toolName: "fetch_source" },
			async () => "page text",
		);
		expect(out).toBe("page text");
		expect(recorded.toolStarts).toHaveLength(0);
	});

	it("propagates tool errors and records them", async () => {
		const obs = getObservability();
		const failure = new Error("extract returned no content");
		await expect(
			obs.trackToolExecution({ runId: RUN_ID, toolName: "fetch_source" }, () =>
				Promise.reject(failure),
			),
		).rejects.toBe(failure);
		expect(recorded.toolCallErrors).toHaveLength(1);
		expect(recorded.toolEnds).toBe(1);
	});
});
