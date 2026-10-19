// Integration setup: real Postgres (compose) for the cookie session,
// stubbed downstream services via an injected `fetchImpl` — no real
// services are started. Unique users per test keep runs deterministic.
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({
	path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

import { randomUUID } from "node:crypto";
import { createDb, hashPassword } from "@credit/db";
import { users } from "@credit/db/auth";
import { createLogger } from "@credit/service-kit";
import { createApp } from "../src/app.js";
import { createRateLimiter } from "../src/auth.js";
import { loadEnv } from "../src/env.js";

process.env.LOG_LEVEL ??= "silent";

export interface CapturedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string | null;
}

export interface TestContext {
	app: ReturnType<typeof createApp>;
	db: ReturnType<typeof createDb>["db"];
	sql: ReturnType<typeof createDb>["sql"];
	captured: CapturedRequest[];
	/** Handler for stubbed downstream calls: receives the request, returns the response. */
	downstream: (req: CapturedRequest) => Response | Promise<Response>;
	secret: string;
}

function headerRecord(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of headers.entries()) out[k.toLowerCase()] = v;
	return out;
}

export function setupApp(): TestContext {
	const env = loadEnv();
	const { db, sql } = createDb(env.databaseUrl);
	const ctx: TestContext = {
		app: undefined as never,
		db,
		sql,
		captured: [],
		downstream: () =>
			new Response(JSON.stringify({ error: { code: "NO_STUB", message: "no stub" } }), {
				status: 500,
			}),
		secret: env.internalSecret,
	};
	const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const req = new Request(url, init);
		const captured: CapturedRequest = {
			url: req.url,
			method: req.method,
			headers: headerRecord(req.headers),
			body: req.method === "GET" || req.method === "HEAD" ? null : await req.text(),
		};
		ctx.captured.push(captured);
		return ctx.downstream(captured);
	};
	ctx.app = createApp({
		db,
		sql,
		env,
		logger: createLogger("gateway-test"),
		loginLimiter: createRateLimiter(1000, 60_000),
		loginEmailLimiter: createRateLimiter(1000, 60_000),
		submitLimiter: createRateLimiter(1000, 60_000),
		fetchImpl: fetchImpl as typeof fetch,
	});
	return ctx;
}

export async function createUser(
	ctx: TestContext,
	role: "applicant" | "officer" = "applicant",
): Promise<{ id: string; email: string }> {
	const email = `gw-${randomUUID()}@example.com`;
	const [row] = await ctx.db
		.insert(users)
		.values({
			email,
			fullName: role === "officer" ? "GW Officer" : "GW Applicant",
			role,
			passwordHash: await hashPassword("demo1234"),
		})
		.returning({ id: users.id, email: users.email });
	return row;
}

/** Login via the app; returns the `session=...` cookie value for requests. */
export async function loginCookie(
	ctx: TestContext,
	email: string,
	password = "demo1234",
): Promise<string> {
	const res = await ctx.app.request("/api/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email, password }),
	});
	if (res.status !== 200) {
		throw new Error(`login failed for ${email}: ${res.status} ${await res.text()}`);
	}
	const setCookie = res.headers.get("set-cookie") ?? "";
	const session = setCookie.split(";")[0];
	if (!session.startsWith("session=")) throw new Error("no session cookie set");
	return session;
}

export async function teardown(ctx: TestContext): Promise<void> {
	await ctx.sql.end();
}
