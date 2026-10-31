// Tavily search + extract only (§6.2, §9). No direct fetches anywhere in
// this service. The server builds every query from a fixed template — the
// model passes only (entity, category), never a free-form query.
import { createRetryingFetch, type RetryOptions } from "@credit/agent-kit";
import { normalizePublishedAt } from "./brief-schema.js";

export const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
export const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";

export type SearchCategory = "adverse_media" | "reputation" | "registry" | "market" | "other";

const CATEGORY_KEYWORDS: Record<SearchCategory, string> = {
	adverse_media: "fraud OR insolvency OR conviction OR investigation",
	reputation: "reviews OR complaints OR reputation",
	registry: "company registration OR filing",
	market: "market OR sector news",
	other: "news",
};

export interface QueryEntity {
	name: string;
	city: string | null;
	registrationNumber: string | null;
}

/** Fixed template: quoted entity + city + category keywords. */
export function buildSearchQuery(entity: QueryEntity, category: SearchCategory): string {
	const parts = [`"${entity.name}"`];
	if (entity.city) parts.push(`"${entity.city}"`);
	if (entity.registrationNumber && category === "registry")
		parts.push(`"${entity.registrationNumber}"`);
	parts.push(CATEGORY_KEYWORDS[category]);
	return parts.join(" ");
}

export class TavilyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TavilyError";
	}
}

export interface TavilySearchHit {
	url: string;
	title: string | null;
	publishedDate: string | null;
}

export interface TavilyExtractHit {
	url: string;
	rawContent: string;
}

export interface TavilyClient {
	search(query: string, opts: { maxResults: number; endDate: string }): Promise<TavilySearchHit[]>;
	extract(urls: string[]): Promise<TavilyExtractHit[]>;
}

export function createTavilyClient(opts: {
	apiKey: string;
	/** Raw transport (tests). Used as given: no retry wrapper is added. */
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	/** Retry tuning for the default transport (metadata-only `onRetry`). */
	retry?: RetryOptions;
}): TavilyClient {
	// Transient Tavily failures (429/5xx, network, per-call timeout) retry
	// with the shared policy. The per-call `timeoutMs` signal below is the
	// caller's abort, so it bounds all attempts together; the status-to-error
	// mapping further down is unchanged and sees only the final response.
	const fetchImpl = opts.fetchImpl ?? createRetryingFetch(opts.retry ?? {});
	const timeoutMs = opts.timeoutMs ?? 20_000;
	const post = async (url: string, body: Record<string, unknown>): Promise<unknown> => {
		let res: Response;
		try {
			res = await fetchImpl(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ api_key: opts.apiKey, ...body }),
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch {
			throw new TavilyError("tavily request failed");
		}
		if (!res.ok) throw new TavilyError(`tavily request failed (${res.status})`);
		try {
			return await res.json();
		} catch {
			throw new TavilyError("tavily returned invalid JSON");
		}
	};
	return {
		async search(query, { maxResults, endDate }) {
			const json = (await post(TAVILY_SEARCH_URL, {
				query,
				max_results: maxResults,
				include_answer: false,
				end_date: endDate,
			})) as { results?: Array<{ url?: string; title?: string; published_date?: string }> };
			return (json.results ?? []).slice(0, maxResults).flatMap((r) => {
				if (typeof r.url !== "string" || !r.url) return [];
				return [
					{
						url: r.url,
						title: typeof r.title === "string" ? r.title : null,
						publishedDate: normalizePublishedAt(r.published_date),
					},
				];
			});
		},
		async extract(urls) {
			if (urls.length === 0) return [];
			const json = (await post(TAVILY_EXTRACT_URL, {
				urls,
				extract_depth: "basic",
			})) as { results?: Array<{ url?: string; raw_content?: string }> };
			return (json.results ?? []).flatMap((r) => {
				if (typeof r.url !== "string" || typeof r.raw_content !== "string" || !r.raw_content) {
					return [];
				}
				return [{ url: r.url, rawContent: r.raw_content }];
			});
		},
	};
}
