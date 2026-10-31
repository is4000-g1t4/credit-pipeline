// Per-run state shared by the case-brief model tools and the server-side
// preflight. One instance per `runBrief` call; the tool files in ./tools
// close over it instead of module state so concurrent runs never mix.
import type { ResearchEnv } from "../../env.js";
import type { QueryEntity, TavilyClient } from "./tavily.js";

export interface FetchedEvidence {
	requestedUrl: string;
	returnedUrl: string;
	title: string | null;
	searchPublishedDate: string | null;
	rawContent: string;
}

export interface TavilySearchHitLite {
	title: string | null;
	publishedDate: string | null;
}

export interface BriefToolRuntime {
	env: ResearchEnv;
	tavily: TavilyClient;
	entity: QueryEntity;
	asOfDate: string;
	/** Pages extracted so far (preflight + tools); becomes the evidence set. */
	fetched: FetchedEvidence[];
	/** Search hits by URL, so a later fetch can recover title/date. */
	seen: Map<string, TavilySearchHitLite>;
	counters: { toolCalls: number; searches: number; extracts: number };
	/** Counts one model tool call against AGENT_MAX_TOOL_CALLS (throws past it). */
	budget(): void;
	/** Metadata-only tool span (name/timing/errors; never args or results). */
	track<T>(toolName: "search_sources" | "fetch_source", fn: () => Promise<T>): Promise<T>;
}
