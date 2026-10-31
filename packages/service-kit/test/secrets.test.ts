// assertProductionSecrets: enforced only in production; names the variable,
// never the value.
import { describe, expect, it } from "vitest";
import { assertProductionSecrets, findWeakSecrets } from "../src/secrets.js";

const strong = "k3j9x8v7b6n5m4q2w1e0r9t8y7u6i5o4p3a2s1d0";

describe("assertProductionSecrets", () => {
	it("is a no-op outside production", () => {
		for (const nodeEnv of [undefined, "development", "test"]) {
			expect(() =>
				assertProductionSecrets(
					{ INTERNAL_SECRET: "dev-internal-secret", X: undefined },
					{ nodeEnv },
				),
			).not.toThrow();
		}
	});

	it("accepts strong secrets in production", () => {
		expect(() =>
			assertProductionSecrets({ INTERNAL_SECRET: strong }, { nodeEnv: "production" }),
		).not.toThrow();
	});

	it("rejects missing, short, known-default and change-me secrets by name only", () => {
		const cases: Array<[string | undefined, RegExp]> = [
			[undefined, /A_SECRET is missing/],
			["", /A_SECRET is missing/],
			["short-secret", /shorter than 32/],
			["dev-internal-secret", /A_SECRET is/],
			["change-me-generate-a-32-byte-hex-secret", /change-me placeholder/],
			["CHANGE-ME-generate-a-32-byte-hex-secret", /change-me placeholder/],
		];
		for (const [value, pattern] of cases) {
			let message = "";
			try {
				assertProductionSecrets({ A_SECRET: value }, { nodeEnv: "production" });
			} catch (e) {
				message = (e as Error).message;
			}
			expect(message).toMatch(pattern);
			if (value) expect(message).not.toContain(value);
		}
	});

	it("enforces for case/whitespace variants of production", () => {
		for (const nodeEnv of ["Production", "PRODUCTION", " production\n"]) {
			expect(() => assertProductionSecrets({ A_SECRET: "short" }, { nodeEnv })).toThrow(/A_SECRET/);
		}
	});

	it("flags a known dev default", () => {
		expect(findWeakSecrets({ A: "dev-policy-rule-context-secret" })[0]).toMatch(/A is/);
	});

	it("allows listed optional secrets to be absent but still checks them when set", () => {
		const opts = { nodeEnv: "production", optional: ["OPT"] } as const;
		expect(() => assertProductionSecrets({ OPT: undefined, S: strong }, opts)).not.toThrow();
		expect(() => assertProductionSecrets({ OPT: "weak", S: strong }, opts)).toThrow(/OPT/);
	});
});
