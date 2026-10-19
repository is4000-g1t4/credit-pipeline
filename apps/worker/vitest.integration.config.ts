import { defineConfig } from "vitest/config";

// Compose-required suite: real Postgres/Kafka/Temporal. Run serially in one
// worker — the tests share topics and tables, scoped by unique ids.
export default defineConfig({
	test: {
		include: ["test/integration/**/*.test.ts"],
		pool: "forks",
		forks: { singleFork: true },
		testTimeout: 120_000,
		hookTimeout: 120_000,
	},
});
