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
import { createLogger, type Logger } from "@credit/service-kit";
import { createApp } from "../src/app.js";
import { createRateLimiter, SESSION_COOKIE, signSession } from "../src/auth.js";
import type { GatewayDeps } from "../src/deps.js";
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

export function setupApp(opts: { logger?: Logger } = {}): TestContext {
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
		logger: opts.logger ?? createLogger("gateway-test"),
		loginLimiter: createRateLimiter(1000, 60_000),
		loginEmailLimiter: createRateLimiter(1000, 60_000),
		submitLimiter: createRateLimiter(1000, 60_000),
		policyLimiter: createRateLimiter(1000, 60_000),
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

// Compose-free stub app (shared by the customer-intake and policy proxy
// tests, which used to carry their own copies): a stub db answering the
// session lookup with the current actor + a stub fetchImpl capturing the
// downstream request (body as text, so tests can assert what was
// forwarded). ACTORS are fixed uuids; switch with actAs.
export interface StubActor {
	id: string;
	email: string;
	fullName: string;
	role: "applicant" | "officer";
}

export interface StubRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: string | null;
}

export const STUB_SESSION_SECRET = "test-session-secret-0123456789abcdef";
export const STUB_INTERNAL_SECRET = "test-internal-secret-0123456789abcdef";

export function setupStubApp(
	captured: StubRequest[],
	opts: { policyLimit?: number } = {},
): {
	app: ReturnType<typeof createApp>;
	officers: [StubActor, StubActor];
	applicant: StubActor;
	actAs: (actor: StubActor) => void;
	cookieFor: (userId: string) => string;
} {
	const officers: [StubActor, StubActor] = [
		{
			id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			email: "officer-a@example.com",
			fullName: "Officer A",
			role: "officer",
		},
		{
			id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			email: "Officer B",
			fullName: "Officer B",
			role: "officer",
		},
	];
	const applicant: StubActor = {
		id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		email: "applicant@example.com",
		fullName: "Test Applicant",
		role: "applicant",
	};
	let current: StubActor = officers[0];
	const db = {
		select: () => ({
			from: () => ({
				where: async () => [{ ...current }],
			}),
		}),
	};
	const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
		const req = new Request(url, init);
		const headers: Record<string, string> = {};
		req.headers.forEach((value, key) => {
			headers[key] = value;
		});
		captured.push({
			method: req.method,
			url: req.url,
			headers,
			body: req.method === "GET" || req.method === "HEAD" ? null : await req.text(),
		});
		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	const deps = {
		db: db as unknown as GatewayDeps["db"],
		sql: {} as GatewayDeps["sql"],
		env: {
			nodeEnv: "test",
			demoMode: true,
			sessionSecret: STUB_SESSION_SECRET,
			internalSecret: STUB_INTERNAL_SECRET,
			databaseUrl: "postgres://localhost:5432/unused",
			temporalAddress: "localhost:7233",
			kafkaBrokers: "localhost:9092",
			webOrigin: "http://localhost:3000",
			apiPort: 3001,
			apiHost: "127.0.0.1",
			applicationsUrl: "http://applications.test",
			reviewUrl: "http://review.test",
			loansUrl: "http://loans.test",
			portfolioUrl: "http://portfolio.test",
			policyUrl: "http://policy.test",
			policyUpstreamTimeoutMs: 60_000,
			policyAskRatePerMin: 10,
		},
		logger: createLogger("gateway-stub-test"),
		loginLimiter: createRateLimiter(1000, 60_000),
		loginEmailLimiter: createRateLimiter(1000, 60_000),
		submitLimiter: createRateLimiter(5, 60_000),
		policyLimiter: createRateLimiter(opts.policyLimit ?? 1000, 60_000),
		fetchImpl,
	} satisfies GatewayDeps;
	return {
		app: createApp(deps),
		officers,
		applicant,
		actAs: (actor: StubActor) => {
			current = actor;
		},
		cookieFor: (userId: string) => `${SESSION_COOKIE}=${signSession(userId, STUB_SESSION_SECRET)}`,
	};
}
