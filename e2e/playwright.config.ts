import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./",
	testMatch: ["*.spec.ts"],
	globalSetup: "./global-setup.ts",
	globalTeardown: "./global-teardown.ts",
	use: {
		baseURL: "http://127.0.0.1:3000",
		trace: "on-first-retry",
	},
	// One worker: specs share the dev stack and the seeded DB. Retries stay
	// 0 locally — a flaky spec is a bug to fix, not to mask (W6 gate).
	workers: 1,
	retries: 0,
	timeout: 300_000,
	expect: {
		timeout: 30_000,
	},
	outputDir: "./test-results",
	reporter: [["list"]],
});
