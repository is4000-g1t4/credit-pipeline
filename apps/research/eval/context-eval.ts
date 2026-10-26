// Context-analyst quality eval: real agent + real context tools + production
// validator, against the three seeded demo personas.
//
//   pnpm --filter @credit/research eval:context
//   pnpm --filter @credit/research eval:context -- --trials=1 --case=sparse
//
// Requires postgres + seeded demo fixtures + applications/loans services.
// The runner is the production runner; the validator is the production
// validator. Foreign failures (model/tool/network) are recorded per trial.
import { createDb } from "@credit/db/applications";
import OpenAI from "openai";
import { OPENROUTER_BASE_URL, projectCostUsd } from "../src/agent.js";
import { createRealContextRunner } from "../src/context-agent.js";
import { getObservability } from "../src/observability.js";
import {
	validateContextOutput,
	CONTEXT_PROMPT_VERSION,
	CONTEXT_VALIDATOR_VERSION,
	type ContextValidationResult,
} from "../src/context-validator.js";
import { loadEnv } from "../src/env.js";
import { ensureCase, type ContextCase, type PersonaName } from "./fixtures.js";
import { arg, mean, p95, wilson, writeResults } from "./lib.js";

const env = loadEnv();
const openai = new OpenAI({
	apiKey: env.openrouterApiKey || "unconfigured",
	baseURL: OPENROUTER_BASE_URL,
});

const EXPECTED: Record<
	PersonaName,
	{
		minSignals: number;
		requiredTypes: string[];
		requiresDataGap: boolean;
	}
> = {
	breadtalk: {
		minSignals: 3,
		requiredTypes: ["round_trip", "cash_deposit_share", "returned_payment"],
		requiresDataGap: false,
	},
	sparse: { minSignals: 1, requiredTypes: ["insufficient_data"], requiresDataGap: true },
	alex: { minSignals: 1, requiredTypes: ["revenue_concentration"], requiresDataGap: false },
};

interface TrialRow {
	case: string;
	ok: boolean;
	firstPass: boolean;
	repaired: boolean;
	signals: number;
	signalTypes: string[];
	candidates: number;
	coverage: number;
	dropped: number;
	droppedSignals: number;
	dropReasons: string[];
	dataGaps: number;
	limitations: number;
	keywordHits: number;
	pass: boolean;
	toolCalls: number;
	toolFailures: number;
	modelBudgetExceeded: boolean;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	latencyMs: number;
	error: string | null;
}

function keywordHits(text: string, keywords: string[]): number {
	const lower = text.toLowerCase();
	return keywords.filter((keyword) => lower.includes(keyword.toLowerCase())).length;
}

async function runTrial(c: ContextCase, persona: PersonaName, trial: number): Promise<TrialRow> {
	const started = Date.now();
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
			asOfDate: c.asOfDate,
			externalSummary: null,
			signal: AbortSignal.timeout(env.contextTimeoutMs),
			runId: `context-eval:${c.name}:${persona}:${trial}`,
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
				asOfDate: c.asOfDate,
				historyMonths: env.contextHistoryMonths,
			});
		let validation = validate(raw.output);
		let repaired = false;
		if (!validation.ok) {
			repaired = true;
			const fixed = await runner.repairContext({
				applicationId: c.applicationId,
				caseFacts: c.caseFacts,
				asOfDate: c.asOfDate,
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
			validation = validate(fixed.output);
		}
		const coverage = candidates === 0 ? 1 : validation.signals.length / candidates;
		const droppedSignals = validation.dropped.filter((drop) => drop.kind === "signal").length;
		const signalTypes = validation.signals.map((signal) => signal.type);
		const gapsText = [...validation.dataGaps, ...validation.limitations].join(" ");
		const hits = keywordHits(gapsText, c.keywords);
		const expected = EXPECTED[persona];
		const signalOk =
			validation.signals.length >= expected.minSignals &&
			expected.requiredTypes.every((type) => signalTypes.includes(type));
		const gapOk = !expected.requiresDataGap || validation.dataGaps.length > 0 || hits > 0;
		const pass =
			validation.ok &&
			candidates > 0 &&
			coverage === 1 &&
			droppedSignals === 0 &&
			signalOk &&
			gapOk &&
			toolFailures === 0 &&
			!modelBudgetExceeded;
		return {
			case: c.name,
			ok: validation.ok,
			firstPass: validation.ok && !repaired,
			repaired,
			signals: validation.signals.length,
			signalTypes,
			candidates,
			coverage,
			dropped: validation.dropped.length,
			droppedSignals,
			dropReasons: validation.dropped.map((drop) => drop.reason),
			dataGaps: validation.dataGaps.length,
			limitations: validation.limitations.length,
			keywordHits: hits,
			pass,
			toolCalls: usage.toolCalls,
			toolFailures,
			modelBudgetExceeded,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			costUsd: projectCostUsd(usage.inputTokens, usage.outputTokens),
			latencyMs: Date.now() - started,
			error: null,
		};
	} catch (err) {
		return {
			case: c.name,
			ok: false,
			firstPass: false,
			repaired: false,
			signals: 0,
			signalTypes: [],
			candidates,
			coverage: 0,
			dropped: 0,
			droppedSignals: 0,
			dropReasons: [],
			dataGaps: 0,
			limitations: 0,
			keywordHits: 0,
			pass: false,
			toolCalls: usage.toolCalls,
			toolFailures,
			modelBudgetExceeded,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			costUsd: projectCostUsd(usage.inputTokens, usage.outputTokens),
			latencyMs: Date.now() - started,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

const trials = Math.max(1, Number(arg("trials", "3")) || 3);
const only = arg("case", "");
const personaOrder: PersonaName[] = ["breadtalk", "sparse", "alex"];
const selected = personaOrder.filter((name) => !only || name === only);
const { sql } = createDb(process.env.APPLICATIONS_DATABASE_URL as string);
const cases: ContextCase[] = [];
try {
	// Eval-owned rows only; never a live demo application.
	await sql`DELETE FROM applications WHERE fixture_key LIKE 'eval-%'`;
	for (const persona of selected) cases.push(await ensureCase(sql, persona));
} catch (err) {
	console.error("context eval setup failed", err);
	await sql.end();
	process.exitCode = 1;
	process.exit();
}

console.log(
	`context eval: ${cases.length} cases x ${trials} trials, model=${env.contextModel}, temp=${env.contextTemperature}, tokens=${env.contextMaxOutputTokens}, turns=${env.contextMaxTurns}, tools=${env.contextMaxToolCalls}`,
);
const rows: TrialRow[] = [];
try {
	for (const c of cases) {
		const persona = c.name as PersonaName;
		for (let t = 0; t < trials; t++) {
			console.log(`  ${c.name} trial ${t + 1}/${trials} ...`);
			rows.push(await runTrial(c, persona, t + 1));
		}
	}
} finally {
	try {
		for (const c of cases) {
			if (c.cleanup) {
				await sql`DELETE FROM applications WHERE id = ${c.applicationId}`;
			}
		}
	} finally {
		await sql.end();
	}
}

console.table(
	rows.map((r) => ({
		case: r.case,
		ok: r.ok,
		first: r.firstPass,
		repaired: r.repaired,
		signals: `${r.signals}/${r.candidates}`,
		types: r.signalTypes.join(","),
		coverage: r.coverage.toFixed(2),
		dropped: r.dropped,
		dropSignals: r.droppedSignals,
		gaps: r.dataGaps,
		keywords: r.keywordHits,
		pass: r.pass,
		tools: r.toolCalls,
		toolFail: r.toolFailures,
		ms: r.latencyMs,
		usd: r.costUsd.toFixed(4),
		err: r.error ?? "",
	})),
);
const byCase = new Map<string, TrialRow[]>();
for (const row of rows) {
	const list = byCase.get(row.case) ?? [];
	list.push(row);
	byCase.set(row.case, list);
}
const passCount = rows.filter((r) => r.pass).length;
const pass3 = [...byCase.values()].filter((list) => list.every((r) => r.pass)).length;
const latencies = rows.map((r) => r.latencyMs);
const totalCost = rows.reduce((n, r) => n + r.costUsd, 0);
console.log({
	cases: cases.length,
	trialsPerCase: trials,
	passAt1: `${passCount}/${rows.length} (${(passCount / rows.length).toFixed(3)})`,
	passAt3Cases: `${pass3}/${byCase.size} (${(pass3 / byCase.size).toFixed(3)})`,
	firstPassRate: `${rows.filter((r) => r.firstPass).length}/${rows.length}`,
	meanCoverage: mean(rows.map((r) => r.coverage)).toFixed(3),
	totalDropped: rows.reduce((n, r) => n + r.dropped, 0),
	meanLatencyMs: Math.round(mean(latencies)),
	p95LatencyMs: p95(latencies),
	totalCostUsd: totalCost.toFixed(4),
	wilsonPassAt3: wilson(pass3, byCase.size),
});
if (passCount < rows.length) {
	console.table(
		rows
			.filter((r) => !r.pass)
			.map((r) => ({
				case: r.case,
				ok: r.ok,
				first: r.firstPass,
				signals: `${r.signals}/${r.candidates}`,
				dropped: r.dropped,
				gaps: r.dataGaps,
				keywords: r.keywordHits,
				tools: r.toolCalls,
				err: r.error ?? "",
				reasons: r.dropReasons.join("; "),
			})),
	);
}
const file = writeResults("context", {
	meta: {
		model: env.contextModel,
		promptVersion: CONTEXT_PROMPT_VERSION,
		validatorVersion: CONTEXT_VALIDATOR_VERSION,
		temperature: env.contextTemperature,
		maxOutputTokens: env.contextMaxOutputTokens,
		maxTurns: env.contextMaxTurns,
		maxToolCalls: env.contextMaxToolCalls,
		historyMonths: env.contextHistoryMonths,
		asOf: "per case submitted_at",
		costBasis: "projected ceiling ($5/$10 per M tokens), not billed cost",
		trials,
	},
	summary: {
		passAt1: passCount / rows.length,
		passAt3Cases: pass3 / byCase.size,
		firstPassRate: rows.filter((r) => r.firstPass).length / rows.length,
		meanCoverage: mean(rows.map((r) => r.coverage)),
		totalDropped: rows.reduce((n, r) => n + r.dropped, 0),
		meanLatencyMs: mean(latencies),
		p95LatencyMs: p95(latencies),
		totalCostUsd: totalCost,
		wilsonPassAt3: wilson(pass3, byCase.size),
	},
	rows,
});
console.log(`\nwrote ${file}`);
await getObservability().shutdown?.();
