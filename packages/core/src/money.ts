// Integer-cents money helpers. All policy comparisons use BigInt math so
// exact-boundary behavior (0.35/0.50/1.0/1.5) never depends on floats.

function assertIntCents(name: string, value: number): void {
	if (!Number.isInteger(value)) {
		throw new RangeError(`${name} must be integer cents, got ${value}`);
	}
}

/** Round half up (non-negative and negative safe); no float drift for integers. */
export function roundHalfUp(x: number): number {
	if (!Number.isFinite(x)) throw new RangeError(`cannot round ${x}`);
	const sign = x < 0 ? -1 : 1;
	return sign * Math.floor(Math.abs(x) + 0.5);
}

/**
 * Exact half-up division for integer numerator/denominator (BigInt math,
 * so large values stay exact). Denominator must be non-zero.
 */
export function roundHalfUpDiv(numer: number, denom: number): number {
	assertIntCents("numer", numer);
	assertIntCents("denom", denom);
	if (denom === 0) throw new RangeError("division by zero");
	const n = BigInt(numer);
	const d = BigInt(denom);
	const q = n / d; // truncates toward zero
	const r = n % d;
	if (r === 0n) return Number(q);
	// Compare 2*|r| against |d|; round away from zero on exact halves.
	const twice = r * 2n * (r < 0n ? -1n : 1n);
	const absD = d < 0n ? -d : d;
	const bump = twice >= absD ? (n < 0n !== d < 0n ? -1n : 1n) : 0n;
	return Number(q + bump);
}

/**
 * DTI ≤ threshold ⇔ (debt + payment) * 100 ≤ pct * income, computed exactly.
 * @param thresholdPctX100 e.g. 3500 for 35%.
 */
export function dtiLte(
	debtCents: number,
	paymentCents: number,
	incomeCents: number,
	thresholdPctX100: number,
): boolean {
	for (const [name, v] of [
		["debtCents", debtCents],
		["paymentCents", paymentCents],
		["incomeCents", incomeCents],
		["thresholdPctX100", thresholdPctX100],
	] as const) {
		assertIntCents(name, v);
	}
	if (incomeCents <= 0 || thresholdPctX100 < 0) return false;
	const left = BigInt(debtCents + paymentCents) * 10000n;
	const right = BigInt(thresholdPctX100) * BigInt(incomeCents);
	return left <= right;
}

/**
 * DSCR ≥ ratio ⇔ fcf * 100 ≥ ratio * (payment + debtService), computed exactly.
 * @param ratioX100 e.g. 150 for 1.5.
 */
export function dscrGte(
	fcfCents: number,
	paymentCents: number,
	debtServiceCents: number,
	ratioX100: number,
): boolean {
	for (const [name, v] of [
		["fcfCents", fcfCents],
		["paymentCents", paymentCents],
		["debtServiceCents", debtServiceCents],
		["ratioX100", ratioX100],
	] as const) {
		assertIntCents(name, v);
	}
	if (ratioX100 < 0) return false;
	const left = BigInt(fcfCents) * 100n;
	const right = BigInt(ratioX100) * BigInt(paymentCents + debtServiceCents);
	return left >= right;
}
