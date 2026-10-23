// T17 gateway proxy routes (compose-free): drafts/submit ride the submit
// limiter + long timeout, requirements/consent/customer proxy through, and
// the existing documents wildcard still covers reuse. A stub fetchImpl
// captures the upstream request; a stub db answers the session lookup.
import { createLogger } from "@credit/service-kit";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createRateLimiter, SESSION_COOKIE, signSession } from "../src/auth.js";
import type { GatewayDeps } from "../src/deps.js";

const SESSION_SECRET = "test-session-secret-0123456789abcdef";
const INTERNAL_SECRET = "test-internal-secret-0123456789abcdef";

interface Captured {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: ArrayBuffer | undefined;
}

function setup(captured: Captured[]): {
	app: ReturnType<typeof createApp>;
	user: { id: string; email: string; fullName: string; role: "applicant" };
} {
	const user = {
		id: "11111111-1111-4111-8111-111111111111",
		email: "applicant@example.com",
		fullName: "Test Applicant",
		role: "applicant" as const,
	};
	const db = {
		select: () => ({
			from: () => ({
				where: async () => [{ ...user }],
			}),
		}),
	};
	const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
		const raw = url instanceof Request ? url.url : String(url);
		let body: ArrayBuffer | undefined;
		const candidate = (init?.body ?? (url instanceof Request ? url.body : undefined)) as
			| string
			| ArrayBuffer
			| undefined;
		if (typeof candidate === "string") {
			body = new TextEncoder().encode(candidate).buffer as ArrayBuffer;
		} else if (candidate instanceof ArrayBuffer) {
			body = candidate;
		}
		const headers: Record<string, string> = {};
		const source = new Headers(init?.headers as Record<string, string> | undefined);
		source.forEach((value, key) => {
			headers[key] = value;
		});
		captured.push({ method: init?.method ?? "GET", url: raw, headers, body });
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
			sessionSecret: SESSION_SECRET,
			internalSecret: INTERNAL_SECRET,
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
		logger: createLogger("gateway-t17-test"),
		loginLimiter: createRateLimiter(1000, 60_000),
		loginEmailLimiter: createRateLimiter(1000, 60_000),
		submitLimiter: createRateLimiter(5, 60_000),
		policyLimiter: createRateLimiter(1000, 60_000),
		fetchImpl,
	} satisfies GatewayDeps;
	return { app: createApp(deps), user };
}

function cookieFor(userId: string): string {
	return `${SESSION_COOKIE}=${signSession(userId, SESSION_SECRET)}`;
}

describe("T17 gateway routes", () => {
	it("proxies drafts with the idempotency key preserved", async () => {
		const captured: Captured[] = [];
		const { app, user } = setup(captured);
		const res = await app.request("/api/applications/drafts", {
			method: "POST",
			headers: {
				cookie: cookieFor(user.id),
				"content-type": "application/json",
				"Idempotency-Key": "draft-key-1",
			},
			body: JSON.stringify({ type: "individual" }),
		});
		expect(res.status).toBe(200);
		expect(captured).toHaveLength(1);
		expect(captured[0].method).toBe("POST");
		expect(captured[0].url).toBe("http://applications.test/api/applications/drafts");
		expect(captured[0].headers["idempotency-key"]).toBe("draft-key-1");
	});

	it("requires the idempotency key on drafts and submit", async () => {
		const captured: Captured[] = [];
		const { app, user } = setup(captured);
		const id = "22222222-2222-4222-8222-222222222222";
		for (const init of [
			{ path: "/api/applications/drafts", method: "POST" },
			{ path: `/api/applications/${id}/submit`, method: "POST" },
		] as const) {
			const res = await app.request(init.path, {
				method: init.method,
				headers: { cookie: cookieFor(user.id), "content-type": "application/json" },
				body: "{}",
			});
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
				"MISSING_IDEMPOTENCY_KEY",
			);
		}
		expect(captured).toHaveLength(0);
	});

	it("rate-limits drafts like create (5/min/user)", async () => {
		const captured: Captured[] = [];
		const { app, user } = setup(captured);
		for (let i = 0; i < 5; i++) {
			const res = await app.request("/api/applications/drafts", {
				method: "POST",
				headers: {
					cookie: cookieFor(user.id),
					"content-type": "application/json",
					"Idempotency-Key": `k-${i}`,
				},
				body: "{}",
			});
			expect(res.status).toBe(200);
		}
		const limited = await app.request("/api/applications/drafts", {
			method: "POST",
			headers: {
				cookie: cookieFor(user.id),
				"content-type": "application/json",
				"Idempotency-Key": "k-5",
			},
			body: "{}",
		});
		expect(limited.status).toBe(429);
		expect(captured).toHaveLength(5);
	});

	it("proxies submit/requirements/context-consent/customer paths untouched", async () => {
		const captured: Captured[] = [];
		const { app, user } = setup(captured);
		const id = "33333333-3333-4333-8333-333333333333";
		const calls: Array<{ method: string; path: string; body?: string }> = [
			{ method: "POST", path: `/api/applications/${id}/submit`, body: "{}" },
			{ method: "GET", path: `/api/applications/${id}/requirements` },
			{
				method: "PATCH",
				path: `/api/applications/${id}/context-consent`,
				body: '{"consent":true}',
			},
			{ method: "GET", path: "/api/customer/profile" },
			{ method: "GET", path: "/api/customer/documents" },
			{ method: "POST", path: `/api/applications/${id}/documents/reuse`, body: '{"a":1}' },
		];
		for (const call of calls) {
			const res = await app.request(call.path, {
				method: call.method,
				headers: {
					cookie: cookieFor(user.id),
					"content-type": "application/json",
					...(call.method === "POST" ? { "Idempotency-Key": "k" } : {}),
				},
				body: call.body,
			});
			expect(res.status).toBe(200);
		}
		expect(captured.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
			`POST /api/applications/${id}/submit`,
			`GET /api/applications/${id}/requirements`,
			`PATCH /api/applications/${id}/context-consent`,
			"GET /api/customer/profile",
			"GET /api/customer/documents",
			`POST /api/applications/${id}/documents/reuse`,
		]);
		for (const entry of captured) {
			expect(entry.url.startsWith("http://applications.test")).toBe(true);
		}
	});

	it("rejects unauthenticated customer reads", async () => {
		const captured: Captured[] = [];
		const { app } = setup(captured);
		const res = await app.request("/api/customer/profile");
		expect(res.status).toBe(401);
		expect(captured).toHaveLength(0);
	});
});
