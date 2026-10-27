import { defineConfig } from "vitest/config";

// Compose-required suite: real Postgres. Run serially in one worker — the
// tests share tables, scoped by unique users per test.
export default defineConfig({
	test: {
		include: ["test/integration/**/*.test.ts"],
		fileParallelism: false,
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
});
