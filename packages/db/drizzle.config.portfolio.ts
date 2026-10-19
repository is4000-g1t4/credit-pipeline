import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/portfolio.ts",
	out: "./drizzle/portfolio",
	dialect: "postgresql",
});
