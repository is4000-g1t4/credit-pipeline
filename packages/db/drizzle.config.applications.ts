import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/applications.ts",
	out: "./drizzle/applications",
	dialect: "postgresql",
});
