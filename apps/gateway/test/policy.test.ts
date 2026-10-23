// Policy gateway proxy (officer-only): every /api/policy/* path proxies
// unchanged to the policy service under the long ask timeout, behind a
// per-actor limiter. Compose-free: a stub fetchImpl captures the upstream
// request; a stub db answers the session lookup.
import { createLogger } from "@credit/service-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createRateLimiter, SESSION_COOKIE, signSession } from "../src/auth.js";
import type { GatewayDeps } from "../src/deps.js";
import { resolveInternalHeadersForTest } from "./header-check.js";

const SESSION_SECRET = "test-session-secret-0123456789abcdef";
const INTERNAL_SECRET = "test-internal-secret-0123456789abcdef";
const POLICY_TIMEOUT_MS = 60_000;

interface Captured {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: string | null;
}

interface Actor {
	id: string;
	email: string;
	fullName: string;
	role: "applicant" | "officer";
}

function setup(captured: Captured[], opts: { policyLimit?: number } = {}): {
	app: ReturnType<typeof createApp>;
	officers: [Actor, Actor];
	applicant: Actor;
	actAs: (actor: Actor) => void;
} {
	const officers: [Actor, Actor] = [
		{
			id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			email: "officer-a@example.com",
			fullName: "Officer A",
			role: "officer",
		},
		{
			id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			email: "officer-b@example.com",
			fullName: "Officer B",
			role: "officer",
		},
	];
	const applicant: Actor = {
		id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		email: "applicant@example.com",
		fullName: "Test Applicant",
		role: "applicant",
	};
	let current: Actor = officers[0];
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
			policyUpstreamTimeoutMs: POLICY_TIMEOUT_MS,
			policyAskRatePerMin: 10,
		},
		logger: createLogger("gateway-policy-test"),
		loginLimiter: createRateLimiter(1000, 60_000),
		loginEmailLimiter: createRateLimiter(1000, 60_000),
		submitLimiter: createRateLimiter(1000, 60_000),
		policyLimiter: createRateLimiter(opts.policyLimit ?? 1000, 60_000),
		fetchImpl,
	} satisfies GatewayDeps;
	return {
		app: createApp(deps),
		officers,
		applicant,
		actAs: (actor: Actor) => {
			current = actor;
		},
	};
}

function cookieFor(userId: string): string {
	return `${SESSION_COOKIE}=${signSession(userId, SESSION_SECRET)}`;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("policy gateway routes", () => {
	it("proxies ask for officers with path/query/body signed and the long timeout", async () => {
		const spy = vi.spyOn(AbortSignal, "timeout");
		const captured: Captured[] = [];
		const { app, officers } = setup(captured);
		const body = JSON.stringify({ question: "what changed?" });
		const res = await app.request("/api/policy/ask?model=x", {
			method: "POST",
			headers: {
				cookie: cookieFor(officers[0].id),
				"content-type": "application/json",
				"Idempotency-Key": "ask-1",
			},
			body,
		});
		expect(res.status).toBe(200);
		expect(captured).toHaveLength(1);
		expect(captured[0].method).toBe("POST");
		expect(captured[0].url).toBe("http://policy.test/api/policy/ask?model=x");
		expect(captured[0].headers["content-type"]).toContain("application/json");
		expect(captured[0].headers["idempotency-key"]).toBe("ask-1");
		expect(
			resolveInternalHeadersForTest(INTERNAL_SECRET, {
				method: "POST",
				path: "/api/policy/ask",
				headers: captured[0].headers,
				body: captured[0].body,
			})?.role,
		).toBe("officer");
		// Long ask bound, not the 5s proxy default — no real 60s wait.
		expect(spy).toHaveBeenCalledWith(POLICY_TIMEOUT_MS);
		expect(spy).not.toHaveBeenCalledWith(5_000);
	});

	it("rejects applicants and unauthenticated callers without touching upstream", async () => {
		const captured: Captured[] = [];
		const { app, applicant, actAs } = setup(captured);
		actAs(applicant);
		const res = await app.request("/api/policy/ask", {
			method: "POST",
			headers: {
				cookie: cookieFor(applicant.id),
				"content-type": "application/json",
			},
			body: "{}",
		});
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
		const anon = await app.request("/api/policy/ask", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		expect(anon.status).toBe(401);
		expect(captured).toHaveLength(0);
	});

	it("rate-limits per officer: 429 envelope, other officers unaffected", async () => {
		const captured: Captured[] = [];
		const { app, officers, actAs } = setup(captured, { policyLimit: 2 });
		actAs(officers[0]);
		for (let i = 0; i < 2; i++) {
			const res = await app.request("/api/policy/ask", {
				method: "POST",
				headers: {
					cookie: cookieFor(officers[0].id),
					"content-type": "application/json",
				},
				body: "{}",
			});
			expect(res.status).toBe(200);
		}
		const limited = await app.request("/api/policy/ask", {
			method: "POST",
			headers: {
				cookie: cookieFor(officers[0].id),
				"content-type": "application/json",
			},
			body: "{}",
		});
		expect(limited.status).toBe(429);
		expect(((await limited.json()) as { error: { code: string } }).error.code).toBe(
			"RATE_LIMITED",
		);
		expect(captured).toHaveLength(2);
		// A different officer has their own budget.
		actAs(officers[1]);
		const other = await app.request("/api/policy/ask", {
			method: "POST",
			headers: {
				cookie: cookieFor(officers[1].id),
				"content-type": "application/json",
			},
			body: "{}",
		});
		expect(other.status).toBe(200);
		expect(captured).toHaveLength(3);
	});

	it("preserves policy paths verbatim and leaves other services on their hosts", async () => {
		const captured: Captured[] = [];
		const { app, officers } = setup(captured);
		const cookie = cookieFor(officers[0].id);
		const calls: Array<{ method: string; path: string; body?: string }> = [
			{ method: "GET", path: "/api/policy/sections/v9/s3" },
			{ method: "POST", path: "/api/policy/versions/abc/submit", body: "{}" },
			{ method: "POST", path: "/api/policy/versions/abc/approve?reuse=1", body: "{}" },
			{ method: "POST", path: "/api/policy/versions/abc/retire", body: "{}" },
		];
		for (const call of calls) {
			const res = await app.request(call.path, {
				method: call.method,
				headers: { cookie, "content-type": "application/json" },
				body: call.body,
			});
			expect(res.status).toBe(200);
		}
		expect(captured.map((c) => `${c.method} ${c.url}`)).toEqual([
			"GET http://policy.test/api/policy/sections/v9/s3",
			"POST http://policy.test/api/policy/versions/abc/submit",
			"POST http://policy.test/api/policy/versions/abc/approve?reuse=1",
			"POST http://policy.test/api/policy/versions/abc/retire",
		]);
		// Non-policy traffic is untouched by the new route.
		const loans = await app.request("/api/loans", { headers: { cookie } });
		expect(loans.status).toBe(200);
		expect(captured.at(-1)?.url).toBe("http://loans.test/api/loans");
	});
});
