/** Shared scalar/stat helpers for the policy evals (answer + embedding). */

export function evalArg(name: string, fallback: string): string {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
}

export function mean(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

export function p95(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

function wilsonCore(p: number, n: number): { lo: number; hi: number } {
	const z = 1.96;
	if (n === 0) return { lo: 0, hi: 0 };
	const d = 1 + (z * z) / n;
	const c = p + (z * z) / (2 * n);
	const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
	return { lo: Math.max(0, (c - m) / d), hi: Math.min(1, (c + m) / d) };
}

/** Wilson 95% interval, answer-eval shape ({low, high}). */
export function wilson(passes: number, total: number): { low: number; high: number } {
	const { lo, hi } = wilsonCore(total === 0 ? 0 : passes / total, total);
	return { low: lo, high: hi };
}

/** Wilson 95% interval, embedding-eval shape ({lo, hi}). */
export function wilsonCI(p: number, n: number): { lo: number; hi: number } {
	return wilsonCore(p, n);
}
