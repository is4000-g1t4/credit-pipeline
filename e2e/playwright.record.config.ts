import { defineConfig } from "@playwright/test";

// Manual recording harness: requires ASSIST_ENABLED=true and usually
// ASSIST_MEMO_WRITER=agent. Keeps the browser video; not part of normal e2e.
export default defineConfig({
	testDir: "./",
	testMatch: ["copilot-demo.record.ts"],
	globalSetup: "./global-setup.ts",
	globalTeardown: "./global-teardown.ts",
	outputDir: "./recordings",
	use: {
		baseURL: "http://127.0.0.1:3000",
		video: "on",
		viewport: { width: 1440, height: 1000 },
		trace: "off",
	},
	workers: 1,
	retries: 0,
	timeout: 300_000,
	expect: { timeout: 60_000 },
	reporter: [["list"]],
});
