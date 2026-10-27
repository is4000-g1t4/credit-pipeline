// Shared Grafana Agent Observability wiring for credit agents.
//
// Metadata-only, best-effort. Missing credentials or network degrades
// observability, never the run or decision. No prompts, responses, raw page
// text, PII, or tool arguments leave the process. The SDK emits generation
// exports plus OTel spans/metrics; OTel providers are created here so those
// metrics are not silently dropped.
import {
	Agento11yClient,
	createSecretRedactionSanitizer,
	type EmbeddingRecorder,
	type GenerationRecorder,
	type GenerationStart,
	type TokenUsage,
	type ToolExecutionRecorder,
} from "@grafana/agento11y";
import { withAgento11yOpenAIAgentsHooks } from "@grafana/agento11y/openai-agents";
import type { Runner } from "@openai/agents";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";

const EXPORT_TIMEOUT_MS = 2_000;

export type ModelProvider = "openrouter" | "openai" | "anthropic" | "google" | (string & {});

export interface AgentIdentity {
	agentName: string;
	agentVersion: string;
	/** Low-cardinality feature label, e.g. `memo`, `document_integrity`. */
	feature: string;
}

export interface ConversationInfo {
	conversationId?: string;
	conversationTitle?: string;
	userId?: string;
}

export interface GenerationOutcome {
	usage?: TokenUsage;
	responseId?: string;
	responseModel?: string;
	stopReason?: string;
	metadata?: Record<string, unknown>;
}

export interface EmbeddingOutcome {
	inputCount: number;
	inputTokens?: number;
	responseModel?: string;
	dimensions?: number;
}

export interface Observability {
	readonly status: "ok" | "degraded";
	hooksFor(
		runner: Runner,
		opts: AgentIdentity &
			ConversationInfo & {
				model: string;
				promptVersion?: string;
				asOf?: string;
				tags?: Record<string, string>;
				metadata?: Record<string, unknown>;
			},
	): { detach: () => void };
	trackGeneration<T>(
		opts: AgentIdentity &
			ConversationInfo & {
				operation?: string;
				model: string;
				provider?: ModelProvider;
				temperature?: number;
				maxTokens?: number;
				tags?: Record<string, string>;
				metadata?: Record<string, unknown>;
				onSuccess?: (value: T) => GenerationOutcome;
			},
		fn: () => Promise<T>,
	): Promise<T>;
	trackEmbedding<T>(
		opts: AgentIdentity &
			ConversationInfo & {
				model: string;
				provider?: ModelProvider;
				dimensions?: number;
				tags?: Record<string, string>;
				metadata?: Record<string, unknown>;
				onSuccess?: (value: T) => EmbeddingOutcome;
			},
		fn: () => Promise<T>,
	): Promise<T>;
	trackToolExecution<T>(
		opts: AgentIdentity &
			ConversationInfo & {
				toolName: string;
				model?: string;
				provider?: ModelProvider;
			},
		fn: () => Promise<T>,
	): Promise<T>;
	flush(): Promise<void>;
	shutdown(): Promise<void>;
}

const NOOP: Observability = {
	status: "degraded",
	hooksFor: () => ({ detach: () => {} }),
	trackGeneration: (_opts, fn) => fn(),
	trackEmbedding: (_opts, fn) => fn(),
	trackToolExecution: (_opts, fn) => fn(),
	flush: async () => {},
	shutdown: async () => {},
};

let cached: Observability | null = null;

function hasIngestConfig(): boolean {
	return Boolean(process.env.AGENTO11Y_ENDPOINT && process.env.AGENTO11Y_AUTH_TOKEN);
}

function hasOtelConfig(): boolean {
	return Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
}

/**
 * Once per process. `serviceName` is used for OTel `service.name` only when
 * `OTEL_SERVICE_NAME`/`OTEL_RESOURCE_ATTRIBUTES` are not already set.
 */
export function getObservability(serviceName = "credit-app"): Observability {
	if (cached) return cached;
	if (process.env.OTEL_SDK_DISABLED === "true" || (!hasIngestConfig() && !hasOtelConfig())) {
		cached = NOOP;
		return cached;
	}
	try {
		process.env.OTEL_SERVICE_NAME ??= serviceName;
		let sdk: NodeSDK | undefined;
		let degraded = false;
		if (hasOtelConfig()) {
			sdk = new NodeSDK({
				traceExporter: new OTLPTraceExporter({ timeoutMillis: EXPORT_TIMEOUT_MS }),
				metricReader: new PeriodicExportingMetricReader({
					exporter: new OTLPMetricExporter({ timeoutMillis: EXPORT_TIMEOUT_MS }),
				}),
			});
			sdk.start();
			process.once("beforeExit", () => {
				void Promise.race([sdk?.shutdown(), sleep(EXPORT_TIMEOUT_MS)]);
			});
		} else {
			degraded = true;
		}
		// Providers must exist before the client creates its tracer/meter.
		const client = hasIngestConfig()
			? new Agento11yClient({
					contentCapture: "metadata_only",
					generationExport: { timeoutMs: EXPORT_TIMEOUT_MS },
					generationSanitizer: createSecretRedactionSanitizer({
						redactEmailAddresses: true,
					}),
				})
			: null;

		const end = (recorder: { getError(): Error | undefined }) => {
			if (recorder.getError()) degraded = true;
		};

		cached = {
			get status() {
				return degraded ? "degraded" : "ok";
			},
			hooksFor: (runner, opts) => {
				if (!client) return { detach: () => {} };
				try {
					const hooks = withAgento11yOpenAIAgentsHooks(runner, client, {
						agentName: opts.agentName,
						agentVersion: opts.agentVersion,
						conversationId: opts.conversationId,
						providerResolver: "auto",
						captureInputs: false,
						captureOutputs: false,
						extraTags: { feature: opts.feature, ...opts.tags },
						extraMetadata: {
							model: opts.model,
							...(opts.promptVersion ? { promptVersion: opts.promptVersion } : {}),
							...(opts.asOf ? { asOf: opts.asOf } : {}),
							...opts.metadata,
						},
					});
					return {
						detach: () => {
							try {
								hooks.detach();
							} catch {
								degraded = true;
							}
						},
					};
				} catch {
					degraded = true;
					return { detach: () => {} };
				}
			},
			trackGeneration: async (opts, fn) => {
				let recorder: GenerationRecorder | undefined;
				try {
					const start: GenerationStart = {
						agentName: opts.agentName,
						agentVersion: opts.agentVersion,
						conversationId: opts.conversationId,
						conversationTitle: opts.conversationTitle,
						userId: opts.userId,
						operationName: opts.operation,
						model: { provider: opts.provider ?? "openrouter", name: opts.model },
						temperature: opts.temperature,
						maxTokens: opts.maxTokens,
						tags: { feature: opts.feature, ...opts.tags },
						metadata: opts.metadata,
						contentCapture: "metadata_only",
					};
					recorder = client?.startGeneration(start);
				} catch {
					degraded = true;
					recorder = undefined;
				}
				if (!recorder) return fn();
				try {
					const value = await fn();
					try {
						const outcome = opts.onSuccess?.(value) ?? {};
						recorder.setResult({
							usage: outcome.usage,
							responseId: outcome.responseId,
							responseModel: outcome.responseModel,
							stopReason: outcome.stopReason,
							metadata: outcome.metadata,
						});
					} catch {
						degraded = true;
					}
					try {
						recorder.end();
						end(recorder);
					} catch {
						degraded = true;
					}
					return value;
				} catch (err) {
					try {
						recorder.setCallError(err);
						recorder.end();
						end(recorder);
					} catch {
						degraded = true;
					}
					throw err;
				}
			},
			trackEmbedding: async (opts, fn) => {
				let recorder: EmbeddingRecorder | undefined;
				try {
					recorder = client?.startEmbedding({
						agentName: opts.agentName,
						agentVersion: opts.agentVersion,
						model: { provider: opts.provider ?? "openrouter", name: opts.model },
						dimensions: opts.dimensions,
						tags: { feature: opts.feature, ...opts.tags },
						metadata: opts.metadata,
					});
				} catch {
					degraded = true;
					recorder = undefined;
				}
				if (!recorder) return fn();
				try {
					const value = await fn();
					try {
						const outcome = opts.onSuccess?.(value) ?? { inputCount: 0 };
						recorder.setResult({
							inputCount: outcome.inputCount,
							inputTokens: outcome.inputTokens,
							responseModel: outcome.responseModel,
							dimensions: outcome.dimensions,
						});
					} catch {
						degraded = true;
					}
					try {
						recorder.end();
						end(recorder);
					} catch {
						degraded = true;
					}
					return value;
				} catch (err) {
					try {
						recorder.setCallError(err);
						recorder.end();
						end(recorder);
					} catch {
						degraded = true;
					}
					throw err;
				}
			},
			trackToolExecution: async (opts, fn) => {
				let recorder: ToolExecutionRecorder | undefined;
				try {
					recorder = client?.startToolExecution({
						toolName: opts.toolName,
						conversationId: opts.conversationId,
						conversationTitle: opts.conversationTitle,
						agentName: opts.agentName,
						agentVersion: opts.agentVersion,
						requestModel: opts.model,
						requestProvider: opts.provider ?? "openrouter",
						contentCapture: "metadata_only",
					});
				} catch {
					degraded = true;
					recorder = undefined;
				}
				if (!recorder) return fn();
				try {
					const value = await fn();
					try {
						recorder.setResult({ completedAt: new Date() });
					} catch {
						degraded = true;
					}
					try {
						recorder.end();
						end(recorder);
					} catch {
						degraded = true;
					}
					return value;
				} catch (err) {
					try {
						recorder.setCallError(err);
						recorder.end();
						end(recorder);
					} catch {
						degraded = true;
					}
					throw err;
				}
			},
			flush: async () => {
				if (!client) return;
				try {
					await Promise.race([client.flush(), sleep(EXPORT_TIMEOUT_MS)]);
				} catch {
					degraded = true;
				}
			},
			shutdown: async () => {
				try {
					if (client) await Promise.race([client.shutdown(), sleep(EXPORT_TIMEOUT_MS)]);
					if (sdk) await Promise.race([sdk.shutdown(), sleep(EXPORT_TIMEOUT_MS)]);
				} catch {
					degraded = true;
				}
			},
		};
	} catch {
		cached = NOOP;
	}
	return cached;
}

/** Test seam: reset the per-process singleton between cases. */
export function resetObservability(): void {
	cached = null;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
