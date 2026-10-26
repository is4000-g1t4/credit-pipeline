// Grafana Agent Observability, metadata-only, best-effort (§7). Missing
// token/network degrades observability, never the run or decision. No
// application ID, name, city, or tool args in metadata/tags, ever.
//
// Env contract (SDK-canonical names, read automatically by the client):
// AGENTO11Y_ENDPOINT, AGENTO11Y_PROTOCOL, AGENTO11Y_AUTH_MODE,
// AGENTO11Y_AUTH_TENANT_ID, AGENTO11Y_AUTH_TOKEN, plus the standard
// OTEL_EXPORTER_OTLP_* pair for traces/metrics. No other names exist.
import { Agento11yClient, createSecretRedactionSanitizer } from "@grafana/agento11y";
import { withAgento11yOpenAIAgentsHooks } from "@grafana/agento11y/openai-agents";
import type { Runner } from "@openai/agents";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { AGENT_VERSION } from "./prompt.js";

/** Bounded flush/shutdown so Grafana can never delay a run/decision. */
const EXPORT_TIMEOUT_MS = 2000;

export interface RunHooks {
	detach: () => void;
}

/** Direct-model-call operations tracked as generations under the run conversation. */
export type ModelOperation = "agent" | "generateText" | "language_repair" | "support_judge";

export interface ModelCallOpts {
	/** Run id doubles as the Grafana conversation id (not PII). */
	runId: string;
	/** Exact model name (e.g. deepseek/deepseek-v3.2-exp). */
	model: string;
	operation: ModelOperation;
	agentName?: string;
	agentVersion?: string;
}

export interface Observability {
	readonly status: "ok" | "degraded";
	hooksFor(
		runner: Runner,
		opts: { runId: string; asOf: string; promptVersion: string; model: string },
	): RunHooks;
	/**
	 * One metadata-only generation under the run conversation for a direct
	 * model call (repair/judge) that bypasses the Runner hooks. Always
	 * executes `fn` (even degraded); observability faults never fail the run.
	 * Usage is reported, never prompts, outputs, names, or tool args — budget
	 * accounting stays with the existing callers, so this never double-counts.
	 */
	trackModelCall<T>(opts: ModelCallOpts, fn: () => Promise<T>): Promise<T>;
	/**
	 * One metadata-only tool execution under the run conversation. The Runner
	 * hooks do not surface tool spans for this agent's tool calls, so the
	 * tools are wrapped directly. Records tool name, timing, and errors only:
	 * never arguments or results. Always executes `fn`, never fails the run.
	 */
	trackToolExecution<T>(
		opts: {
			runId: string;
			toolName: string;
			model?: string;
			agentName?: string;
			agentVersion?: string;
		},
		fn: () => Promise<T>,
	): Promise<T>;
	/** Flush/shutdown for short-lived eval processes. */
	shutdown?(): Promise<void>;
}

const NOOP: Observability = {
	status: "degraded",
	hooksFor: () => ({ detach: () => {} }),
	trackModelCall: (_opts, fn) => fn(),
	trackToolExecution: (_opts, fn) => fn(),
	shutdown: async () => {},
};

let cached: Observability | null = null;

/**
 * Once per process, guarded: bad config must not crash startup.
 * `ok` only when the client constructed AND the OTel pipeline started;
 * any later hook failure flips back to `degraded`.
 */
export function getObservability(): Observability {
	if (cached) return cached;
	try {
		if (process.env.OTEL_SDK_DISABLED === "true") {
			cached = NOOP;
			return cached;
		}
		process.env.OTEL_SERVICE_NAME ??= "credit-research";
		const client = new Agento11yClient({
			contentCapture: "metadata_only",
			generationExport: { timeoutMs: EXPORT_TIMEOUT_MS },
			generationSanitizer: createSecretRedactionSanitizer({ redactEmailAddresses: true }),
		});
		// OTel is required for traces/metrics; endpoint/headers come from
		// the existing OTEL_EXPORTER_OTLP_* env. Skip when unconfigured so
		// tests/local runs stay hermetic instead of dialling localhost.
		let sdkOk = false;
		let sdk: NodeSDK | undefined;
		if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
			sdk = new NodeSDK({
				traceExporter: new OTLPTraceExporter({ timeoutMillis: EXPORT_TIMEOUT_MS }),
				metricReader: new PeriodicExportingMetricReader({
					exporter: new OTLPMetricExporter({ timeoutMillis: EXPORT_TIMEOUT_MS }),
				}),
			});
			sdk.start();
			sdkOk = true;
			process.once("beforeExit", () => {
				void Promise.race([sdk?.shutdown(), new Promise((r) => setTimeout(r, EXPORT_TIMEOUT_MS))]);
			});
		}
		let degraded = !sdkOk;
		// One helper for model + tool tracking: open the recorder, always
		// run `fn`, never let observability fail the run.
		const withRecorder = async <T, R extends { setCallError(e: unknown): void; end(): void }>(
			open: () => R | undefined,
			fn: () => Promise<T>,
			onSuccess: (rec: R, result: T) => void,
		): Promise<T> => {
			let recorder: R | undefined;
			try {
				recorder = open();
			} catch {
				degraded = true;
				recorder = undefined;
			}
			if (!recorder) return fn();
			try {
				const result = await fn();
				try {
					onSuccess(recorder, result);
				} catch {
					degraded = true;
				}
				try {
					recorder.end();
				} catch {
					degraded = true;
				}
				return result;
			} catch (err) {
				try {
					recorder.setCallError(err);
				} catch {
					// Recorder faults never mask the model/tool error.
				}
				try {
					recorder.end();
				} catch {
					degraded = true;
				}
				throw err;
			}
		};
		const trackModelCall = async <T>(opts: ModelCallOpts, fn: () => Promise<T>): Promise<T> => {
			const startedAt = Date.now();
			return withRecorder(
				() =>
					client.startGeneration({
						conversationId: opts.runId,
						agentName: opts.agentName ?? "case-brief",
						agentVersion: opts.agentVersion ?? AGENT_VERSION,
						operationName: opts.operation,
						model: { provider: "openrouter", name: opts.model },
						temperature: 0,
						tags: { feature: "case_brief", operation: opts.operation },
						metadata: { operation: opts.operation, model: opts.model },
						contentCapture: "metadata_only",
					}),
				fn,
				(recorder, result) => {
					const usage = readCallUsage(result);
					recorder.setResult({
						usage,
						metadata: {
							operation: opts.operation,
							model: opts.model,
							inputTokens: usage?.inputTokens ?? 0,
							outputTokens: usage?.outputTokens ?? 0,
							durationMs: Date.now() - startedAt,
						},
					});
				},
			);
		};
		cached = {
			get status(): "ok" | "degraded" {
				return degraded ? "degraded" : "ok";
			},
			shutdown: async () => {
				try {
					await Promise.race([
						client.shutdown(),
						new Promise((resolve) => setTimeout(resolve, EXPORT_TIMEOUT_MS)),
					]);
					if (sdk) {
						await Promise.race([
							sdk.shutdown(),
							new Promise((resolve) => setTimeout(resolve, EXPORT_TIMEOUT_MS)),
						]);
					}
				} catch {
					degraded = true;
				}
			},
			trackModelCall,
			trackToolExecution: async (opts, fn) =>
				withRecorder(
					() =>
						client.startToolExecution({
							toolName: opts.toolName,
							conversationId: opts.runId,
							agentName: opts.agentName ?? "case-brief",
							agentVersion: opts.agentVersion ?? AGENT_VERSION,
							requestModel: opts.model,
							requestProvider: "openrouter",
							contentCapture: "metadata_only",
						}),
					fn,
					// Metadata-only: timing comes from the span; arguments
					// and results are never recorded.
					(recorder) => recorder.setResult({ completedAt: new Date() }),
				),
			hooksFor: (runner, opts) => {
				try {
					const hooks = withAgento11yOpenAIAgentsHooks(runner, client, {
						agentName: "case-brief",
						agentVersion: AGENT_VERSION,
						conversationId: opts.runId,
						providerResolver: "auto",
						captureInputs: false,
						captureOutputs: false,
						extraTags: { feature: "case_brief" },
						extraMetadata: {
							asOf: opts.asOf,
							promptVersion: opts.promptVersion,
							model: opts.model,
						},
					});
					return {
						detach: () => {
							try {
								hooks.detach();
							} catch {
								// Grafana must never fail the run.
								degraded = true;
							}
						},
					};
				} catch {
					// Grafana must never fail the run.
					degraded = true;
					return { detach: () => {} };
				}
			},
		};
	} catch {
		cached = NOOP;
	}
	return cached;
}

/** Duck-typed usage: OpenAI `prompt_tokens/completion_tokens` first, then
 * the internal `inputTokens/outputTokens` carried by test doubles. */
function readCallUsage(result: unknown): { inputTokens: number; outputTokens: number } | undefined {
	if (typeof result !== "object" || result === null) return undefined;
	const r = result as {
		state?: { usage?: unknown };
		usage?: unknown;
	};
	const usage = r.state?.usage ?? r.usage;
	if (typeof usage !== "object" || usage === null) return undefined;
	const u = usage as {
		prompt_tokens?: unknown;
		completion_tokens?: unknown;
		inputTokens?: unknown;
		outputTokens?: unknown;
	};
	const input = typeof u.prompt_tokens === "number" ? u.prompt_tokens : u.inputTokens;
	const output = typeof u.completion_tokens === "number" ? u.completion_tokens : u.outputTokens;
	if (typeof input !== "number" && typeof output !== "number") return undefined;
	return {
		inputTokens: typeof input === "number" ? input : 0,
		outputTokens: typeof output === "number" ? output : 0,
	};
}

/** Test seam: reset the per-process cache between cases. */
export function resetObservability(): void {
	cached = null;
}
