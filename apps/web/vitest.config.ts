import { defineConfig } from "vitest/config";

// Pure-logic unit tests only; the app's Vite/TanStack plugins are not needed
// and would load React's CJS build outside a DOM.
export default defineConfig({
	test: { include: ["src/**/*.test.ts"] },
});
