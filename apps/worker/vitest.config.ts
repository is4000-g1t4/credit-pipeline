import { defineConfig } from "vitest/config";

// Default `pnpm test`: compose-free only. Integration tests (real
// Postgres/Kafka/Temporal) live in test/integration and run via
// `pnpm test:integration`.
//
// Workflow tests share one time-skipping Temporal server and each file
// builds its own workflow bundle (webpack). Running files in parallel
// starves that bundle step and trips the per-test timeout, so files run
// serially here. The generous timeouts cover a cold first bundle.
export default defineConfig({
	test: {
		exclude: ["test/integration/**", "**/node_modules/**"],
		fileParallelism: false,
		testTimeout: 120_000,
		hookTimeout: 120_000,
	},
});
