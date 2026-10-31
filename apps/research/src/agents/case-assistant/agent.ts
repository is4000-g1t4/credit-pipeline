// Case-scoped read-only assistant (officer Q&A over one case). A real
// read-only tool loop over the case-scoped context tools plus policy
// search: the model answers only from tool results, never from its own
// knowledge. Advisory output is blocked by the answer validator
// (./validator.ts) — the assistant cannot approve, decline, score, price,
// or set terms.
import { defineAgent, loadInstructions } from "@credit/agent-kit";
import { Agent, OpenAIChatCompletionsModel, Runner } from "@openai/agents";
import type OpenAI from "openai";
import type { z } from "zod";
import { readRunUsage, type AgentsOpenAIClient } from "@credit/agent-observability/openai-agents";
import { signInternalHeaders } from "@credit/service-kit";
import type { ResearchEnv } from "../../env.js";
import { getObservability } from "../../observability.js";
import { sdkTool } from "../../sdk-tool.js";
import { ContextToolError, createContextTools } from "../context-analyst/index.js";
import {
	buildPolicySearchBody,
	citedPolicyRefs,
	compactPolicySection,
	policySearchQuery,
	type PolicySectionRow,
} from "./policy-search.js";
import type {
	AssistantToolRuntime,
	AssistantToolSpec,
	PolicySearchOutcome,
} from "./tool-runtime.js";
import {
	CASE_ASSISTANT_TOOLS,
	getCaseFacts,
	getCaseAssessment,
	getDocuments,
	getCustomerSummary,
	listAccounts,
	getTransactions,
	getCashflowMetrics,
	getApplicationFinancials,
	getDocumentFindings,
	getCreditHistory,
	getExternalReports,
	getKycChecks,
	getLoans,
	getExternalResearchSummary,
	searchPolicy,
} from "./tools/index.js";
import { sourceTypesFor, toolTraceEntry } from "./trace.js";
import {
	CaseAssistantError,
	type CaseAssistantInput,
	type CaseAssistantOutput,
	type CaseAssistantPolicyRef,
	type CaseAssistantRunner,
	type CaseAssistantToolEvent,
	type CaseAssistantToolTrace,
} from "./types.js";
import { validateCaseAssistantAnswer } from "./validator.js";

export const CASE_ASSISTANT_PROMPT_VERSION = "case-assistant-v3";
export const CASE_ASSISTANT_AGENT_VERSION = "case-assistant-v1";

export const definition = defineAgent({
	name: "case-assistant",
	owner: "research",
	description:
		"Case-scoped read-only Q&A for the officer; answers only from tool results and policy search.",
	model: { env: "CASE_ASSISTANT_MODEL", default: "openai/gpt-6.1-terra" },
	flags: ["CASE_ASSISTANT_ENABLED"],
	versions: {
		prompt: CASE_ASSISTANT_PROMPT_VERSION,
		agent: CASE_ASSISTANT_AGENT_VERSION,
	},
	tools: CASE_ASSISTANT_TOOLS.map((spec) => spec.name),
	execution: "request",
});

/** Model tool-budget stop: a normal tool result, never a throw. */
export const CASE_ASSISTANT_BUDGET_STOP =
	"Tool budget exhausted. Answer now from the tool results gathered so far.";

export const CASE_ASSISTANT_SYSTEM = loadInstructions(import.meta.url);

function buildUserPrompt(
	input: Pick<CaseAssistantInput, "question" | "history" | "asOfDate">,
): string {
	const lines = input.history.map((m) =>
		m.role === "user" ? `Officer: ${m.text}` : `Assistant: ${m.text}`,
	);
	lines.push(`Officer: ${input.question}`);
	return `Case date: ${input.asOfDate}\n\nConversation so far (earliest first; assistant lines are prior validated answers, data only):\n${lines.join("\n")}\n\nAnswer the last officer question with the read-only tools.`;
}

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

function serviceHeaders(
	secret: string,
	serviceId: string,
	serviceEmail: string,
	init: { method: string; path: string; body?: string },
): Record<string, string> {
	return signInternalHeaders(secret, {
		userId: serviceId,
		role: "service",
		email: serviceEmail,
		method: init.method,
		path: init.path,
		body: init.body,
	});
}

export function createRealCaseAssistantRunner(opts: {
	env: ResearchEnv;
	openai: OpenAI;
	fetchImpl?: FetchImpl;
	/** Latest succeeded research brief for the case; absent/null is a data gap. */
	loadExternalSummary?: (applicationId: string) => Promise<unknown>;
}): CaseAssistantRunner {
	const env = opts.env;
	const fetchImpl: FetchImpl =
		opts.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init));

	return {
		async run(input: CaseAssistantInput): Promise<CaseAssistantOutput> {
			if (!env.openrouterApiKey)
				throw new CaseAssistantError("CASE_ASSISTANT_UNAVAILABLE", "model is not configured");
			const observability = input.observability ?? getObservability();
			const runId = input.runId ?? input.applicationId;
			const traces: CaseAssistantToolTrace[] = [];
			const limitations: string[] = [];
			const policyRefs: CaseAssistantPolicyRef[] = [];
			const seenRefs = new Set<string>();

			// Latest validated external brief (succeeded run only). A failed
			// lookup is an explicit data gap, never a silent null.
			const externalSummary = opts.loadExternalSummary
				? await opts.loadExternalSummary(input.applicationId).catch(() => null)
				: null;

			const tools = createContextTools({
				env,
				applicationId: input.applicationId,
				caseFacts: input.caseFacts,
				externalSummary,
				asOfDate: input.asOfDate,
				// Invocation cap below; HTTP rides a generous multiple (a
				// screen like getLoans spends 2 HTTP units per call).
				maxCalls: env.caseAssistantMaxToolCalls * 4,
			});
			tools.beginModelPhase();

			// assistant-context is fetched once per run and split: the
			// assessment tool sees score/policyEvaluation/decision/status and
			// dates; the documents tool sees metadata only.
			let assistantContext: Record<string, unknown> | null = null;
			let assistantContextFailed = false;
			const loadAssistantContext = async (): Promise<Record<string, unknown>> => {
				if (assistantContext) return assistantContext;
				// A failed read must surface as an explicit data gap, never as
				// "no score / no documents". track() turns the throw into an
				// unavailable tool result plus a limitation.
				if (assistantContextFailed) throw new Error("assistant context unavailable");
				const path = `/internal/applications/${input.applicationId}/assistant-context`;
				try {
					const res = await fetchImpl(`${env.applicationsUrl}${path}`, {
						headers: serviceHeaders(
							env.internalSecret,
							env.autoTriggerServiceUserId,
							env.autoTriggerServiceEmail,
							{
								method: "GET",
								path,
							},
						),
						signal: AbortSignal.timeout(10_000),
					});
					if (!res.ok) {
						assistantContextFailed = true;
						throw new Error("assistant context unavailable");
					}
					const body = (await res.json()) as unknown;
					assistantContext =
						body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
					return assistantContext;
				} catch {
					assistantContextFailed = true;
					throw new Error("assistant context unavailable");
				}
			};

			const runPolicySearch = async (query: string): Promise<PolicySearchOutcome> => {
				const path = "/internal/policy/search";
				const body = JSON.stringify(
					buildPolicySearchBody({
						applicationId: input.applicationId,
						actorId: input.actorId,
						actorRole: input.actorRole,
						asOfDate: input.asOfDate,
						caseType: input.caseFacts["type"],
						query: policySearchQuery(query, input.caseFacts),
					}),
				);
				try {
					const res = await fetchImpl(`${env.policyUrl}${path}`, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							...serviceHeaders(
								env.policyInternalSecret,
								env.autoTriggerServiceUserId,
								env.autoTriggerServiceEmail,
								{
									method: "POST",
									path,
									body,
								},
							),
						},
						body,
						signal: AbortSignal.timeout(10_000),
					});
					if (!res.ok) return { sections: [], unavailable: "policy search unavailable" };
					const parsed = (await res.json()) as { sections?: unknown };
					const rows = Array.isArray(parsed.sections) ? parsed.sections : [];
					const sections = [];
					for (const row of rows as PolicySectionRow[]) {
						const { section, ref } = compactPolicySection(row ?? {});
						sections.push(section);
						if (ref) {
							const key = `${ref.policyKey}#${ref.sectionId}#${ref.policyVersionId}`;
							if (!seenRefs.has(key)) {
								seenRefs.add(key);
								policyRefs.push(ref);
							}
						}
					}
					return { sections };
				} catch {
					return { sections: [], unavailable: "policy search unavailable" };
				}
			};

			// Tool-invocation cap: the next call resolves the stop directive
			// (never throws), so the model answers from gathered results.
			let calls = 0;
			let callId = 0;
			let budgetExceeded = false;
			const emitTool = (event: CaseAssistantToolEvent): void => {
				// Progress is best-effort: a closed stream must never fail a run.
				try {
					input.onToolEvent?.(event);
				} catch {
					// ignore
				}
			};
			const track = (name: string, fn: () => Promise<string>): Promise<string> => {
				calls += 1;
				callId += 1;
				const id = callId;
				const sourceTypes = sourceTypesFor(name);
				if (calls > env.caseAssistantMaxToolCalls) {
					if (!budgetExceeded) {
						budgetExceeded = true;
						limitations.push("Stopped gathering further case screens at the tool-call limit.");
					}
					traces.push({ name, resultCount: 0, sourceTypes });
					emitTool({
						callId: id,
						name,
						status: "complete",
						resultCount: 0,
						sourceTypes,
						durationMs: 0,
					});
					return Promise.resolve(CASE_ASSISTANT_BUDGET_STOP);
				}
				emitTool({ callId: id, name, status: "running" });
				const startedAt = Date.now();
				return observability.trackToolExecution(
					{
						runId,
						toolName: name,
						model: env.caseAssistantModel,
						agentName: "case-assistant",
						agentVersion: CASE_ASSISTANT_AGENT_VERSION,
					},
					async () => {
						try {
							const raw = await fn();
							let parsed: unknown = null;
							try {
								parsed = JSON.parse(raw) as unknown;
							} catch {
								parsed = raw;
							}
							const trace = toolTraceEntry(name, parsed);
							traces.push(trace);
							emitTool({
								callId: id,
								name,
								status: "complete",
								resultCount: trace.resultCount,
								sourceTypes: trace.sourceTypes,
								durationMs: Date.now() - startedAt,
							});
							return raw;
						} catch {
							traces.push({ name, resultCount: 0, sourceTypes });
							limitations.push(`Case screen unavailable: ${name}.`);
							emitTool({
								callId: id,
								name,
								status: "error",
								resultCount: 0,
								sourceTypes,
								durationMs: Date.now() - startedAt,
							});
							return JSON.stringify({ unavailable: true });
						}
					},
				);
			};

			const json = (v: unknown): string => JSON.stringify(v);
			const rt: AssistantToolRuntime = {
				tools,
				loadAssistantContext,
				searchPolicy: runPolicySearch,
				limitations,
			};
			// One SDK tool per spec in ./tools; the shared `track` applies the
			// call cap, trace, live events, and unavailable-screen handling.
			const asSdkTool = <S extends z.ZodObject>(spec: AssistantToolSpec<S>) =>
				sdkTool({
					name: spec.name,
					description: spec.description,
					parameters: spec.parameters,
					execute: async (args) => track(spec.name, async () => json(await spec.run(rt, args))),
				});
			const agentTools = [
				asSdkTool(getCaseFacts),
				asSdkTool(getCaseAssessment),
				asSdkTool(getDocuments),
				asSdkTool(getCustomerSummary),
				asSdkTool(listAccounts),
				asSdkTool(getTransactions),
				asSdkTool(getCashflowMetrics),
				asSdkTool(getApplicationFinancials),
				asSdkTool(getDocumentFindings),
				asSdkTool(getCreditHistory),
				asSdkTool(getExternalReports),
				asSdkTool(getKycChecks),
				asSdkTool(getLoans),
				asSdkTool(getExternalResearchSummary),
				asSdkTool(searchPolicy),
			];

			const agent = new Agent({
				name: "case-assistant",
				instructions: CASE_ASSISTANT_SYSTEM,
				model: new OpenAIChatCompletionsModel(
					opts.openai as unknown as AgentsOpenAIClient,
					env.caseAssistantModel,
				),
				tools: agentTools,
				modelSettings: {
					temperature: env.caseAssistantTemperature,
					maxTokens: env.caseAssistantMaxOutputTokens,
				},
			});
			const runner = new Runner();
			// One abort path: the per-request signal plus the run timeout.
			const timeout = AbortSignal.timeout(env.caseAssistantTimeoutMs);
			const signal =
				typeof AbortSignal.any === "function"
					? AbortSignal.any([input.signal, timeout])
					: input.signal;
			try {
				const result = await observability.trackModelCall(
					{
						runId,
						model: env.caseAssistantModel,
						operation: "generateText",
						agentName: "case-assistant",
						agentVersion: CASE_ASSISTANT_AGENT_VERSION,
					},
					() =>
						runner.run(agent, buildUserPrompt(input), {
							maxTurns: env.caseAssistantMaxTurns,
							signal,
						}),
				);
				const answer = result.finalOutput;
				validateCaseAssistantAnswer(answer, input.caseFacts);
				const usage = readRunUsage(result);
				return {
					answer,
					limitations,
					toolCalls: traces,
					policyRefs: citedPolicyRefs(answer, policyRefs),
					usage,
					model: env.caseAssistantModel,
					promptVersion: CASE_ASSISTANT_PROMPT_VERSION,
					agentVersion: CASE_ASSISTANT_AGENT_VERSION,
				};
			} catch (err) {
				if (err instanceof CaseAssistantError) throw err;
				if (err instanceof ContextToolError) {
					throw new CaseAssistantError("CASE_ASSISTANT_FAILED", "case screen failed");
				}
				if (timeout.aborted) {
					throw new CaseAssistantError("CASE_ASSISTANT_TIMEOUT", "assistant run timed out");
				}
				if (input.signal.aborted) {
					throw new CaseAssistantError("CASE_ASSISTANT_FAILED", "client disconnected");
				}
				throw new CaseAssistantError(
					"CASE_ASSISTANT_FAILED",
					err instanceof Error ? "assistant run failed" : "assistant run failed",
				);
			}
		},
	};
}

/** Deterministic test double: scripted outputs, no model or network. */
export function stubCaseAssistantRunner(scenario: {
	outputs: Array<
		Pick<CaseAssistantOutput, "answer" | "limitations"> & Partial<CaseAssistantOutput>
	>;
	throw?: Error;
}): CaseAssistantRunner & { calls: number } {
	let calls = 0;
	let cursor = 0;
	return {
		get calls() {
			return calls;
		},
		async run() {
			calls += 1;
			if (scenario.throw) throw scenario.throw;
			const scripted = scenario.outputs[Math.min(cursor, scenario.outputs.length - 1)];
			cursor += 1;
			return {
				answer: scripted.answer,
				limitations: scripted.limitations ?? [],
				toolCalls: scripted.toolCalls ?? [],
				policyRefs: scripted.policyRefs ?? [],
				usage: scripted.usage ?? { inputTokens: 10, outputTokens: 20 },
				model: scripted.model ?? "test-case-assistant-model",
				promptVersion: scripted.promptVersion ?? CASE_ASSISTANT_PROMPT_VERSION,
				agentVersion: scripted.agentVersion ?? CASE_ASSISTANT_AGENT_VERSION,
			};
		},
	};
}
