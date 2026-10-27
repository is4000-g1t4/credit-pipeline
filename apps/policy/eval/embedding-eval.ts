/**
 * Standalone embedding-model eval for the policy seed corpus.
 *
 * Run from repo root: pnpm exec tsx apps/policy/eval/embedding-eval.ts
 *
 * - Parses apps/policy/policies/credit/*.md through the production loader
 *   (eval/corpus.ts + src/chunks.ts), one chunk per section, embedded with
 *   the same `embeddingText` production ingestion uses.
 * - Verifies candidate models against OpenRouter /api/v1/models; skips and
 *   reports unavailable ones without guessing replacements.
 * - Sends `provider: { data_collection: "deny", zdr: true }` on the first
 *   embeddings call; if the API rejects provider params it retries once
 *   without them and records the fallback.
 * - Exact in-memory cosine similarity, no DB. Metrics per split (dev,
 *   held-out): recall@5, MRR, nDCG@5, exact-section (top-1) hit, mean
 *   latency, cost estimate, dimensions, chunk count; Wilson 95% CI for
 *   recall/hit. Winner by held-out recall@5, then lower CI bound, then
 *   smaller dimension/cost.
 *
 * No dependencies beyond node builtins. Reads OPENROUTER_API_KEY from root
 * .env. Never prints the key.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cosine, embeddingText, loadCorpus } from "./corpus.js";
import { wilsonCI as wilson } from "./lib.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..", "..");
const QUERIES_PATH = path.join(HERE, "queries.json");
const RESULTS_DIR = path.join(HERE, "results");

const CANDIDATE_MODELS = [
	"openai/text-embedding-3-small",
	"openai/text-embedding-3-large",
	"voyageai/voyage-4-large",
	"voyageai/voyage-4",
	"qwen/qwen3-embedding-8b",
	"baai/bge-m3",
	"perplexity/pplx-embed-v1-0.6b",
];

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const MAX_CONCURRENCY = 2;
const CHUNK_BATCH = 16;
const QUERY_BATCH = 8;
const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [1000, 2000, 4000, 8000];

interface Chunk {
	id: string;
	policyKey: string;
	title: string;
	heading: string;
	text: string;
}

interface EvalQuery {
	id: string;
	split: string;
	type: string;
	question: string;
	expected: string[];
}

function loadDotEnv(): void {
	let raw = "";
	try {
		raw = readFileSync(path.join(ROOT, ".env"), "utf8");
	} catch {
		return;
	}
	for (const line of raw.split("\n")) {
		const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
		if (!m) continue;
		const [, k, v] = m;
		if (!(k in process.env)) process.env[k] = v.replace(/^["']|["']$/g, "");
	}
}

function semaphore(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
	let active = 0;
	const waiting: Array<() => void> = [];
	return async <T>(fn: () => Promise<T>): Promise<T> => {
		if (active >= max) {
			await new Promise<void>((resolve) => waiting.push(resolve));
		}
		active++;
		try {
			return await fn();
		} finally {
			active--;
			const next = waiting.shift();
			if (next) next();
		}
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(
	url: string,
	init: RequestInit,
	apiKey: string,
): Promise<{ status: number; json: unknown }> {
	let lastStatus = 0;
	let lastBody = "";
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const res = await fetch(url, {
			...init,
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				...init.headers,
			},
		});
		lastStatus = res.status;
		lastBody = await res.text();
		if (res.status === 429 || res.status >= 500) {
			const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] + Math.random() * 500;
			await sleep(wait);
			continue;
		}
		try {
			return { status: res.status, json: JSON.parse(lastBody) as unknown };
		} catch {
			throw new Error(`HTTP ${res.status}: non-JSON response: ${lastBody.slice(0, 300)}`);
		}
	}
	throw new Error(`HTTP ${lastStatus} after ${MAX_ATTEMPTS} attempts: ${lastBody.slice(0, 500)}`);
}

interface SplitMetrics {
	n: number;
	recallAt5: number;
	recallAt5CI: { lo: number; hi: number };
	mrr: number;
	ndcgAt5: number;
	exactHit: number;
	exactHitCI: { lo: number; hi: number };
}

function scoreSplit(rankedIds: string[][], expectedList: string[][]): SplitMetrics {
	const n = expectedList.length;
	let hits = 0;
	let exact = 0;
	let mrr = 0;
	let ndcg = 0;
	for (let i = 0; i < n; i++) {
		const expected = new Set(expectedList[i]);
		const ranked = rankedIds[i];
		let best = Number.POSITIVE_INFINITY;
		let dcg = 0;
		for (let p = 0; p < Math.min(ranked.length, 5); p++) {
			if (expected.has(ranked[p])) {
				best = Math.min(best, p + 1);
				dcg += 1 / Math.log2(p + 2);
			}
		}
		const idealCount = Math.min(expected.size, 5);
		let idcg = 0;
		for (let k = 0; k < idealCount; k++) idcg += 1 / Math.log2(k + 2);
		if (best <= 5) hits++;
		if (best === 1) exact++;
		if (best !== Number.POSITIVE_INFINITY) mrr += 1 / best;
		ndcg += idcg > 0 ? dcg / idcg : 0;
	}
	const recallAt5 = n > 0 ? hits / n : 0;
	const exactHit = n > 0 ? exact / n : 0;
	return {
		n,
		recallAt5,
		recallAt5CI: wilson(recallAt5, n),
		mrr: n > 0 ? mrr / n : 0,
		ndcgAt5: n > 0 ? ndcg / n : 0,
		exactHit,
		exactHitCI: wilson(exactHit, n),
	};
}

interface ModelResult {
	model: string;
	available: boolean;
	listedInModels: boolean;
	unavailableReason?: string;
	dimensions: number | null;
	chunkCount: number;
	providerFallbackWithoutParams: boolean;
	dev: SplitMetrics | null;
	heldOut: SplitMetrics | null;
	meanLatencyMs: number | null;
	promptTokens: number;
	tokensEstimated: boolean;
	costUsdEstimate: number | null;
	error?: string;
}

async function main(): Promise<void> {
	loadDotEnv();
	const apiKey = (process.env["OPENROUTER_API_KEY"] ?? "").trim();
	if (!apiKey) {
		console.error("OPENROUTER_API_KEY is missing in root .env — cannot run eval.");
		process.exit(1);
	}

	const corpusSections = loadCorpus();
	const docs = new Set(corpusSections.map((s) => s.policyKey)).size;
	const chunks: Chunk[] = corpusSections.map((s) => ({
		id: `${s.policyKey}#${s.sectionId}`,
		policyKey: s.policyKey,
		title: s.title,
		heading: s.heading,
		text: s.body,
	}));
	const chunkIds = new Set(chunks.map((c) => c.id));
	const queries = JSON.parse(readFileSync(QUERIES_PATH, "utf8")) as EvalQuery[];
	const unknown = [...new Set(queries.flatMap((q) => q.expected))].filter(
		(id) => !chunkIds.has(id),
	);
	if (unknown.length > 0) {
		console.error(`queries.json references unknown section ids: ${unknown.join(", ")}`);
		process.exit(1);
	}
	const dev = queries.filter((q) => q.split === "dev");
	const heldOut = queries.filter((q) => q.split === "held-out");
	console.log(
		`corpus: ${docs} docs, ${chunks.length} chunks; queries: ${dev.length} dev, ${heldOut.length} held-out`,
	);

	// Verify candidate models against OpenRouter.
	const modelsRes = await fetchJson(`${OPENROUTER_BASE}/models`, { method: "GET" }, apiKey);
	if (modelsRes.status !== 200) {
		console.error(
			`GET /models failed: HTTP ${modelsRes.status} ${JSON.stringify(modelsRes.json).slice(0, 500)}`,
		);
		process.exit(1);
	}
	const listed =
		(modelsRes.json as { data?: Array<{ id?: string; pricing?: Record<string, string> }> }).data ??
		[];
	const byId = new Map(listed.map((m) => [m.id ?? "", m]));
	console.log(
		`/models lists ${listed.length} ids; embedding ids are checked against it, then probed directly`,
	);
	const limit = semaphore(MAX_CONCURRENCY);
	let providerParamsAccepted: boolean | null = null; // null = untested
	const noProviderModels = new Set<string>(); // models with no ZDR endpoint; evaluated without provider params

	const embedBatch = async (
		model: string,
		inputs: string[],
	): Promise<{ embeddings: number[][]; promptTokens: number; estimated: boolean }> => {
		const attempt = async (withProvider: boolean) =>
			limit(() =>
				fetchJson(
					`${OPENROUTER_BASE}/embeddings`,
					{
						method: "POST",
						body: JSON.stringify({
							model,
							input: inputs,
							...(withProvider ? { provider: { data_collection: "deny", zdr: true } } : {}),
						}),
					},
					apiKey,
				),
			);
		let res: { status: number; json: unknown };
		let usedProvider = providerParamsAccepted !== false && !noProviderModels.has(model);
		res = await attempt(usedProvider);
		const bodyText = JSON.stringify(res.json).toLowerCase();
		if (
			usedProvider &&
			((res.status === 400 && bodyText.includes("provider")) ||
				(res.status === 404 && bodyText.includes("data policy")))
		) {
			// Provider params rejected (or no endpoint matching the data
			// policy): retry once without them and record the fallback.
			noProviderModels.add(model);
			usedProvider = false;
			res = await attempt(false);
		} else if (usedProvider && res.status === 200 && providerParamsAccepted === null) {
			providerParamsAccepted = true;
		}
		if (res.status !== 200) {
			throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.json).slice(0, 500)}`);
		}
		const body = res.json as {
			data?: Array<{ embedding?: number[]; index?: number }>;
			usage?: { prompt_tokens?: number; total_tokens?: number };
		};
		if (!Array.isArray(body.data) || body.data.length !== inputs.length) {
			throw new Error(
				`unexpected embeddings response shape: ${JSON.stringify(res.json).slice(0, 500)}`,
			);
		}
		const ordered = [...body.data]
			.map((d, i) => ({ emb: d.embedding, idx: d.index ?? i }))
			.sort((x, y) => x.idx - y.idx);
		if (ordered.some((o) => !Array.isArray(o.emb))) {
			throw new Error(`missing embedding vector: ${JSON.stringify(res.json).slice(0, 500)}`);
		}
		const promptTokens = body.usage?.prompt_tokens ?? body.usage?.total_tokens ?? 0;
		return {
			embeddings: ordered.map((o) => o.emb as number[]),
			promptTokens,
			estimated: promptTokens === 0,
		};
	};

	const results: ModelResult[] = [];
	for (const model of CANDIDATE_MODELS) {
		const listedEntry = byId.get(model);
		const listedInModels = !!listedEntry;
		if (!listedEntry) {
			// /models does not list embedding ids; probe the exact id once
			// against /embeddings before declaring it unavailable.
			try {
				await embedBatch(model, ["connectivity probe"]);
				console.log(`note ${model}: absent from /models but accepted by /embeddings; evaluating`);
			} catch (err) {
				const reason = `not listed by /models; direct probe failed: ${err instanceof Error ? err.message : String(err)}`;
				console.log(`skip ${model}: ${reason}`);
				results.push({
					model,
					available: false,
					listedInModels,
					unavailableReason: reason,
					dimensions: null,
					chunkCount: chunks.length,
					providerFallbackWithoutParams: noProviderModels.has(model),
					dev: null,
					heldOut: null,
					meanLatencyMs: null,
					promptTokens: 0,
					tokensEstimated: false,
					costUsdEstimate: null,
				});
				continue;
			}
		}
		const pricePerToken = listedEntry?.pricing?.prompt
			? Number(listedEntry.pricing.prompt)
			: Number.NaN;
		try {
			// Embed chunks in batches.
			const chunkVecs: number[][] = [];
			let promptTokens = 0;
			let estimated = false;
			const chunkTexts = chunks.map((c) =>
				embeddingText({ title: c.title, heading: c.heading, body: c.text }),
			);
			for (let i = 0; i < chunkTexts.length; i += CHUNK_BATCH) {
				const r = await embedBatch(model, chunkTexts.slice(i, i + CHUNK_BATCH));
				chunkVecs.push(...r.embeddings);
				promptTokens += r.promptTokens;
				estimated = estimated || r.estimated;
			}
			if (promptTokens === 0) {
				promptTokens =
					chunkTexts.join(" ").length / 4 + queries.reduce((a, q) => a + q.question.length, 0) / 4;
				estimated = true;
			}
			const t0 = Date.now();
			const queryVecs: number[][] = [];
			for (let i = 0; i < queries.length; i += QUERY_BATCH) {
				const r = await embedBatch(
					model,
					queries.slice(i, i + QUERY_BATCH).map((q) => q.question),
				);
				queryVecs.push(...r.embeddings);
				promptTokens += r.promptTokens;
				estimated = estimated || r.estimated;
			}
			const wallMs = Date.now() - t0;
			const ranked = queryVecs.map((qv) =>
				chunkVecs
					.map((cv, ci) => ({ ci, s: cosine(qv, cv) }))
					.sort((a, b) => b.s - a.s)
					.map((r) => chunks[r.ci].id),
			);
			const devRanked = dev.map((q) => ranked[queries.indexOf(q)]);
			const heldRanked = heldOut.map((q) => ranked[queries.indexOf(q)]);
			results.push({
				model,
				available: true,
				listedInModels,
				dimensions: chunkVecs[0]?.length ?? null,
				chunkCount: chunks.length,
				providerFallbackWithoutParams:
					providerParamsAccepted === false || noProviderModels.has(model),
				dev: scoreSplit(
					devRanked,
					dev.map((q) => q.expected),
				),
				heldOut: scoreSplit(
					heldRanked,
					heldOut.map((q) => q.expected),
				),
				meanLatencyMs: wallMs / queries.length,
				promptTokens: Math.round(promptTokens),
				tokensEstimated: estimated,
				costUsdEstimate: Number.isFinite(pricePerToken) ? promptTokens * pricePerToken : null,
			});
			const r7 = results[results.length - 1];
			console.log(
				`done ${model}: dim=${r7.dimensions} devR@5=${r7.dev?.recallAt5.toFixed(3)} heldR@5=${r7.heldOut?.recallAt5.toFixed(3)}`,
			);
		} catch (err) {
			console.log(`fail ${model}: ${err instanceof Error ? err.message : String(err)}`);
			results.push({
				model,
				available: true,
				listedInModels,
				dimensions: null,
				chunkCount: chunks.length,
				providerFallbackWithoutParams:
					providerParamsAccepted === false || noProviderModels.has(model),
				dev: null,
				heldOut: null,
				meanLatencyMs: null,
				promptTokens: 0,
				tokensEstimated: false,
				costUsdEstimate: null,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	const evaluated = results.filter((r) => r.dev && r.heldOut);
	if (evaluated.length === 0) {
		console.error("all models failed or unavailable; no metrics to report.");
		process.exit(1);
	}
	const rank = [...evaluated].sort((a, b) => {
		const dh = (b.heldOut as SplitMetrics).recallAt5 - (a.heldOut as SplitMetrics).recallAt5;
		if (dh !== 0) return dh;
		const dc =
			(b.heldOut as SplitMetrics).recallAt5CI.lo - (a.heldOut as SplitMetrics).recallAt5CI.lo;
		if (dc !== 0) return dc;
		const dd =
			(a.dimensions ?? Number.MAX_SAFE_INTEGER) - (b.dimensions ?? Number.MAX_SAFE_INTEGER);
		if (dd !== 0) return dd;
		const ca = a.costUsdEstimate ?? Number.MAX_SAFE_INTEGER;
		const cb = b.costUsdEstimate ?? Number.MAX_SAFE_INTEGER;
		return ca - cb;
	});
	const winner = rank[0].model;

	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
	mkdirSync(RESULTS_DIR, { recursive: true });
	const outPath = path.join(RESULTS_DIR, `embedding-${stamp}.json`);
	writeFileSync(
		outPath,
		JSON.stringify(
			{
				timestamp: new Date().toISOString(),
				corpus: { docs, chunks: chunks.length },
				queryCounts: { dev: dev.length, heldOut: heldOut.length },
				providerParamsAccepted: providerParamsAccepted !== false,
				models: results,
				winner,
			},
			null,
			"\t",
		) + "\n",
	);
	console.log(`\nresults: ${outPath}`);
	console.log(`winner: ${winner}`);
	for (const r of rank) {
		const d = r.dev as SplitMetrics;
		const h = r.heldOut as SplitMetrics;
		console.log(
			`${r.model} dim=${r.dimensions} dev R@5=${d.recallAt5.toFixed(3)} MRR=${d.mrr.toFixed(3)} nDCG@5=${d.ndcgAt5.toFixed(3)} hit=${d.exactHit.toFixed(3)} | held R@5=${h.recallAt5.toFixed(3)} [${h.recallAt5CI.lo.toFixed(3)},${h.recallAt5CI.hi.toFixed(3)}] MRR=${h.mrr.toFixed(3)} nDCG@5=${h.ndcgAt5.toFixed(3)} hit=${h.exactHit.toFixed(3)} | lat=${r.meanLatencyMs?.toFixed(0)}ms cost=${r.costUsdEstimate === null ? "n/a" : "$" + r.costUsdEstimate.toFixed(6)}`,
		);
	}
}

try {
	await main();
} catch (err) {
	console.error(`fatal: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
}
