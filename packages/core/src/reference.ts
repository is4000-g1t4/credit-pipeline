// Application references: APP-<year>-<6 base32> (SPEC FR-1.6).
import { randomBytes } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateReference(year: number): string {
	if (!Number.isInteger(year) || year < 2000 || year > 2100) {
		throw new RangeError(`year must be an integer in 2000–2100, got ${year}`);
	}
	const bytes = randomBytes(6);
	let suffix = "";
	for (const b of bytes) suffix += ALPHABET[b % 32];
	return `APP-${year}-${suffix}`;
}

export function validateReference(ref: string): boolean {
	return /^APP-\d{4}-[A-Z2-7]{6}$/.test(ref);
}
