// Settings eval for the two research agents.
//
//   pnpm --filter @credit/research eval:settings -- --mode=context
//   pnpm --filter @credit/research eval:settings -- --mode=web
//   pnpm --filter @credit/research eval:settings -- --mode=all
//
// Context mode sweeps BreadTalk (rich) + Sparse (no accounts/transactions)
// and validates only the winner on Alex (individual).
// Web mode runs the real case-brief agent against a deterministic Tavily
// fixture so model settings are the only variable. The web harness checks
// the raw brief shape only — it does NOT exercise the production validator,
// so scores are n=1 and directional. Use --repeats=N for repeated runs
// (median/mean reported). Results are printed and written under eval/results/.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "@credit/db/applications";
import { ensureCase, type ContextCase } from "./fixtures.js";
import { createOpenRouterClient } from "@credit/agent-kit";
import { createLogger } from "@credit/service-kit";
import {
	createRealRunner,
	projectCostUsd,
	type AgentResult,
	type TavilyClient,
	locateQuote,
	modelBriefSchema,
	scanForbidden,
	scanProtected,
} from "../src/agents/case-brief/index.js";
import {
	createRealContextRunner,
	type ContextAgentRunner,
	validateContextOutput,
} from "../src/agents/context-analyst/index.js";
import { loadEnv } from "../src/env.js";
import { tierForHost } from "../src/sources.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "results");

function arg(name: string): string | undefined {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit?.slice(name.length + 3);
}

const env = loadEnv();
const logger = createLogger("research-eval");
const openai = createOpenRouterClient({
	apiKey: env.openrouterApiKey || "unconfigured",
	// Retry metadata only (attempt, reason, status, delay); never bodies.
	retry: {
		onRetry: ({ attempt, reason, status, delayMs }) =>
			logger.warn({ agent: "settings-eval", attempt, reason, status, delayMs }, "model call retry"),
	},
});

interface ContextConfig {
	name: string;
	temperature: number;
	maxOutputTokens: number;
	maxTurns: number;
	maxToolCalls: number;
}

interface ContextRow {
	config: string;
	case: string;
	ok: boolean;
	firstPass: boolean;
	repaired: boolean;
	signals: number;
	candidates: number;
	dropped: number;
	limitations: number;
	keywordHits: number;
	toolCalls: number;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	durationMs: number;
	error: string | null;
	score: number;
}

interface WebConfig {
	name: string;
	temperature?: number;
	maxOutputTokens?: number;
	maxTurns: number;
	maxToolCalls: number;
	maxSources: number;
	maxFetches: number;
}

interface WebRow {
	config: string;
	ok: boolean;
	findings: number;
	evidence: number;
	quotesVerified: number;
	official: boolean;
	publishers: number;
	forbidden: number;
	protectedAttrs: number;
	toolCalls: number;
	searches: number;
	extracts: number;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	durationMs: number;
	error: string | null;
	score: number;
}

const contextConfigs: ContextConfig[] = [
	{ name: "baseline", temperature: 0.1, maxOutputTokens: 6000, maxTurns: 16, maxToolCalls: 24 },
	{ name: "temp-0.0", temperature: 0, maxOutputTokens: 6000, maxTurns: 16, maxToolCalls: 24 },
	{ name: "temp-0.3", temperature: 0.3, maxOutputTokens: 6000, maxTurns: 16, maxToolCalls: 24 },
	{ name: "tokens-3000", temperature: 0.1, maxOutputTokens: 3000, maxTurns: 16, maxToolCalls: 24 },
	{ name: "tokens-9000", temperature: 0.1, maxOutputTokens: 9000, maxTurns: 16, maxToolCalls: 24 },
	{ name: "turns-8", temperature: 0.1, maxOutputTokens: 6000, maxTurns: 8, maxToolCalls: 24 },
	{ name: "turns-24", temperature: 0.1, maxOutputTokens: 6000, maxTurns: 24, maxToolCalls: 24 },
	{ name: "tools-16", temperature: 0.1, maxOutputTokens: 6000, maxTurns: 16, maxToolCalls: 16 },
	{ name: "tools-32", temperature: 0.1, maxOutputTokens: 6000, maxTurns: 16, maxToolCalls: 32 },
];

const webConfigs: WebConfig[] = [
	{ name: "temp-0.0", temperature: 0, maxTurns: 12, maxToolCalls: 8, maxSources: 6, maxFetches: 4 },
	{
		name: "temp-0.1",
		temperature: 0.1,
		maxTurns: 12,
		maxToolCalls: 8,
		maxSources: 6,
		maxFetches: 4,
	},
	{
		name: "temp-0.3",
		temperature: 0.3,
		maxTurns: 12,
		maxToolCalls: 8,
		maxSources: 6,
		maxFetches: 4,
	},
	{
		name: "tokens-1200",
		temperature: 0.1,
		maxOutputTokens: 1200,
		maxTurns: 12,
		maxToolCalls: 8,
		maxSources: 6,
		maxFetches: 4,
	},
	{
		name: "tokens-2000",
		temperature: 0.1,
		maxOutputTokens: 2000,
		maxTurns: 12,
		maxToolCalls: 8,
		maxSources: 6,
		maxFetches: 4,
	},
	{
		name: "tokens-3000",
		temperature: 0.1,
		maxOutputTokens: 3000,
		maxTurns: 12,
		maxToolCalls: 8,
		maxSources: 6,
		maxFetches: 4,
	},
	{ name: "turns-8", temperature: 0.1, maxTurns: 8, maxToolCalls: 8, maxSources: 6, maxFetches: 4 },
	{
		name: "tools-12",
		temperature: 0.1,
		maxTurns: 12,
		maxToolCalls: 12,
		maxSources: 6,
		maxFetches: 4,
	},
	{
		name: "sources-4",
		temperature: 0.1,
		maxTurns: 12,
		maxToolCalls: 8,
		maxSources: 4,
		maxFetches: 4,
	},
	{
		name: "fetches-3",
		temperature: 0.1,
		maxTurns: 12,
		maxToolCalls: 8,
		maxSources: 6,
		maxFetches: 3,
	},
];

function runContext(
	runner: ContextAgentRunner,
	c: ContextCase,
	cfg: ContextConfig,
): Promise<ContextRow> {
	const started = Date.now();
	return (async () => {
		try {
			const raw = await runner.runContext({
				applicationId: c.applicationId,
				caseFacts: c.caseFacts,
				asOfDate: c.asOfDate,
				externalSummary: null,
				signal: AbortSignal.timeout(240_000),
			});
			const validate = (output: unknown) =>
				validateContextOutput({
					output,
					snapshots: raw.snapshots,
					seenEvidence: raw.seenEvidence,
					asOfDate: c.asOfDate,
					historyMonths: env.contextHistoryMonths,
				});
			let validation = validate(raw.output);
			let repaired = false;
			let repairIn = 0;
			let repairOut = 0;
			if (!validation.ok) {
				repaired = true;
				const fixed = await runner.repairContext({
					applicationId: c.applicationId,
					caseFacts: c.caseFacts,
					asOfDate: c.asOfDate,
					externalSummary: null,
					signal: AbortSignal.timeout(240_000),
					previous: raw.output,
					issues: validation.issues,
					snapshots: raw.snapshots,
					seenEvidence: raw.seenEvidence,
				});
				repairIn += fixed.usage.inputTokens;
				repairOut += fixed.usage.outputTokens;
				validation = validate(fixed.output);
			}
			const durationMs = Date.now() - started;
			// Single ledger: initial tokens plus the repair attempt.
			const inputTokens = raw.usage.inputTokens + repairIn;
			const outputTokens = raw.usage.outputTokens + repairOut;
			const costUsd = projectCostUsd(inputTokens, outputTokens);
			const limitationsText = [...validation.dataGaps, ...validation.limitations]
				.join(" ")
				.toLowerCase();
			const keywordHits = c.keywords.filter((k) => limitationsText.includes(k)).length;
			const candidates = raw.snapshots.length;
			const coverage = candidates === 0 ? 1 : validation.signals.length / candidates;
			const score =
				(validation.ok ? 1000 : 0) +
				(validation.ok && !repaired ? 150 : 0) +
				coverage * 100 +
				Math.min(keywordHits, 8) * 10 -
				validation.dropped.length * 5 -
				(durationMs / 1000) * 0.2 -
				costUsd * 20;
			return {
				config: cfg.name,
				case: c.name,
				ok: validation.ok,
				firstPass: validation.ok && !repaired,
				repaired,
				signals: validation.signals.length,
				candidates,
				dropped: validation.dropped.length,
				limitations: validation.dataGaps.length + validation.limitations.length,
				keywordHits,
				// Total attempts: bounded preflight + model loop (see
				// CONTEXT_AGENT_PREFLIGHT_TOOL_CALLS / MAX_TOOL_CALLS).
				toolCalls: raw.usage.toolCalls,
				inputTokens,
				outputTokens,
				costUsd,
				durationMs,
				error: null,
				score,
			};
		} catch (err) {
			return {
				config: cfg.name,
				case: c.name,
				ok: false,
				firstPass: false,
				repaired: false,
				signals: 0,
				candidates: 0,
				dropped: 0,
				limitations: 0,
				keywordHits: 0,
				toolCalls: 0,
				inputTokens: 0,
				outputTokens: 0,
				costUsd: 0,
				durationMs: Date.now() - started,
				error: err instanceof Error ? err.message : String(err),
				score: 0,
			};
		}
	})();
}

const WEB_QUOTE_A = "Acme Ltd filed accounts for the year ending March 2025 on time.";
const WEB_QUOTE_B = "Local paper notes Acme Ltd opened a second warehouse in Leeds.";
const WEB_URL_A = "https://find-and-update.company-information.service.gov.uk/company/123";
const WEB_URL_B = "https://www.bbc.co.uk/news/acme-leeds";
const WEB_RAW_A = `Published 2025-06-01.\nheader\n${WEB_QUOTE_A}\nfooter `.repeat(20);
const WEB_RAW_B = `Published 2025-05-01.\nintro\n${WEB_QUOTE_B}\nmore text here `.repeat(20);

const WEB_ENTITY = "Acme Ltd";
const webTavilyMisses: string[] = [];

const fakeTavily: TavilyClient = {
	async search(query) {
		// The agent must name the entity it is researching: an unnamed
		// query returns nothing and records a miss (isolation probe).
		if (!query.toLowerCase().includes(WEB_ENTITY.toLowerCase())) {
			webTavilyMisses.push(query);
			return [];
		}
		return [
			{ url: WEB_URL_A, title: "Acme Ltd filings", publishedDate: "2025-06-01" },
			{ url: WEB_URL_B, title: "Acme opens warehouse", publishedDate: "2025-05-01" },
		];
	},
	async extract(urls) {
		return urls.map((url) => ({
			url,
			rawContent: url === WEB_URL_A ? WEB_RAW_A : WEB_RAW_B,
		}));
	},
};

const webCaseFacts = {
	applicantName: "Jane Doe",
	companyName: "Acme Ltd",
	registrationNumber: "12345678",
	city: "Leeds",
	industry: "manufacturing",
	yearsTrading: 5,
	product: "business_loan",
	amountCents: 500_000,
	termMonths: 36,
	asOf: "2026-06-30",
};

function evalWebBrief(result: AgentResult, durationMs: number): WebRow {
	const parsed = modelBriefSchema.safeParse(result.brief);
	if (!parsed.success) {
		return {
			config: "",
			ok: false,
			findings: 0,
			evidence: 0,
			quotesVerified: 0,
			official: false,
			publishers: 0,
			forbidden: 0,
			protectedAttrs: 0,
			toolCalls: result.usage.toolCalls,
			searches: result.usage.searches,
			extracts: result.usage.extracts,
			inputTokens: result.usage.inputTokens,
			outputTokens: result.usage.outputTokens,
			costUsd: projectCostUsd(result.usage.inputTokens, result.usage.outputTokens),
			durationMs,
			error: "brief failed schema validation",
			score: 0,
		};
	}
	const brief = parsed.data;
	const fetched = new Map(result.fetched.map((f) => [f.requestedUrl, f]));
	const evidenceRows = brief.evidence.map((e) => {
		const raw = fetched.get(e.url) ?? [...fetched.values()].find((f) => f.returnedUrl === e.url);
		return {
			verified: raw ? locateQuote(raw.rawContent, e.quote) !== null : false,
			tier: tierForHost(new URL(e.url).hostname),
			url: e.url,
			publisher: e.publisher?.trim() || new URL(e.url).hostname,
		};
	});
	const quotesVerified = evidenceRows.filter((e) => e.verified).length;
	const official = evidenceRows.some((e) => e.tier === "official" || e.tier === "registry");
	const publishers = new Set(evidenceRows.map((e) => e.publisher)).size;
	const generated = [
		brief.summary,
		...brief.findings.flatMap((f) => [f.claim, f.whyItMatters]),
		...brief.contradictions.map((c) => c.description),
		...brief.unknowns,
		...brief.questionsForOfficer,
	];
	const forbidden = generated.filter((t) => scanForbidden(t).length > 0).length;
	const protectedAttrs = generated.filter((t) => scanProtected(t).length > 0).length;
	const toolCalls = result.usage.toolCalls;
	const costUsd = projectCostUsd(result.usage.inputTokens, result.usage.outputTokens);
	const ok = brief.findings.length >= 1 && brief.evidence.length >= 1;
	const score =
		(ok ? 1000 : 0) +
		(brief.findings.length >= 2 ? 200 : 0) +
		(brief.evidence.length >= 2 ? 100 : 0) +
		quotesVerified * 50 +
		(official ? 100 : 0) +
		(publishers >= 2 ? 50 : 0) -
		forbidden * 100 -
		protectedAttrs * 100 -
		toolCalls * 2 -
		(durationMs / 1000) * 0.5 -
		costUsd * 20;
	return {
		config: "",
		ok,
		findings: brief.findings.length,
		evidence: brief.evidence.length,
		quotesVerified,
		official,
		publishers,
		forbidden,
		protectedAttrs,
		toolCalls,
		searches: result.usage.searches,
		extracts: result.usage.extracts,
		inputTokens: result.usage.inputTokens,
		outputTokens: result.usage.outputTokens,
		costUsd,
		durationMs,
		error: null,
		score,
	};
}

const repeats = Math.max(1, Number(arg("repeats") ?? "1") || 1);

function median(nums: number[]): number {
	if (nums.length === 0) return 0;
	const s = [...nums].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function average(rows: Array<{ score: number }>): number {
	return rows.length === 0 ? 0 : rows.reduce((n, r) => n + r.score, 0) / rows.length;
}

function printContext(rows: ContextRow[]): void {
	const groups = new Map<string, ContextRow[]>();
	for (const row of rows) {
		const list = groups.get(row.config) ?? [];
		list.push(row);
		groups.set(row.config, list);
	}
	console.table(
		[...groups.entries()].map(([config, list]) => ({
			config,
			score: average(list).toFixed(1),
			ok: `${list.filter((r) => r.ok).length}/${list.length}`,
			firstPass: `${list.filter((r) => r.firstPass).length}/${list.length}`,
			signals: list.map((r) => `${r.signals}/${r.candidates}`).join(" "),
			dropped: list.reduce((n, r) => n + r.dropped, 0),
			keywords: list.map((r) => r.keywordHits).join(" "),
			toolCalls: list.map((r) => r.toolCalls).join(" "),
			outTokens: list.map((r) => r.outputTokens).join(" "),
			ms: Math.round(list.reduce((n, r) => n + r.durationMs, 0) / list.length),
			usd: list.reduce((n, r) => n + r.costUsd, 0).toFixed(4),
			errors:
				list
					.filter((r) => r.error)
					.map((r) => r.error)
					.join(" | ") || "",
		})),
	);
}

function printWeb(rows: WebRow[]): void {
	console.table(
		rows.map((r) => ({
			config: r.config,
			score: r.score.toFixed(1),
			ok: r.ok,
			findings: r.findings,
			evidence: r.evidence,
			quotes: r.quotesVerified,
			official: r.official,
			publishers: r.publishers,
			forbidden: r.forbidden,
			protected: r.protectedAttrs,
			tools: r.toolCalls,
			searches: r.searches,
			extracts: r.extracts,
			outTokens: r.outputTokens,
			ms: Math.round(r.durationMs),
			usd: r.costUsd.toFixed(4),
			error: r.error ?? "",
		})),
	);
}

async function runContextEval(): Promise<void> {
	const { sql } = createDb(process.env.APPLICATIONS_DATABASE_URL as string);
	const cases: ContextCase[] = [];
	try {
		// A previous interrupted eval may have left its throwaway apps behind.
		// Scoped to eval-created rows only via fixture_key (never live data).
		await sql`DELETE FROM applications WHERE fixture_key LIKE 'eval-%'`;
		cases.push(await ensureCase(sql, "breadtalk"));
		cases.push(await ensureCase(sql, "sparse"));
	} catch (err) {
		console.error("context eval setup failed", err);
		await sql.end();
		process.exitCode = 1;
		return;
	}
	const rows: ContextRow[] = [];
	for (const cfg of contextConfigs) {
		const runner = createRealContextRunner({
			env: {
				...env,
				contextTemperature: cfg.temperature,
				contextMaxOutputTokens: cfg.maxOutputTokens,
				contextMaxTurns: cfg.maxTurns,
				contextMaxToolCalls: cfg.maxToolCalls,
			},
			openai,
		});
		for (const c of cases) {
			console.log(`context ${cfg.name} / ${c.name} ...`);
			rows.push(await runContext(runner, c, cfg));
		}
	}
	printContext(rows);
	const best = [...new Map(rows.map((r) => [r.config, r])).keys()]
		.map((config) => ({
			config,
			score: average(rows.filter((r) => r.config === config)),
		}))
		.sort((a, b) => b.score - a.score)[0];
	console.log("best context config by average score:", best);
	const bestCfg = contextConfigs.find((c) => c.name === best?.config);
	if (bestCfg) {
		const runner = createRealContextRunner({
			env: {
				...env,
				contextTemperature: bestCfg.temperature,
				contextMaxOutputTokens: bestCfg.maxOutputTokens,
				contextMaxTurns: bestCfg.maxTurns,
				contextMaxToolCalls: bestCfg.maxToolCalls,
			},
			openai,
		});
		try {
			const alex = await ensureCase(sql, "alex");
			console.log(`context ${bestCfg.name} / alex (validation) ...`);
			const alexRow = await runContext(runner, alex, bestCfg);
			rows.push(alexRow);
			console.log("alex best-config row", alexRow);
			if (alex.cleanup) {
				await sql`DELETE FROM applications WHERE id = ${alex.applicationId}`;
			}
		} catch (err) {
			console.error("alex validation failed", err);
		}
	}
	for (const c of cases) {
		if (c.cleanup) await sql`DELETE FROM applications WHERE id = ${c.applicationId}`;
	}
	await sql.end();
	mkdirSync(OUT_DIR, { recursive: true });
	writeFileSync(
		resolve(OUT_DIR, `context-${new Date().toISOString().replace(/[:.]/g, "-")}.json`),
		JSON.stringify({ configs: contextConfigs, rows }, null, 2),
	);
}

async function runWebEval(): Promise<void> {
	const rows: WebRow[] = [];
	for (const cfg of webConfigs) {
		const attempts: WebRow[] = [];
		for (let r = 0; r < repeats; r++) {
			const runner = createRealRunner({
				env: {
					...env,
					agentTemperature: cfg.temperature ?? env.agentTemperature,
					agentMaxOutputTokens: cfg.maxOutputTokens ?? env.agentMaxOutputTokens,
					agentMaxTurns: cfg.maxTurns,
					agentMaxToolCalls: cfg.maxToolCalls,
					maxSources: cfg.maxSources,
					maxFetches: cfg.maxFetches,
				},
				tavily: fakeTavily,
				openai,
			});
			console.log(`web ${cfg.name} (run ${r + 1}/${repeats}) ...`);
			const started = Date.now();
			try {
				const result = await runner.runBrief({
					caseFacts: webCaseFacts,
					entity: { name: "Acme Ltd", city: "Leeds", registrationNumber: "12345678" },
					asOfDate: "2026-06-30",
					signal: AbortSignal.timeout(120_000),
				});
				const row = evalWebBrief(result, Date.now() - started);
				const named: WebRow = { ...row, config: cfg.name };
				rows.push(named);
				attempts.push(named);
			} catch (err) {
				const failed: WebRow = {
					config: cfg.name,
					ok: false,
					findings: 0,
					evidence: 0,
					quotesVerified: 0,
					official: false,
					publishers: 0,
					forbidden: 0,
					protectedAttrs: 0,
					toolCalls: 0,
					searches: 0,
					extracts: 0,
					inputTokens: 0,
					outputTokens: 0,
					costUsd: 0,
					durationMs: Date.now() - started,
					error: err instanceof Error ? err.message : String(err),
					score: 0,
				};
				rows.push(failed);
				attempts.push(failed);
			}
		}
		const scores = attempts.map((a) => a.score);
		console.log(
			`web ${cfg.name}: median ${median(scores).toFixed(1)} mean ${average(attempts).toFixed(1)} over ${attempts.length} run(s)`,
		);
	}
	printWeb(rows);
	const byConfig = new Map<string, WebRow[]>();
	for (const r of rows) {
		const list = byConfig.get(r.config) ?? [];
		list.push(r);
		byConfig.set(r.config, list);
	}
	// Rank by mean of attempts (median breaks ties): a single lucky attempt
	// must not crown a config.
	const ranked = [...byConfig.entries()]
		.map(([config, list]) => {
			const scores = list.map((r) => r.score);
			return {
				config,
				mean: average(list),
				median: median(scores),
				runs: list.length,
			};
		})
		.sort((a, b) => b.mean - a.mean || b.median - a.median);
	console.log("web configs by mean score:", ranked);
	const best = ranked[0];
	console.log("best web config by mean score:", best);
	console.log(`web tavily isolation misses: ${webTavilyMisses.length}`);
	mkdirSync(OUT_DIR, { recursive: true });
	writeFileSync(
		resolve(OUT_DIR, `web-${new Date().toISOString().replace(/[:.]/g, "-")}.json`),
		JSON.stringify(
			{
				configs: webConfigs,
				rows,
				repeats,
				tavilyMisses: webTavilyMisses,
				note: "n=1 per config by default; directional only, does not exercise the production validator",
			},
			null,
			2,
		),
	);
}

const mode = arg("mode") ?? "all";
if (mode === "context" || mode === "all") await runContextEval();
if (mode === "web" || mode === "all") await runWebEval();
