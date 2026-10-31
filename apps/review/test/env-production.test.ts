// Review env loader: production refuses a weak internal secret at import time,
// even when SKIP_ENV_VALIDATION is set (that flag only skips the zod schema).
import { afterEach, describe, expect, it, vi } from "vitest";

const strong = "k3j9x8v7b6n5m4q2w1e0r9t8y7u6i5o4p3a2s1d0";

function stub(nodeEnv: string, overrides: Record<string, string> = {}) {
	vi.resetModules();
	vi.stubEnv("SKIP_ENV_VALIDATION", "");
	vi.stubEnv("NODE_ENV", nodeEnv);
	vi.stubEnv("INTERNAL_SECRET", `internal-${strong}`);
	for (const [k, v] of Object.entries(overrides)) vi.stubEnv(k, v);
}

afterEach(() => vi.unstubAllEnvs());

describe("review env in production", () => {
	it("loads with a strong secret", async () => {
		stub("production");
		await expect(import("../src/env.js")).resolves.toBeDefined();
	});

	it.each(["", "1", "false"])(
		"rejects a short internal secret (SKIP_ENV_VALIDATION=%j)",
		async (skip) => {
			stub("production", { SKIP_ENV_VALIDATION: skip, INTERNAL_SECRET: "short" });
			const err = await import("../src/env.js").catch((e: Error) => e);
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toContain("INTERNAL_SECRET");
		},
	);

	it("accepts a short secret outside production", async () => {
		stub("test", { INTERNAL_SECRET: "short" });
		await expect(import("../src/env.js")).resolves.toBeDefined();
	});
});
