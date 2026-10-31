// Policy env loader: production refuses missing/default/weak secrets at import
// time (names only); non-production keeps the dev defaults.
import { afterEach, describe, expect, it, vi } from "vitest";

const strong = (n: string) => `${n}-k3j9x8v7b6n5m4q2w1e0r9t8y7u6i5o4p3a2s1d0`;
const NAMES = [
	"INTERNAL_SECRET",
	"POLICY_INTERNAL_SECRET",
	"POLICY_CASE_TOKEN_SECRET",
	"POLICY_CITATION_SECRET",
	"POLICY_AUDIT_HASH_SECRET",
	"POLICY_RULE_CONTEXT_SECRET",
];

function stub(nodeEnv: string, overrides: Record<string, string> = {}) {
	vi.resetModules();
	vi.stubEnv("SKIP_ENV_VALIDATION", "");
	vi.stubEnv("NODE_ENV", nodeEnv);
	for (const n of NAMES) vi.stubEnv(n, strong(n));
	for (const [k, v] of Object.entries(overrides)) vi.stubEnv(k, v);
}

afterEach(() => vi.unstubAllEnvs());

// First import is a cold transform of env + service-kit; slow under `pnpm -r test`.
describe("policy env in production", { timeout: 30_000 }, () => {
	it("loads with strong secrets", async () => {
		stub("production");
		await expect(import("../src/env.js")).resolves.toBeDefined();
	});

	it("rejects a known dev default without echoing the value", async () => {
		stub("production", { POLICY_INTERNAL_SECRET: "dev-policy-internal-secret" });
		const err = await import("../src/env.js").catch((e: Error) => e);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain("POLICY_INTERNAL_SECRET");
		expect((err as Error).message).not.toContain("dev-policy-internal-secret");
	});

	it("rejects a secret left to the dev default (unset)", async () => {
		stub("production");
		vi.stubEnv("POLICY_CITATION_SECRET", "");
		const err = await import("../src/env.js").catch((e: Error) => e);
		expect((err as Error).message).toContain("POLICY_CITATION_SECRET");
	});

	it("keeps dev defaults outside production", async () => {
		stub("development");
		vi.stubEnv("POLICY_AUDIT_HASH_SECRET", "");
		const mod = await import("../src/env.js");
		expect(mod.env.auditHashSecret).toBe("dev-policy-audit-secret");
	});

	it.each(["1", "false"])(
		"still rejects unset secrets when SKIP_ENV_VALIDATION=%s",
		async (skip) => {
			stub("production", { SKIP_ENV_VALIDATION: skip });
			vi.stubEnv("POLICY_CITATION_SECRET", "");
			const err = await import("../src/env.js").catch((e: Error) => e);
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toContain("POLICY_CITATION_SECRET");
		},
	);
});
