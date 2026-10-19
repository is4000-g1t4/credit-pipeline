import { defineConfig } from "vitest/config";

// Default `pnpm test`: compose-free only (none yet — integration covers this
// service). `passWithNoTests` keeps `pnpm -r test` green.
export default defineConfig({
	test: {
		exclude: ["test/integration/**", "**/node_modules/**"],
		passWithNoTests: true,
	},
});
