import { defineConfig } from "vitest/config";

// Compose-required suite: real Postgres (credit_research). Serial, one
// worker — tests share tables, scoped by unique application ids.
export default defineConfig({
	test: {
		include: ["test/integration/**/*.test.ts"],
		pool: "forks",
		fileParallelism: false,
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
});
