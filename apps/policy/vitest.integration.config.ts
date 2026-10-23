import { defineConfig } from "vitest/config";

// No policy integration suite yet; keep the workspace integration gate green
// until a DB-backed policy test lands.
export default defineConfig({
	test: {
		include: ["test/integration/**/*.test.ts"],
		passWithNoTests: true,
	},
});
