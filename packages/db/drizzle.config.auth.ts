import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/auth.ts",
	out: "./drizzle/auth",
	dialect: "postgresql",
});
