import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/policy.ts",
	out: "./drizzle/policy",
	dialect: "postgresql",
});
