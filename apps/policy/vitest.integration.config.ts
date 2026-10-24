import { defineConfig } from "vitest/config";

// DB-backed policy store contract (credit_policy). The route tests stub the
// store; this suite is the only check on the real ACL/budget/token SQL.
export default defineConfig({
	test: {
		include: ["test/integration/**/*.test.ts"],
	},
});
