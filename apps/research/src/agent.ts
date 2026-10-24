// case_brief agent execution (§6.2). Real path: Runner + Agent + explicit
// OpenAIChatCompletionsModel against OpenRouter; OpenAI tracing disabled.
// Fake path: deterministic stub (tests + local runs without keys).
import { randomUUID } from "node:crypto";
import { Agent, OpenAIChatCompletionsModel, Runner, tool } from "@openai/agents";
import OpenAI from "openai";
import { z } from "zod";
import { readRunUsage, type AgentsOpenAIClient } from "./openai-agents.js";
import type { ResearchEnv } from "./env.js";
import type { Observability } from "./observability.js";
import { buildUserPrompt, SYSTEM_TEMPLATE, type PromptCaseFacts } from "./prompt.js";
import {
	buildSearchQuery,
	TavilyError,
	type QueryEntity,
	type SearchCategory,
	type TavilyClient,
} from "./tavily.js";
import { validateFinalUrl } from "./urls.js";
import { modelBriefSchema } from "./validator.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface FetchedEvidence {
	requestedUrl: string;
	returnedUrl: string;
	title: string | null;
	searchPublishedDate: string | null;
	rawContent: string;
}

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

export class ModelUnavailableError extends Error {}
export class AgentTimeoutError extends Error {}

// ponytail: ceiling rates ~1000x above the POC's ~$0.00016/run; a generous
// backstop only. Replace with billed usage if OpenRouter exposes it.
const COST_CEILING_PER_MTOK = { input: 5, output: 10 };

export function projectCostUsd(inputTokens: number, outputTokens: number): number {
	return (
		(inputTokens / 1_000_000) * COST_CEILING_PER_MTOK.input +
		(outputTokens / 1_000_000) * COST_CEILING_PER_MTOK.output
	);
}

const searchParams = z
	.object({
		entity: z.string().min(1).max(200),
		category: z.enum(["adverse_media", "reputation", "registry", "market", "other"]),
	})
	.strict();

const fetchParams = z.object({ url: z.string().min(1).max(2000) }).strict();

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
			const model = new OpenAIChatCompletionsModel(
				openai as unknown as AgentsOpenAIClient,
				env.agentModel,
			);

			let toolCalls = 0;
			let searches = 0;
			let extracts = 0;
			const fetched: FetchedEvidence[] = [];
			const seen = new Map<string, TavilySearchHitLite>();

			// The Runner hooks do not surface tool spans for these calls, so
			// each is tracked directly: name/timing/errors only, never
			// arguments or results. Untracked without a run id.
			const trackTool = <T>(
				toolName: "search_sources" | "fetch_source",
				fn: () => Promise<T>,
			): Promise<T> => {
				const obs = input.observability;
				if (!obs || !input.runId) return fn();
				return obs.trackToolExecution({ runId: input.runId, toolName, model: env.agentModel }, fn);
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
					searches += 1;
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
					if (input.signal.aborted || extracts >= maxPreflightExtracts) continue;
					const candidate = hits[0];
					if (!candidate) continue;
					const verdict = validateFinalUrl(candidate.url);
					if (!verdict.ok) continue;
					const extracted = await trackTool("fetch_source", () =>
						tavily.extract([verdict.finalUrl]),
					);
					const page = extracted[0];
					if (!page?.rawContent) continue;
					extracts += 1;
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

			const budget = (): void => {
				toolCalls += 1;
				if (toolCalls > env.agentMaxToolCalls) throw new TavilyError("tool budget exceeded");
			};

			const searchTool = tool({
				name: "search_sources",
				description:
					"Search approved public sources for an entity and category. Returns up to N results with url, title, publication date, and the extracted text of the top result when available.",
				parameters: searchParams,
				execute: async ({ entity, category }: { entity: string; category: SearchCategory }) =>
					trackTool("search_sources", async () => {
						budget();
						if (!env.tavilyApiKey) throw new TavilyError("search is not configured");
						searches += 1;
						// The server builds the query from a fixed template; the
						// model supplies only the entity name and category.
						const name = entity.slice(0, 200);
						const query = buildSearchQuery(
							{
								name,
								city: input.entity.city,
								registrationNumber: input.entity.registrationNumber,
							},
							category,
						);
						const hits = await tavily.search(query, {
							maxResults: env.maxSources,
							endDate: input.asOfDate,
						});
						for (const hit of hits) seen.set(hit.url, hit);
						const results: Array<{
							url: string;
							title: string | null;
							publishedDate: string | null;
							content?: string;
						}> = hits.map((h) => ({
							url: h.url,
							title: h.title,
							publishedDate: h.publishedDate,
						}));
						// The model consistently stops after titles. Auto-extract the
						// top unused result so search results become usable evidence
						// within the same extract budget; failures stay non-fatal.
						if (extracts < Math.min(env.maxFetches, 2)) {
							const candidate = hits.find(
								(h) => !fetched.some((f) => f.requestedUrl === h.url || f.returnedUrl === h.url),
							);
							if (candidate) {
								const verdict = validateFinalUrl(candidate.url);
								if (verdict.ok) {
									try {
										const extracted = await tavily.extract([verdict.finalUrl]);
										const page = extracted[0];
										if (page?.rawContent) {
											extracts += 1;
											fetched.push({
												requestedUrl: candidate.url,
												returnedUrl: page.url,
												title: candidate.title,
												searchPublishedDate: candidate.publishedDate,
												rawContent: page.rawContent,
											});
											const row = results.find((r) => r.url === candidate.url);
											if (row) row.content = page.rawContent.slice(0, 2500);
										}
									} catch {
										// A failed extract must not fail the search; the
										// model can still call fetch_source explicitly.
									}
								}
							}
						}
						return JSON.stringify(
							results
								.filter((row) => typeof row.content === "string" && row.content.length > 0)
								.slice(0, 1),
						);
					}),
			});

			const fetchTool = tool({
				name: "fetch_source",
				description:
					"Extract the text of one search-result URL via the extraction service. Returns the page text.",
				parameters: fetchParams,
				execute: async ({ url }: { url: string }) =>
					trackTool("fetch_source", async () => {
						const cached = fetched.find((f) => f.requestedUrl === url || f.returnedUrl === url);
						if (cached) return cached.rawContent.slice(0, 2500);
						budget();
						if (!env.tavilyApiKey) throw new TavilyError("extract is not configured");
						if (extracts >= env.maxFetches) throw new TavilyError("extract budget exceeded");
						const verdict = validateFinalUrl(url);
						if (!verdict.ok) throw new TavilyError(`unsafe URL: ${verdict.error}`);
						extracts += 1;
						const hits = await tavily.extract([verdict.finalUrl]);
						const hit = hits[0];
						if (!hit || !hit.rawContent) throw new TavilyError("extract returned no content");
						const prior = seen.get(url);
						fetched.push({
							requestedUrl: url,
							returnedUrl: hit.url,
							title: prior?.title ?? null,
							searchPublishedDate: prior?.publishedDate ?? null,
							rawContent: hit.rawContent,
						});
						return hit.rawContent.slice(0, 8000);
					}),
			});

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
			const hooks = (input.hooksFor ?? (() => ({ detach: () => {} })))(runner);
			try {
				// The run's deadline signal goes straight into the SDK —
				// one abort path, no parallel timer to leak or double-fire.
				// Hooks detach in `finally`, including on abort.
				let result = await runner.run(agent, userPrompt, {
					maxTurns: env.agentMaxTurns,
					signal: input.signal,
				});
				let usage = readRunUsage(result);
				if (!input.signal.aborted && fetched.length === 0) {
					// No evidence at all: one bounded retry with an explicit
					// tool requirement. A preflight hit means the brief can be
					// written without spending a second model run.
					const retry = await runner.run(
						agent,
						`${userPrompt}\n\nRetry requirement: your previous response made no tool calls and no evidence was fetched. You MUST call search_sources for adverse_media and for registry before writing the brief. If either search returns no usable content, record that in unknowns.`,
						{ maxTurns: env.agentMaxTurns, signal: input.signal },
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
						toolCalls,
						searches,
						extracts,
					},
					model: env.agentModel,
				};
			} catch (err) {
				if (err instanceof AgentTimeoutError || err instanceof TavilyError) throw err;
				if (input.signal.aborted) throw new AgentTimeoutError("agent wall clock exceeded");
				throw new ModelUnavailableError(err instanceof Error ? err.message : "model call failed");
			} finally {
				hooks.detach();
			}
		},
	};
}

interface TavilySearchHitLite {
	title: string | null;
	publishedDate: string | null;
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
