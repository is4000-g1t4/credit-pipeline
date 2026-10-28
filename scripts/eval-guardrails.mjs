#!/usr/bin/env node
// Eval cost/latency/pass guardrails (P2). Reads the newest result JSON per
// feature and fails when a run regresses past the checked-in thresholds.
// Missing results are skipped: this is a post-eval gate, not a cold-start test.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FEATURES = [
	{
		name: "brief",
		dir: "apps/research/eval/results",
		prefix: "brief-",
		minRuns: 40,
		minPassAt1: 0.9,
		maxMeanLatencyMs: 30_000,
		maxP95LatencyMs: 45_000,
		maxTotalCostUsd: 2.5,
	},
	{
		name: "context-models",
		dir: "apps/research/eval/results",
		prefix: "context-models-",
		minRuns: 150,
		minPassAt1: 0.95,
		maxMeanLatencyMs: 30_000,
		maxP95LatencyMs: 45_000,
		maxTotalCostUsd: 6,
	},
	{
		name: "answers",
		dir: "apps/policy/eval/results",
		prefix: "answers-",
		minRuns: 90,
		minPassAt1: 0.85,
		maxMeanLatencyMs: 20_000,
		maxP95LatencyMs: 30_000,
		maxTotalCostUsd: 5,
	},
	{
		name: "integrity",
		dir: "apps/applications/eval/results",
		prefix: "integrity-",
		minRuns: 60,
		minPassAt1: 0.95,
		maxMeanLatencyMs: 20_000,
		maxP95LatencyMs: 30_000,
		maxTotalCostUsd: 3,
	},
	{
		name: "policy-exception",
		dir: "apps/applications/eval/results",
		prefix: "policy-exception-",
		minRuns: 60,
		minPassAt1: 0.9,
		maxMeanLatencyMs: 30_000,
		maxP95LatencyMs: 45_000,
		maxTotalCostUsd: 5,
	},
	{
		name: "memo-live",
		dir: "apps/applications/eval/results",
		prefix: "memo-live-",
		minRuns: 60,
		minPassAt1: 0.8,
		maxMeanLatencyMs: 60_000,
		maxP95LatencyMs: 90_000,
		maxTotalCostUsd: 8,
	},
	{
		name: "case-review",
		dir: "apps/policy/eval/results",
		prefix: "case-review-",
		minRuns: 60,
		minPassAt1: 0.9,
		maxMeanLatencyMs: 30_000,
		maxP95LatencyMs: 45_000,
		maxTotalCostUsd: 6,
	},
];

function latest(dir, prefix, minRuns) {
	if (!existsSync(dir)) return null;
	const files = readdirSync(dir)
		.filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
		.sort()
		.reverse();
	for (const name of files) {
		const file = join(dir, name);
		try {
			const payload = JSON.parse(readFileSync(file, "utf8"));
			const trials = payload.meta?.trials ?? payload.trials ?? 1;
			const runs =
				payload.rows?.length ??
				payload.trials?.length ??
				(payload.models ?? []).reduce((n, m) => n + (m.rows?.length ?? 0), 0);
			if (trials >= 2 && runs >= minRuns && summariesOf(payload).length > 0) return file;
		} catch {
			// Ignore a half-written or malformed result.
		}
	}
	return null;
}

/** Collect leaf summary objects (they carry passAt1/passAllTrials). Nested
 * model summaries are leaves; aggregate envelopes without a pass metric are
 * traversed so cost is never double-counted. */
function summariesOf(node, out = []) {
	if (Array.isArray(node)) {
		for (const item of node) summariesOf(item, out);
		return out;
	}
	if (node === null || typeof node !== "object") return out;
	const pass =
		typeof node.passAt1 === "number"
			? node.passAt1
			: typeof node.passAllTrials === "number"
				? node.passAllTrials
				: null;
	if (pass !== null) {
		out.push(node);
		return out;
	}
	for (const value of Object.values(node)) summariesOf(value, out);
	return out;
}

const violations = [];
const skipped = [];
console.log("eval guardrails");
console.log("feature            pass@1   mean ms   p95 ms   cost USD  result");
for (const feature of FEATURES) {
	const file = latest(feature.dir, feature.prefix, feature.minRuns);
	if (!file) {
		skipped.push(feature.name);
		console.log(`${feature.name.padEnd(18)} (no result)`);
		continue;
	}
	const payload = JSON.parse(readFileSync(file, "utf8"));
	const summaries = summariesOf(payload);
	if (summaries.length === 0) {
		skipped.push(`${feature.name} (no pass metric)`);
		console.log(`${feature.name.padEnd(18)} (unrecognised result shape)`);
		continue;
	}
	const passAt1 = Math.min(
		...summaries.map((s) => (typeof s.passAt1 === "number" ? s.passAt1 : s.passAllTrials)),
	);
	const meanMs = Math.max(...summaries.map((s) => Number(s.meanLatencyMs ?? 0)));
	const p95Ms = Math.max(...summaries.map((s) => Number(s.p95LatencyMs ?? 0)));
	const cost = summaries.reduce((n, s) => n + Number(s.totalCostUsd ?? 0), 0);
	console.log(
		`${feature.name.padEnd(18)} ${passAt1.toFixed(3)}   ${String(Math.round(meanMs)).padStart(7)}   ${String(Math.round(p95Ms)).padStart(6)}   ${cost.toFixed(3).padStart(8)}  ${file}`,
	);
	if (passAt1 < feature.minPassAt1) {
		violations.push(`${feature.name}: pass@1 ${passAt1.toFixed(3)} < ${feature.minPassAt1}`);
	}
	if (meanMs > feature.maxMeanLatencyMs) {
		violations.push(
			`${feature.name}: mean latency ${Math.round(meanMs)}ms > ${feature.maxMeanLatencyMs}ms`,
		);
	}
	if (p95Ms > feature.maxP95LatencyMs) {
		violations.push(
			`${feature.name}: p95 latency ${Math.round(p95Ms)}ms > ${feature.maxP95LatencyMs}ms`,
		);
	}
	if (cost > feature.maxTotalCostUsd) {
		violations.push(`${feature.name}: cost $${cost.toFixed(3)} > $${feature.maxTotalCostUsd}`);
	}
}
if (skipped.length > 0) {
	console.log(`skipped (no result file): ${skipped.join(", ")}`);
}
if (violations.length > 0) {
	console.error("\nFAIL");
	for (const violation of violations) console.error(`- ${violation}`);
	process.exit(1);
}
console.log("\nOK");
