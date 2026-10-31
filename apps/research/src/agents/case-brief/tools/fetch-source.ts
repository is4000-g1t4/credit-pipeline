// fetch_source: extract one search-result URL through the extraction
// service. Cached pages are returned without spending budget; the URL is
// re-validated server-side before any request leaves.
import { tool } from "@openai/agents";
import { z } from "zod";
import { validateFinalUrl } from "../../../urls.js";
import { TavilyError } from "../tavily.js";
import type { BriefToolRuntime } from "../tool-runtime.js";

const fetchParams = z.object({ url: z.string().min(1).max(2000) }).strict();

export function createFetchSourceTool(rt: BriefToolRuntime) {
	const { env, tavily, fetched, seen, counters } = rt;
	return tool({
		name: "fetch_source",
		description:
			"Extract the text of one search-result URL via the extraction service. Returns the page text.",
		parameters: fetchParams,
		execute: async ({ url }: { url: string }) =>
			rt.track("fetch_source", async () => {
				const cached = fetched.find((f) => f.requestedUrl === url || f.returnedUrl === url);
				if (cached) return cached.rawContent.slice(0, 2500);
				rt.budget();
				if (!env.tavilyApiKey) throw new TavilyError("extract is not configured");
				if (counters.extracts >= env.maxFetches) throw new TavilyError("extract budget exceeded");
				const verdict = validateFinalUrl(url);
				if (!verdict.ok) throw new TavilyError(`unsafe URL: ${verdict.error}`);
				counters.extracts += 1;
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
}
