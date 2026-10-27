import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
	server: {
		host: "127.0.0.1",
		port: 3000,
	},
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
	plugins: [
		tailwindcss(),
		tanstackStart({ srcDirectory: "src" }),
		viteReact(),
		// SPEC FR-11.6 same-origin /api: Vite's server.proxy never sees
		// requests in dev (TanStack Start's Nitro handler runs first) and
		// never applies to builds — the Nitro routeRules proxy below is the
		// one that actually forwards, in dev and in production.
		nitro({
			routeRules: {
				// Agent memo drafts can exceed a minute; keep the dev/prod proxy
				// bound above the applications-side memo timeout.
				"/api/**": {
					proxy: { to: "http://127.0.0.1:3001/api/**", timeout: 120_000 },
				},
			},
		}),
	],
});
