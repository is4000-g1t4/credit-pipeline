// Gateway env loader: production refuses weak/placeholder session and internal
// secrets at import time (names only); non-production accepts them.
import { afterEach, describe, expect, it, vi } from "vitest";

const strong = "k3j9x8v7b6n5m4q2w1e0r9t8y7u6i5o4p3a2s1d0";

function stub(nodeEnv: string, overrides: Record<string, string> = {}) {
	vi.resetModules();
	vi.stubEnv("SKIP_ENV_VALIDATION", "");
	vi.stubEnv("NODE_ENV", nodeEnv);
	vi.stubEnv("AUTH_DATABASE_URL", "postgres://x:y@localhost:5432/credit_auth");
	vi.stubEnv("SESSION_SECRET", `session-${strong}`);
	vi.stubEnv("INTERNAL_SECRET", `internal-${strong}`);
	for (const [k, v] of Object.entries(overrides)) vi.stubEnv(k, v);
}

afterEach(() => vi.unstubAllEnvs());

describe("gateway env in production", () => {
	it("loads with strong secrets", async () => {
		stub("production");
		await expect(import("../src/env.js")).resolves.toBeDefined();
	});

	it("rejects a change-me placeholder without echoing it", async () => {
		const weak = "change-me-generate-a-32-byte-hex-secret";
		stub("production", { SESSION_SECRET: weak });
		const err = await import("../src/env.js").catch((e: Error) => e);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain("SESSION_SECRET");
		expect((err as Error).message).not.toContain(weak);
	});

	it("rejects a short internal secret", async () => {
		stub("production", { INTERNAL_SECRET: "short" });
		const err = await import("../src/env.js").catch((e: Error) => e);
		expect((err as Error).message).toContain("INTERNAL_SECRET");
	});

	it.each(["1", "true", "false"])(
		"still rejects weak secrets when SKIP_ENV_VALIDATION=%s",
		async (skip) => {
			stub("production", { SKIP_ENV_VALIDATION: skip, SESSION_SECRET: "short" });
			const err = await import("../src/env.js").catch((e: Error) => e);
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toContain("SESSION_SECRET");
		},
	);

	it("accepts short secrets outside production", async () => {
		stub("test", { SESSION_SECRET: "short", INTERNAL_SECRET: "short" });
		await expect(import("../src/env.js")).resolves.toBeDefined();
	});
});
