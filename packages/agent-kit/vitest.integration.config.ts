import { defineConfig } from "vitest/config";

// Compose-required suite: real Temporal at TEMPORAL_ADDRESS (default
// localhost:7233). Serial: the tests share the default namespace.
export default defineConfig({
	test: {
		include: ["test/integration/**/*.test.ts"],
		fileParallelism: false,
		testTimeout: 120_000,
		hookTimeout: 120_000,
	},
});
