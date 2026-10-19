import { createDb } from "@credit/db";
import { createLogger } from "@credit/service-kit";
import { createApp } from "./app.js";
import { createRateLimiter } from "./auth.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const logger = createLogger("gateway");
const { db, sql } = createDb(env.databaseUrl);

const app = createApp({
	db,
	sql,
	env,
	logger,
	loginLimiter: createRateLimiter(30, 60_000),
	loginEmailLimiter: createRateLimiter(10, 60_000),
	submitLimiter: createRateLimiter(5, 60_000),
});

// Bun entry: `bun --watch --env-file=../../.env src/server.ts` (see
// package.json dev). Bun serves the default export; `app.ts` stays a pure
// Hono factory so tests keep importing it directly under Node/Vitest.
interface BunServer {
	requestIP(req: Request): { address: string } | null;
}

export default {
	port: env.apiPort,
	hostname: env.apiHost,
	// Bun's default 10s idle timeout would pre-empt the 45s demo/review calls.
	idleTimeout: 60,
	fetch(req: Request, server: BunServer) {
		// clientIp() (auth.ts) reads x-forwarded-for first: overwrite it with
		// the real peer address so the login limiter stays per-IP. Never
		// trust a client-supplied value — a spoofed header would let one
		// client rotate identities past the limiter.
		const ip = server.requestIP(req)?.address;
		if (ip) {
			const headers = new Headers(req.headers);
			headers.set("x-forwarded-for", ip);
			req = new Request(req, { headers });
		}
		return app.fetch(req);
	},
};

console.log(`gateway listening on http://${env.apiHost}:${env.apiPort}`);
