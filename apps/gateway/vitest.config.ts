import { defineConfig } from "vitest/config";

// Default `pnpm test`: compose-free only (auth cookie/limiter units).
// Integration tests (real Postgres) live in test/integration and run via
// `pnpm test:integration`.
export default defineConfig({
	test: {
		exclude: ["test/integration/**", "**/node_modules/**"],
	},
});
