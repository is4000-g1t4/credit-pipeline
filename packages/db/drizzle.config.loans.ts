import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/loans.ts",
	out: "./drizzle/loans",
	dialect: "postgresql",
});
