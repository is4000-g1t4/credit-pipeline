// Canonical JSON + hashing: key-order independence, integer-as-string,
// hash stability. Snapshots carry versions and input hashes, no mutation.
import { describe, expect, it } from "vitest";
import {
	buildCheckOnlySnapshot,
	buildCreditSnapshot,
	canonicalJson,
	hashCanonical,
	makeReason,
	sha256Hex,
} from "../src/index.js";

describe("canonicalJson", () => {
	it("is independent of key insertion order, nested", () => {
		const a = { z: 1, a: { d: 4, b: 2 }, m: [3, { y: 1, x: 2 }] };
		const b = { m: [3, { x: 2, y: 1 }], a: { b: 2, d: 4 }, z: 1 };
		expect(canonicalJson(a)).toBe(canonicalJson(b));
		expect(canonicalJson(a)).toBe('{"a":{"b":"2","d":"4"},"m":["3",{"x":"2","y":"1"}],"z":"1"}');
	});

	it("renders integers as strings, keeps floats numeric", () => {
		expect(
			canonicalJson({
				int: 5,
				neg: -3,
				float: 0.5,
				str: "7",
				big: 9007199254740993n,
			}),
		).toBe('{"big":"9007199254740993","float":0.5,"int":"5","neg":"-3","str":"7"}');
	});

	it("hash is stable and matches raw sha256", () => {
		const v = { amountCents: 1200000, score: 777 };
		expect(hashCanonical(v)).toBe(sha256Hex(canonicalJson(v)));
		expect(hashCanonical(v)).toBe(hashCanonical({ score: 777, amountCents: 1200000 }));
		expect(hashCanonical(v)).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("snapshots", () => {
	it("credit snapshot carries versions, hash, and actor", () => {
		const inputs = { score: 777, amountCents: 1200000 };
		const s = buildCreditSnapshot({
			inputs,
			score: 777,
			grade: "A",
			factors: [],
			rateBps: 650,
			monthlyPaymentCents: 28458,
			reasons: [],
			actor: "system",
			decidedAt: "2026-10-19T12:00:00Z",
		});
		expect(s.kind).toBe("credit");
		expect(s.scorecardVersion).toBe("scorecard-v1");
		expect(s.policyVersion).toBe("policy-v1.0");
		expect(s.inputHash).toBe(hashCanonical(inputs));
	});

	it("input hash ignores decidedAt", () => {
		const inputs = { score: 777, amountCents: 1200000 };
		const base = {
			inputs,
			score: 777,
			grade: "A" as const,
			factors: [],
			rateBps: 650,
			monthlyPaymentCents: 28458,
			reasons: [],
			actor: "system",
		};
		const a = buildCreditSnapshot({ ...base, decidedAt: "2026-10-19T12:00:00Z" });
		const b = buildCreditSnapshot({ ...base, decidedAt: "2027-05-01T00:00:00Z" });
		expect(a.inputHash).toBe(b.inputHash);
		expect(a.inputHash).toBe(hashCanonical(inputs));
	});

	it("check-only snapshot carries checks + hash", () => {
		const s = buildCheckOnlySnapshot({
			inputs: { nationalId: "X" },
			checks: [
				{ type: "identity", status: "failed" },
				{ type: "sanctions", status: "passed" },
			],
			reasons: [makeReason("IDENTITY_FAILED")],
			actor: "system",
			decidedAt: "2026-10-19T12:00:00Z",
		});
		expect(s.kind).toBe("check_only");
		expect(s.inputHash).toMatch(/^[0-9a-f]{64}$/);
	});
});
