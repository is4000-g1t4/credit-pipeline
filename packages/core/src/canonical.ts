// Canonical JSON (sorted keys, integers as strings, no timestamps — callers
// must exclude timestamp fields) and sha256 hashing (SPEC FR-5.4, FR-10.6).
import { createHash } from "node:crypto";

function normalize(value: unknown): unknown {
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "number") {
		return Number.isInteger(value) ? value.toString() : value;
	}
	if (Array.isArray(value)) return value.map(normalize);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			out[key] = normalize((value as Record<string, unknown>)[key]);
		}
		return out;
	}
	return value;
}

/** Deterministic serialization: sorted keys; every integer rendered as a string. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(normalize(value));
}

export function sha256Hex(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Hash of the canonical form — the stable `input_hash` used by policy/snapshots. */
export function hashCanonical(value: unknown): string {
	return sha256Hex(canonicalJson(value));
}
