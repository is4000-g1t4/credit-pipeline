// Shared eval helpers: CLI args, small-sample stats, and result files.
// Keep this dependency-free; the eval harnesses own their runners and graders.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = path.join(HERE, "results");

export function arg(name: string, fallback: string): string {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
}

export function mean(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

export function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function p95(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}

export function wilson(passes: number, total: number): { low: number; high: number } {
	if (total === 0) return { low: 0, high: 0 };
	const z = 1.96;
	const p = passes / total;
	const denom = 1 + (z * z) / total;
	const centre = (p + (z * z) / (2 * total)) / denom;
	const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom;
	return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

export function writeResults(name: string, payload: unknown): string {
	mkdirSync(RESULTS_DIR, { recursive: true });
	const file = path.join(
		RESULTS_DIR,
		`${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
	);
	writeFileSync(file, JSON.stringify(payload, null, 2));
	return file;
}
