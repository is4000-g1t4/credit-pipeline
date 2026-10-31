// case_brief agent execution (§6.2). Real path: Runner + Agent + explicit
// OpenAIChatCompletionsModel against OpenRouter; OpenAI tracing disabled.
// Fake path: deterministic stub (tests + local runs without keys).
import { randomUUID } from "node:crypto";
import { defineAgent } from "@credit/agent-kit";
import { Agent, OpenAIChatCompletionsModel, Runner } from "@openai/agents";
import type OpenAI from "openai";
import { readRunUsage, type AgentsOpenAIClient } from "@credit/agent-observability/openai-agents";
import type { ResearchEnv } from "../../env.js";
import { getObservability, type Observability } from "../../observability.js";
import { modelBriefSchema } from "./brief-schema.js";
import { VALIDATOR_VERSION } from "./brief-validation.js";
import { AgentTimeoutError, ModelUnavailableError } from "./errors.js";
import {
	buildUserPrompt,
	AGENT_VERSION,
	PROMPT_VERSION,
	SYSTEM_TEMPLATE,
	type PromptCaseFacts,
} from "./prompt.js";
import { buildSearchQuery, TavilyError, type QueryEntity, type TavilyClient } from "./tavily.js";
import { createFetchSourceTool } from "./tools/fetch-source.js";
import { createSearchSourcesTool } from "./tools/search-sources.js";
import type { BriefToolRuntime, FetchedEvidence, TavilySearchHitLite } from "./tool-runtime.js";
import { validateFinalUrl } from "../../urls.js";

export type { FetchedEvidence } from "./tool-runtime.js";
export { AgentTimeoutError, ModelUnavailableError } from "./errors.js";

export const definition = defineAgent({
	name: "case-brief",
	owner: "research",
	description:
		"Neutral, cited external research brief on the applicant for the officer; advisory only.",
	model: { env: "AGENT_MODEL", default: "openai/gpt-6.1-sol" },
	flags: ["AGENTS_ENABLED"],
	versions: { prompt: PROMPT_VERSION, agent: AGENT_VERSION, validator: VALIDATOR_VERSION },
	tools: ["search_sources", "fetch_source"],
	execution: "temporal",
});

export interface BriefUsage {
	inputTokens: number;
	outputTokens: number;
	toolCalls: number;
	searches: number;
	extracts: number;
}

export interface AgentResult {
	brief: unknown;
	fetched: FetchedEvidence[];
	usage: BriefUsage;
	model: string;
}

export interface AgentRunner {
	runBrief(input: {
		caseFacts: PromptCaseFacts;
		entity: QueryEntity;
		asOfDate: string;
		signal: AbortSignal;
		hooksFor?: (runner: Runner) => { detach: () => void };
		/** Direct tool wrapping joins the run conversation when present. */
		observability?: Observability;
		runId?: string;
	}): Promise<AgentResult>;
}

// ponytail: ceiling rates ~1000x above the POC's ~$0.00016/run; a generous
// backstop only. Replace with billed usage if OpenRouter exposes it.
const COST_CEILING_PER_MTOK = { input: 5, output: 10 };

export function projectCostUsd(inputTokens: number, outputTokens: number): number {
	return (
		(inputTokens / 1_000_000) * COST_CEILING_PER_MTOK.input +
		(outputTokens / 1_000_000) * COST_CEILING_PER_MTOK.output
	);
}

export function createRealRunner(opts: {
	env: ResearchEnv;
	tavily: TavilyClient;
	openai: OpenAI;
}): AgentRunner {
	const env = opts.env;
	return {
		async runBrief(input) {
			if (!env.openrouterApiKey) throw new ModelUnavailableError("model is not configured");
			const tavily = opts.tavily;
			const openai = opts.openai;
			const observability = input.observability ?? getObservability();
			const runId = input.runId ?? randomUUID();
			const model = new OpenAIChatCompletionsModel(
				openai as unknown as AgentsOpenAIClient,
				env.agentModel,
			);

			// Per-run state shared with the tool files (./tools). The Runner
			// hooks do not surface tool spans for these calls, so each is
			// tracked directly: name/timing/errors only, never arguments or
			// results. Untracked without a run id.
			const counters = { toolCalls: 0, searches: 0, extracts: 0 };
			const fetched: FetchedEvidence[] = [];
			const seen = new Map<string, TavilySearchHitLite>();
			const trackTool = <T>(
				toolName: "search_sources" | "fetch_source",
				fn: () => Promise<T>,
			): Promise<T> =>
				observability.trackToolExecution({ runId, toolName, model: env.agentModel }, fn);
			const rt: BriefToolRuntime = {
				env,
				tavily,
				entity: input.entity,
				asOfDate: input.asOfDate,
				fetched,
				seen,
				counters,
				budget: (): void => {
					counters.toolCalls += 1;
					if (counters.toolCalls > env.agentMaxToolCalls)
						throw new TavilyError("tool budget exceeded");
				},
				track: trackTool,
			};

			// Mandatory two-category preflight. The model is instructed to run
			// these searches, but it sometimes returns an empty brief without
			// calling a tool. Fetching the same two categories server-side makes
			// the evidence deterministic without changing what the model may
			// cite; the tools remain available for drill-down. Preflight
			// extracts count against AGENT_MAX_FETCHES so the cap stays honest.
			const preflight: Array<{
				url: string;
				title: string | null;
				publishedDate: string | null;
				content: string;
			}> = [];
			const maxPreflightExtracts = Math.min(2, env.maxFetches);
			for (const category of ["adverse_media", "registry"] as const) {
				if (input.signal.aborted) break;
				try {
					counters.searches += 1;
					const hits = await trackTool("search_sources", () =>
						tavily.search(
							buildSearchQuery(
								{
									name: input.entity.name,
									city: input.entity.city,
									registrationNumber: input.entity.registrationNumber,
								},
								category,
							),
							{ maxResults: env.maxSources, endDate: input.asOfDate },
						),
					);
					for (const hit of hits) seen.set(hit.url, hit);
					if (input.signal.aborted || counters.extracts >= maxPreflightExtracts) continue;
					const candidate = hits[0];
					if (!candidate) continue;
					const verdict = validateFinalUrl(candidate.url);
					if (!verdict.ok) continue;
					const extracted = await trackTool("fetch_source", () =>
						tavily.extract([verdict.finalUrl]),
					);
					const page = extracted[0];
					if (!page?.rawContent) continue;
					counters.extracts += 1;
					fetched.push({
						requestedUrl: candidate.url,
						returnedUrl: page.url,
						title: candidate.title,
						searchPublishedDate: candidate.publishedDate,
						rawContent: page.rawContent,
					});
					preflight.push({
						url: candidate.url,
						title: candidate.title,
						publishedDate: candidate.publishedDate,
						content: page.rawContent.slice(0, 4_000),
					});
				} catch {
					// Preflight is best-effort; the model's tools can retry.
					if (input.signal.aborted) break;
				}
			}

			const searchTool = createSearchSourcesTool(rt);
			const fetchTool = createFetchSourceTool(rt);

			const preflightBlock =
				preflight.length === 0
					? ""
					: `\n\n<preflight_sources id="${randomUUID()}">\n${preflight
							.map(
								(p) =>
									`URL: ${p.url}\nTITLE: ${p.title ?? ""}\nDATE: ${p.publishedDate ?? ""}\nCONTENT:\n${p.content}`,
							)
							.join(
								"\n---\n",
							)}\n</preflight_sources>\nThe preflight sources above were already fetched for the mandatory adverse_media and registry searches. Use them as evidence; you may still call the tools for more. Quote from CONTENT verbatim.`;
			const userPrompt = `${buildUserPrompt(input.caseFacts)}${preflightBlock}`;

			const agent = new Agent({
				// Model + eval: docs/eval/research/BRIEF-MODELS-RESULTS.md.
				name: "case-brief",
				instructions: SYSTEM_TEMPLATE,
				model,
				tools: [searchTool, fetchTool],
				outputType: modelBriefSchema,
				modelSettings: {
					...(env.agentTemperature !== undefined ? { temperature: env.agentTemperature } : {}),
					...(env.agentMaxOutputTokens !== undefined
						? { maxTokens: env.agentMaxOutputTokens }
						: {}),
				},
			});
			const runner = new Runner();
			try {
				// The run's deadline signal goes straight into the SDK —
				// one abort path, no parallel timer to leak or double-fire.
				let result = await observability.trackModelCall(
					{
						runId,
						model: env.agentModel,
						operation: "generateText",
						agentName: "case-brief",
						agentVersion: AGENT_VERSION,
					},
					() =>
						runner.run(agent, userPrompt, {
							maxTurns: env.agentMaxTurns,
							signal: input.signal,
						}),
				);
				let usage = readRunUsage(result);
				if (!input.signal.aborted && fetched.length === 0) {
					// No evidence at all: one bounded retry with an explicit
					// tool requirement. A preflight hit means the brief can be
					// written without spending a second model run.
					const retry = await observability.trackModelCall(
						{
							runId,
							model: env.agentModel,
							operation: "generateText",
							agentName: "case-brief",
							agentVersion: AGENT_VERSION,
						},
						() =>
							runner.run(
								agent,
								`${userPrompt}\n\nRetry requirement: your previous response made no tool calls and no evidence was fetched. You MUST call search_sources for adverse_media and for registry before writing the brief. If either search returns no usable content, record that in unknowns.`,
								{ maxTurns: env.agentMaxTurns, signal: input.signal },
							),
					);
					const retryUsage = readRunUsage(retry);
					usage = {
						inputTokens: usage.inputTokens + retryUsage.inputTokens,
						outputTokens: usage.outputTokens + retryUsage.outputTokens,
					};
					result = retry;
				}
				if (result.finalOutput === null || result.finalOutput === undefined) {
					throw new Error("model returned no structured brief");
				}
				return {
					brief: result.finalOutput,
					fetched,
					usage: {
						...usage,
						toolCalls: counters.toolCalls,
						searches: counters.searches,
						extracts: counters.extracts,
					},
					model: env.agentModel,
				};
			} catch (err) {
				if (err instanceof AgentTimeoutError || err instanceof TavilyError) throw err;
				if (input.signal.aborted) throw new AgentTimeoutError("agent wall clock exceeded");
				throw new ModelUnavailableError(err instanceof Error ? err.message : "model call failed");
			}
		},
	};
}

/** Deterministic test double: canned brief + fetched evidence, no network. */
export function stubAgentRunner(scenario: {
	brief: unknown;
	fetched: FetchedEvidence[];
	usage?: Partial<BriefUsage>;
	throw?: Error;
}): AgentRunner & { calls: number } {
	let calls = 0;
	return {
		get calls() {
			return calls;
		},
		async runBrief() {
			calls += 1;
			if (scenario.throw) throw scenario.throw;
			return {
				brief: scenario.brief,
				fetched: scenario.fetched,
				usage: {
					inputTokens: 100,
					outputTokens: 100,
					toolCalls: 2,
					searches: 1,
					extracts: 1,
					...scenario.usage,
				},
				model: "deepseek/deepseek-v4.1-flash-1017",
			};
		},
	};
}
