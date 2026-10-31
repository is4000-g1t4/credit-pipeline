// search_sources: the model supplies only (entity, category); the server
// builds the Tavily query from a fixed template and auto-extracts the top
// unused result so a search yields citable evidence within the extract budget.
import { tool } from "@openai/agents";
import { z } from "zod";
import { validateFinalUrl } from "../../../urls.js";
import { buildSearchQuery, TavilyError, type SearchCategory } from "../tavily.js";
import type { BriefToolRuntime } from "../tool-runtime.js";

const searchParams = z
	.object({
		entity: z.string().min(1).max(200),
		category: z.enum(["adverse_media", "reputation", "registry", "market", "other"]),
	})
	.strict();

export function createSearchSourcesTool(rt: BriefToolRuntime) {
	const { env, tavily, fetched, seen, counters } = rt;
	return tool({
		name: "search_sources",
		description:
			"Search approved public sources for an entity and category. Returns up to N results with url, title, publication date, and the extracted text of the top result when available.",
		parameters: searchParams,
		execute: async ({ entity, category }: { entity: string; category: SearchCategory }) =>
			rt.track("search_sources", async () => {
				rt.budget();
				if (!env.tavilyApiKey) throw new TavilyError("search is not configured");
				counters.searches += 1;
				// The server builds the query from a fixed template; the
				// model supplies only the entity name and category.
				const name = entity.slice(0, 200);
				const query = buildSearchQuery(
					{
						name,
						city: rt.entity.city,
						registrationNumber: rt.entity.registrationNumber,
					},
					category,
				);
				const hits = await tavily.search(query, {
					maxResults: env.maxSources,
					endDate: rt.asOfDate,
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
				if (counters.extracts < Math.min(env.maxFetches, 2)) {
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
									counters.extracts += 1;
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
}
