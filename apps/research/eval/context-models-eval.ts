// Context-analyst model comparison eval: the production context agent + real
// context tools + production validator, run across the same 30 cases for each
// configured model. Models run in parallel per case; cases run through a
// small pool. Eval-owned applications only (`fixture_key = eval-cm-*`).
//
//   pnpm --filter @credit/research eval:context-models -- --trials=3 --max-spend=60
//   pnpm --filter @credit/research eval:context-models -- --models=deepseek/deepseek-v4.1-flash-1017
//
// The 30 cases are 3 demo personas across 10-12 as-of windows each. Windows
// change the deterministic candidate set (round-trip, cash share, returned
// payment, declared-vs-observed, concentration, insufficient data), so the
// suite measures tuple selection, restraint, data-gap coverage, and narrative
// quality without inventing new customer data.
import { readFileSync } from "node:fs";
import { createDb } from "@credit/db/applications";
import OpenAI from "openai";
import { OPENROUTER_BASE_URL } from "../src/agent.js";
import { createRealContextRunner } from "../src/context-agent.js";
import { getObservability } from "../src/observability.js";
import {
	validateContextOutput,
	CONTEXT_PROMPT_VERSION,
	CONTEXT_VALIDATOR_VERSION,
	type ContextValidationResult,
} from "../src/context-validator.js";
import { loadEnv, type AllowedModel, type ResearchEnv } from "../src/env.js";
import { personas, type PersonaName } from "./fixtures.js";
import { arg, mean, p95, wilson, writeResults } from "./lib.js";

interface ModelConfig {
	id: string;
	label: string;
	inputPerM: number;
	outputPerM: number;
}

// OpenRouter list prices at run time (USD per 1M tokens).
const MODELS: ModelConfig[] = [
	{ id: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol", inputPerM: 2, outputPerM: 10 },
	{ id: "anthropic/claude-opus-5.5", label: "Claude Opus 5.5", inputPerM: 4, outputPerM: 20 },
	{
		id: "deepseek/deepseek-v4.1-flash-1017",
		label: "DeepSeek V4.1 Flash 1017",
		inputPerM: 0.3,
		outputPerM: 1.2,
	},
	{ id: "meta/muse-wonder", label: "Meta Muse Wonder", inputPerM: 4, outputPerM: 20 },
	{ id: "google/gemini-4-argon", label: "Gemini 4 Argon", inputPerM: 2, outputPerM: 10 },
	{ id: "openai/gpt-6.1-terra", label: "GPT-6.1 Terra", inputPerM: 1, outputPerM: 5 },
];

interface CaseDef {
	name: string;
	persona: PersonaName;
	asOf: string;
	expected: string[];
	requiresDataGap?: boolean;
}

// Dataset lives in context-models-cases.json (the 30 cases this run used).
const CASE_DOC = JSON.parse(
	readFileSync(new URL("./context-models-cases.json", import.meta.url), "utf8"),
) as {
	cases: Array<{
		id: string;
		persona: PersonaName;
		asOf: string;
		expectedTypes: string[];
		requiresDataGap?: boolean;
	}>;
};
const CASES: CaseDef[] = CASE_DOC.cases.map((c) => ({
	name: c.id,
	persona: c.persona,
	asOf: c.asOf,
	expected: c.expectedTypes,
	requiresDataGap: c.requiresDataGap ?? false,
}));

interface SeededCase extends CaseDef {
	applicationId: string;
	caseFacts: Record<string, unknown>;
	keywords: string[];
}

interface TrialRow {
	model: string;
	modelLabel: string;
	case: string;
	persona: PersonaName;
	asOf: string;
	trial: number;
	ok: boolean;
	firstPass: boolean;
	repaired: boolean;
	signals: number;
	signalTypes: string[];
	candidates: number;
	coverage: number;
	expectedTypesOk: boolean;
	missingExpectedTypes: string[];
	dropped: number;
	droppedSignals: number;
	droppedNarrative: number;
	dropReasons: string[];
	dataGaps: string[];
	limitations: string[];
	claims: number;
	keywordHits: number;
	gapOk: boolean;
	pass: boolean;
	toolCalls: number;
	toolFailures: number;
	modelBudgetExceeded: boolean;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	latencyMs: number;
	issues: string[];
	error: string | null;
	output: unknown;
	firstOutput?: unknown;
}

function keywordHits(text: string, keywords: string[]): number {
	const lower = text.toLowerCase();
	return keywords.filter((keyword) => lower.includes(keyword.toLowerCase())).length;
}

async function seedCase(
	sql: ReturnType<typeof createDb>["sql"],
	def: CaseDef,
): Promise<SeededCase> {
	const p = personas[def.persona];
	const [profile] = (await sql`
		SELECT user_id, identity, business
		FROM customer_profiles
		WHERE identity->>'email' = ${p.email}
		LIMIT 1
	`) as unknown as Array<Record<string, unknown>>;
	if (!profile) throw new Error(`missing customer profile for ${def.persona}`);
	const userId = profile.user_id as string;
	const fixtureKey = `eval-cm-${def.name}`;
	const reference = `EVAL-CM-${def.name.toUpperCase()}`.slice(0, 60);
	// Reruns replace the eval-owned row; dependent rows never exist for these
	// applications because the eval only performs read-only context calls.
	await sql`DELETE FROM applications WHERE fixture_key = ${fixtureKey}`;
	const identity = profile.identity ?? {};
	const business = profile.business ?? null;
	const submittedAt = `${def.asOf}T00:00:00Z`;
	const [row] = (await sql`
		INSERT INTO applications
			(reference, applicant_user_id, type, product, status, amount_cents, term_months,
			 purpose, identity, financial, business, consents, ai_research_consent,
			 document_processing_consent, context_analysis_consent, submitted_at, fixture_key)
		VALUES
			(${reference}, ${userId}, ${p.type}::application_type,
			 ${p.product}::application_product, 'pending_review',
			 ${p.amountCents}, ${p.termMonths}, 'context model eval',
			 ${JSON.stringify(identity)}::jsonb, ${JSON.stringify(p.financial)}::jsonb,
			 ${JSON.stringify(business)}::jsonb, ${JSON.stringify([true, true, true])}::jsonb,
			 true, true, true, ${submittedAt}::timestamptz, ${fixtureKey})
		RETURNING id, reference, type, product, amount_cents, term_months, identity, business,
		          financial, status, submitted_at
	`) as unknown as Array<Record<string, unknown>>;
	const insertedIdentity = (row.identity ?? {}) as Record<string, unknown>;
	const insertedBusiness = (row.business ?? null) as Record<string, unknown> | null;
	const insertedAt = new Date(row.submitted_at as string);
	return {
		...def,
		applicationId: row.id as string,
		keywords: p.keywords,
		caseFacts: {
			applicationId: row.id,
			reference: row.reference,
			type: row.type,
			product: row.product,
			amountCents: row.amount_cents,
			termMonths: row.term_months,
			submittedAt: insertedAt.toISOString(),
			asOf: insertedAt.toISOString(),
			applicantName: insertedIdentity.fullName ?? "",
			companyName: insertedBusiness?.companyName ?? null,
			registrationNumber: insertedBusiness?.registrationNumber ?? null,
			industry: insertedBusiness?.industry ?? null,
			yearsTrading: insertedBusiness?.yearsTrading ?? null,
			city: insertedIdentity.city ?? null,
			status: row.status,
		},
	};
}

async function runTrial(
	c: SeededCase,
	model: ModelConfig,
	trial: number,
	baseEnv: ResearchEnv,
	spend: { usd: number; cap: number },
): Promise<TrialRow> {
	const started = Date.now();
	if (spend.usd >= spend.cap) {
		return {
			model: model.id,
			modelLabel: model.label,
			case: c.name,
			persona: c.persona,
			asOf: c.asOf,
			trial,
			ok: false,
			firstPass: false,
			repaired: false,
			signals: 0,
			signalTypes: [],
			candidates: 0,
			coverage: 0,
			expectedTypesOk: false,
			missingExpectedTypes: c.expected,
			dropped: 0,
			droppedSignals: 0,
			droppedNarrative: 0,
			dropReasons: [],
			dataGaps: [],
			limitations: [],
			claims: 0,
			keywordHits: 0,
			gapOk: false,
			pass: false,
			toolCalls: 0,
			toolFailures: 0,
			modelBudgetExceeded: false,
			inputTokens: 0,
			outputTokens: 0,
			costUsd: 0,
			latencyMs: 0,
			issues: [],
			error: "skipped: spend cap reached",
			output: null,
		};
	}
	const env: ResearchEnv = { ...baseEnv, contextModel: model.id as AllowedModel };
	const observability = getObservability();
	const runner = createRealContextRunner({ env, openai });
	let usage = { inputTokens: 0, outputTokens: 0, toolCalls: 0 };
	let candidates = 0;
	let toolFailures = 0;
	let modelBudgetExceeded = false;
	try {
		const raw = await runner.runContext({
			applicationId: c.applicationId,
			caseFacts: c.caseFacts,
			asOfDate: c.asOf,
			externalSummary: null,
			signal: AbortSignal.timeout(env.contextTimeoutMs),
			runId: `context-cm:${c.name}:${model.id}:${trial}:${Date.now()}`,
			observability,
		});
		usage = raw.usage;
		candidates = raw.snapshots.length;
		toolFailures = raw.toolFailures.length;
		modelBudgetExceeded = raw.modelBudgetExceeded;
		const validate = (output: unknown): ContextValidationResult =>
			validateContextOutput({
				output,
				snapshots: raw.snapshots,
				seenEvidence: raw.seenEvidence,
				asOfDate: c.asOf,
				historyMonths: env.contextHistoryMonths,
			});
		let validation = validate(raw.output);
		const firstValidation = validation;
		let repaired = false;
		let firstOutput: unknown;
		let finalOutput = raw.output;
		if (!validation.ok) {
			repaired = true;
			firstOutput = raw.output;
			const fixed = await runner.repairContext({
				applicationId: c.applicationId,
				caseFacts: c.caseFacts,
				asOfDate: c.asOf,
				externalSummary: null,
				signal: AbortSignal.timeout(env.contextTimeoutMs),
				previous: raw.output,
				issues: validation.issues,
				snapshots: raw.snapshots,
				seenEvidence: raw.seenEvidence,
			});
			usage = {
				inputTokens: usage.inputTokens + fixed.usage.inputTokens,
				outputTokens: usage.outputTokens + fixed.usage.outputTokens,
				toolCalls: usage.toolCalls + fixed.usage.toolCalls,
			};
			finalOutput = fixed.output;
			validation = validate(fixed.output);
		}
		const coverage = candidates === 0 ? 1 : validation.signals.length / candidates;
		const droppedSignals = validation.dropped.filter((drop) => drop.kind === "signal").length;
		const signalTypes = validation.signals.map((signal) => signal.type);
		const gapsText = [...validation.dataGaps, ...validation.limitations].join(" ");
		const hits = keywordHits(gapsText, c.keywords);
		const missingExpectedTypes = c.expected.filter((type) => !signalTypes.includes(type));
		const expectedTypesOk = missingExpectedTypes.length === 0;
		const gapOk = !c.requiresDataGap || validation.dataGaps.length > 0 || hits > 0;
		const costUsd =
			(usage.inputTokens / 1_000_000) * model.inputPerM +
			(usage.outputTokens / 1_000_000) * model.outputPerM;
		spend.usd += costUsd;
		const pass =
			validation.ok &&
			candidates > 0 &&
			coverage === 1 &&
			droppedSignals === 0 &&
			expectedTypesOk &&
			gapOk &&
			toolFailures === 0 &&
			!modelBudgetExceeded;
		return {
			model: model.id,
			modelLabel: model.label,
			case: c.name,
			persona: c.persona,
			asOf: c.asOf,
			trial,
			ok: validation.ok,
			firstPass: firstValidation.ok,
			repaired,
			signals: validation.signals.length,
			signalTypes,
			candidates,
			coverage,
			expectedTypesOk,
			missingExpectedTypes,
			dropped: validation.dropped.length,
			droppedSignals,
			droppedNarrative: validation.dropped.length - droppedSignals,
			dropReasons: validation.dropped.map((drop) => drop.reason),
			dataGaps: validation.dataGaps,
			limitations: validation.limitations,
			claims: validation.claims.length,
			keywordHits: hits,
			gapOk,
			pass,
			toolCalls: usage.toolCalls,
			toolFailures,
			modelBudgetExceeded,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			costUsd,
			latencyMs: Date.now() - started,
			issues: validation.issues,
			error: null,
			output: finalOutput,
			...(firstOutput !== undefined ? { firstOutput } : {}),
		};
	} catch (err) {
		const costUsd =
			(usage.inputTokens / 1_000_000) * model.inputPerM +
			(usage.outputTokens / 1_000_000) * model.outputPerM;
		spend.usd += costUsd;
		return {
			model: model.id,
			modelLabel: model.label,
			case: c.name,
			persona: c.persona,
			asOf: c.asOf,
			trial,
			ok: false,
			firstPass: false,
			repaired: false,
			signals: 0,
			signalTypes: [],
			candidates,
			coverage: 0,
			expectedTypesOk: false,
			missingExpectedTypes: c.expected,
			dropped: 0,
			droppedSignals: 0,
			droppedNarrative: 0,
			dropReasons: [],
			dataGaps: [],
			limitations: [],
			claims: 0,
			keywordHits: 0,
			gapOk: false,
			pass: false,
			toolCalls: usage.toolCalls,
			toolFailures,
			modelBudgetExceeded,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			costUsd,
			latencyMs: Date.now() - started,
			issues: [],
			error: err instanceof Error ? err.message : String(err),
			output: null,
		};
	}
}

function summarize(rows: TrialRow[], trials: number) {
	const byCase = new Map<string, TrialRow[]>();
	for (const row of rows) {
		const list = byCase.get(row.case) ?? [];
		list.push(row);
		byCase.set(row.case, list);
	}
	const completedCases = [...byCase.values()].filter(
		(list) => list.filter((r) => r.error !== "skipped: spend cap reached").length === trials,
	);
	const pass3 = completedCases.filter(
		(list) =>
			list.length === trials && list.every((r) => r.pass),
	).length;
	const sparse = rows.filter((r) => r.persona === "sparse");
	const errors = rows.filter((r) => r.error !== null && r.error !== "skipped: spend cap reached").length;
	const skipped = rows.filter((r) => r.error === "skipped: spend cap reached").length;
	const ratios = rows.map((r) => Number(r.expectedTypesOk));
	return {
		model: rows[0]?.model ?? "",
		modelLabel: rows[0]?.modelLabel ?? "",
		runs: rows.length,
		errors,
		skipped,
		passAt1: rows.filter((r) => r.pass).length / Math.max(1, rows.length),
		passAt3Cases: pass3 / Math.max(1, completedCases.length),
		passAt3CaseCount: pass3,
		caseCount: completedCases.length,
		firstPassRate: rows.filter((r) => r.firstPass).length / Math.max(1, rows.length),
		repairRate: rows.filter((r) => r.repaired).length / Math.max(1, rows.length),
		meanCoverage: mean(rows.map((r) => r.coverage)),
		expectedTypeRate: mean(ratios),
		dataGapRateSparse: sparse.length
			? sparse.filter((r) => r.gapOk).length / sparse.length
			: 0,
		totalDroppedSignals: rows.reduce((n, r) => n + r.droppedSignals, 0),
		totalDroppedNarrative: rows.reduce((n, r) => n + r.droppedNarrative, 0),
		toolFailures: rows.reduce((n, r) => n + r.toolFailures, 0),
		modelBudgetExceeded: rows.filter((r) => r.modelBudgetExceeded).length,
		meanLatencyMs: mean(rows.map((r) => r.latencyMs)),
		p95LatencyMs: p95(rows.map((r) => r.latencyMs)),
		totalCostUsd: rows.reduce((n, r) => n + r.costUsd, 0),
		meanCostUsd: mean(rows.map((r) => r.costUsd)),
		wilsonPassAt1: wilson(rows.filter((r) => r.pass).length, rows.length),
		wilsonPassAt3: wilson(pass3, Math.max(1, completedCases.length)),
	};
}

const trials = Math.max(1, Number(arg("trials", "3")) || 3);
const maxSpend = Math.max(1, Number(arg("max-spend", "60")) || 60);
const concurrency = Math.max(1, Number(arg("concurrency", "3")) || 3);
const onlyModels = arg("models", "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const selectedModels = onlyModels.length
	? MODELS.filter((m) => onlyModels.includes(m.id))
	: MODELS;
const onlyCases = arg("case", "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const selectedCases = onlyCases.length
	? CASES.filter((c) => onlyCases.includes(c.name))
	: CASES;
if (selectedModels.length === 0) {
	console.error(`no matching models; available: ${MODELS.map((m) => m.id).join(", ")}`);
	process.exit(1);
}
const env = loadEnv();
const openai = new OpenAI({
	apiKey: env.openrouterApiKey || "unconfigured",
	baseURL: OPENROUTER_BASE_URL,
});
const { sql } = createDb(process.env.APPLICATIONS_DATABASE_URL as string);
const seeded: SeededCase[] = [];
try {
	await sql`DELETE FROM applications WHERE fixture_key LIKE 'eval-cm-%'`;
	for (const def of selectedCases) seeded.push(await seedCase(sql, def));
	console.log(
		`context-models eval: ${selectedModels.length} models x ${seeded.length} cases x ${trials} trials, max spend $${maxSpend}, concurrency ${concurrency}`,
	);
	console.log(
		`prompt=${CONTEXT_PROMPT_VERSION} validator=${CONTEXT_VALIDATOR_VERSION} temp=${env.contextTemperature} tokens=${env.contextMaxOutputTokens} turns=${env.contextMaxTurns} tools=${env.contextMaxToolCalls}`,
	);
	const spend = { usd: 0, cap: maxSpend };
	const allRows: TrialRow[] = [];
	const startedAll = Date.now();
	let nextCase = 0;
	const worker = async (): Promise<void> => {
		while (true) {
			const index = nextCase++;
			if (index >= seeded.length) return;
			const c = seeded[index]!;
			for (let t = 1; t <= trials; t++) {
				const rows = await Promise.all(
					selectedModels.map((model) => runTrial(c, model, t, env, spend)),
				);
				allRows.push(...rows);
				for (const r of rows) {
					const flag = r.pass ? "PASS" : "FAIL";
					const err = r.error ? ` err=${r.error.slice(0, 160)}` : "";
					console.log(
						`[${r.modelLabel}] ${r.case} ${t}/${trials} ${flag} sig=${r.signals}/${r.candidates} first=${r.firstPass} dropped=${r.dropped} tools=${r.toolCalls} $${r.costUsd.toFixed(4)} ${r.latencyMs}ms${err}`,
					);
				}
				console.log(
					`  ... spend $${spend.usd.toFixed(4)} / $${spend.cap}, elapsed ${Math.round((Date.now() - startedAll) / 1000)}s`,
				);
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(concurrency, seeded.length) }, () => worker()),
	);
	const models = selectedModels.map((model) => {
		const rows = allRows.filter((r) => r.model === model.id);
		return {
			model,
			status: rows.some((r) => r.error === "skipped: spend cap reached") ? "partial" : "ran",
			summary: summarize(rows, trials),
			rows,
		};
	});
	console.table(
		models.map((m) => ({
			model: m.model.label,
			passAt1: m.summary.passAt1.toFixed(3),
			passAt3: m.summary.passAt3Cases.toFixed(3),
			firstPass: m.summary.firstPassRate.toFixed(3),
			coverage: m.summary.meanCoverage.toFixed(3),
			expected: m.summary.expectedTypeRate.toFixed(3),
			gapSparse: m.summary.dataGapRateSparse.toFixed(3),
			droppedNarr: m.summary.totalDroppedNarrative,
			toolFail: m.summary.toolFailures,
			errors: m.summary.errors,
			meanSec: (m.summary.meanLatencyMs / 1000).toFixed(1),
			p95Sec: (m.summary.p95LatencyMs / 1000).toFixed(1),
			cost: `$${m.summary.totalCostUsd.toFixed(3)}`,
		})),
	);
	const file = writeResults("context-models", {
		meta: {
			promptVersion: CONTEXT_PROMPT_VERSION,
			validatorVersion: CONTEXT_VALIDATOR_VERSION,
			temperature: env.contextTemperature,
			maxOutputTokens: env.contextMaxOutputTokens,
			maxTurns: env.contextMaxTurns,
			maxToolCalls: env.contextMaxToolCalls,
			historyMonths: env.contextHistoryMonths,
			asOf: "per case (application submitted_at)",
			costBasis: "OpenRouter list price x token usage; not billed cost",
			trials,
			concurrency,
			maxSpendUsd: maxSpend,
			cases: seeded.map((c) => ({
				name: c.name,
				persona: c.persona,
				asOf: c.asOf,
				applicationId: c.applicationId,
				expected: c.expected,
			})),
		},
		models,
	});
	console.log(`\nwrote ${file}`);
} finally {
	try {
		await sql`DELETE FROM applications WHERE fixture_key LIKE 'eval-cm-%'`;
	} finally {
		await sql.end();
	}
	await getObservability().shutdown?.();
}
