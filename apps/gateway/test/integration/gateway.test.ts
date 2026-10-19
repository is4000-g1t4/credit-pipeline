// Gateway integration (compose Postgres for the cookie session, stubbed
// downstream services via the injected `fetchImpl`): auth + me/demoMode,
// role gating without touching downstream, proxy signing/forwarding,
// application detail composition, upstream failure → 502, health shape.
import { createLogger } from "@credit/service-kit";
import { createApp } from "../../src/app.js";
import { createRateLimiter } from "../../src/auth.js";
import { loadEnv } from "../../src/env.js";
import { resolveInternalHeadersForTest } from "../header-check.js";
import { createUser, loginCookie, setupApp, teardown, type TestContext } from "../helper.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let ctx: TestContext;

beforeAll(() => {
	ctx = setupApp();
});

afterAll(async () => {
	await teardown(ctx);
});

async function jsonBody<T>(res: Response): Promise<T> {
	return (await res.json()) as T;
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("auth", () => {
	it("login → me (with demoMode) → logout → me is 401", async () => {
		const { email } = await createUser(ctx);
		const cookie = await loginCookie(ctx, email);
		const me = await ctx.app.request("/api/auth/me", { headers: { cookie } });
		expect(me.status).toBe(200);
		const body = await jsonBody<{ user: { email: string }; demoMode: boolean }>(me);
		expect(body.user.email).toBe(email);
		expect(typeof body.demoMode).toBe("boolean");

		const logout = await ctx.app.request("/api/auth/logout", {
			method: "POST",
			headers: { cookie },
		});
		expect(logout.status).toBe(200);
		expect(logout.headers.get("set-cookie")).toMatch(/Max-Age=0/);

		const after = await ctx.app.request("/api/auth/me");
		expect(after.status).toBe(401);
		expect((await jsonBody<{ error: { code: string } }>(after)).error.code).toBe("UNAUTHENTICATED");
	});

	it("wrong password is 401", async () => {
		const { email } = await createUser(ctx);
		const res = await ctx.app.request("/api/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email, password: "wrong" }),
		});
		expect(res.status).toBe(401);
	});

	it("login is limited 10/min per email and 30/min per IP", async () => {
		// Tight-limit app on the same DB: production caps (30/IP, 10/email).
		const tight = createApp({
			db: ctx.db,
			sql: ctx.sql,
			env: loadEnv(),
			logger: createLogger("gateway-test-tight"),
			loginLimiter: createRateLimiter(30, 60_000),
			loginEmailLimiter: createRateLimiter(10, 60_000),
			submitLimiter: createRateLimiter(1000, 60_000),
		});
		const attempt = (email: string, ip: string, password = "wrong") =>
			tight.request("/api/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json", "x-forwarded-for": ip },
				body: JSON.stringify({ email, password }),
			});

		// One email hammered from rotating IPs: 10 pass the limiter (401 on
		// the bad password), the 11th is 429.
		const hammered = `hammer-${Date.now()}@example.com`;
		for (let i = 0; i < 10; i++) {
			const res = await attempt(hammered, `10.10.0.${i + 1}`);
			expect(res.status).toBe(401);
		}
		const emailCapped = await attempt(hammered, "10.10.0.99");
		expect(emailCapped.status).toBe(429);
		expect((await jsonBody<{ error: { code: string } }>(emailCapped)).error.code).toBe(
			"RATE_LIMITED",
		);

		// One IP across rotating emails: 30 pass, the 31st is 429.
		const sharedIp = "10.20.0.1";
		for (let i = 0; i < 30; i++) {
			const res = await attempt(`rotating-${Date.now()}-${i}@example.com`, sharedIp);
			expect(res.status).toBe(401);
		}
		const ipCapped = await attempt(`rotating-${Date.now()}-last@example.com`, sharedIp);
		expect(ipCapped.status).toBe(429);
		expect((await jsonBody<{ error: { code: string } }>(ipCapped)).error.code).toBe("RATE_LIMITED");

		// A normal single login from a fresh IP still succeeds.
		const { email } = await createUser(ctx);
		const ok = await tight.request("/api/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json", "x-forwarded-for": "10.30.0.1" },
			body: JSON.stringify({ email, password: "demo1234" }),
		});
		expect(ok.status).toBe(200);
	});
});

describe("role gating (downstream untouched)", () => {
	it("applicant cannot call review/dashboard/demo", async () => {
		const { email } = await createUser(ctx);
		const cookie = await loginCookie(ctx, email);
		ctx.captured.length = 0;
		for (const [method, path] of [
			["GET", "/api/review/queue"],
			["POST", "/api/review/00000000-0000-0000-0000-000000000000/decision"],
			["GET", "/api/dashboard/summary"],
			["POST", "/api/demo/monitoring/run"],
		] as Array<["GET" | "POST", string]>) {
			const res = await ctx.app.request(path, {
				method,
				headers: { cookie, "content-type": "application/json" },
				body: method === "POST" ? JSON.stringify({}) : undefined,
			});
			expect(res.status).toBe(403);
		}
		expect(ctx.captured).toHaveLength(0);
	});

	it("officer-only submit: officers cannot POST /api/applications", async () => {
		const officer = await createUser(ctx, "officer");
		const cookie = await loginCookie(ctx, officer.email);
		ctx.captured.length = 0;
		const res = await ctx.app.request("/api/applications", {
			method: "POST",
			headers: { cookie, "content-type": "application/json", "Idempotency-Key": "k" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(403);
		expect(ctx.captured).toHaveLength(0);
	});

	it("POST /api/applications without an Idempotency-Key is 400", async () => {
		const { email } = await createUser(ctx);
		const cookie = await loginCookie(ctx, email);
		ctx.captured.length = 0;
		const res = await ctx.app.request("/api/applications", {
			method: "POST",
			headers: { cookie, "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		expect(ctx.captured).toHaveLength(0);
	});
});

describe("proxy signing and forwarding", () => {
	it("forwards method/path/query/body/headers with a verifiable signature", async () => {
		const { email, id } = await createUser(ctx);
		const cookie = await loginCookie(ctx, email);
		ctx.captured.length = 0;
		ctx.downstream = (req) => {
			expect(req.url).toMatch(/\/api\/loans\?limit=5$/);
			expect(req.method).toBe("GET");
			return jsonResponse(200, { items: [{ id: "loan-1" }] });
		};
		const res = await ctx.app.request("/api/loans?limit=5", { headers: { cookie } });
		expect(res.status).toBe(200);
		expect(await jsonBody<unknown>(res)).toEqual({ items: [{ id: "loan-1" }] });
		expect(ctx.captured).toHaveLength(1);
		const [req] = ctx.captured;
		// Signed identity verifies against the exact downstream pathname.
		expect(
			resolveInternalHeadersForTest(ctx.secret, {
				method: "GET",
				path: "/api/loans",
				headers: req.headers,
			}),
		).toEqual({ id, email, role: "applicant" });
		expect(req.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/i);
		expect(res.headers.get("x-request-id")).toBe(req.headers["x-request-id"]);
	});

	it("POST copies content-type, Idempotency-Key and the body; status passes through", async () => {
		const { email } = await createUser(ctx);
		const cookie = await loginCookie(ctx, email);
		ctx.captured.length = 0;
		ctx.downstream = (req) => {
			expect(req.headers["content-type"]).toContain("application/json");
			expect(req.headers["idempotency-key"]).toBe("key-123");
			expect(JSON.parse(req.body ?? "")).toEqual({ hello: "world" });
			return jsonResponse(201, { id: "app-1", reference: "APP-2026-ABCDEF" });
		};
		const res = await ctx.app.request("/api/applications", {
			method: "POST",
			headers: { cookie, "content-type": "application/json", "Idempotency-Key": "key-123" },
			body: JSON.stringify({ hello: "world" }),
		});
		expect(res.status).toBe(201);
		expect(await jsonBody<unknown>(res)).toEqual({ id: "app-1", reference: "APP-2026-ABCDEF" });
	});

	it("officer routes proxy with the officer identity (review 200, dashboard 200)", async () => {
		const officer = await createUser(ctx, "officer");
		const cookie = await loginCookie(ctx, officer.email);
		ctx.captured.length = 0;
		ctx.downstream = (req) => {
			if (req.url.endsWith("/api/review/queue")) return jsonResponse(200, { items: [] });
			return jsonResponse(200, { applications: {}, loans: {} });
		};
		const queue = await ctx.app.request("/api/review/queue", { headers: { cookie } });
		expect(queue.status).toBe(200);
		const summary = await ctx.app.request("/api/dashboard/summary", { headers: { cookie } });
		expect(summary.status).toBe(200);
		expect(ctx.captured).toHaveLength(2);
		for (const req of ctx.captured) {
			expect(
				resolveInternalHeadersForTest(ctx.secret, {
					method: "GET",
					path: new URL(req.url).pathname,
					headers: req.headers,
				})?.role,
			).toBe("officer");
		}
	});
});

describe("application detail composition", () => {
	const appId = "11111111-1111-1111-1111-111111111111";
	const appPayload = {
		application: { id: appId, status: "booked" },
		decision: { outcome: "approved" },
		timeline: [],
	};

	it("merges the loans lookup into `loan`", async () => {
		const { email } = await createUser(ctx);
		const cookie = await loginCookie(ctx, email);
		ctx.downstream = (req) => {
			const path = new URL(req.url).pathname;
			if (path === `/api/applications/${appId}`) return jsonResponse(200, appPayload);
			if (path === `/internal/loans/by-application/${appId}`) {
				expect(
					resolveInternalHeadersForTest(ctx.secret, { method: "GET", path, headers: req.headers }),
				).not.toBeNull();
				return jsonResponse(200, {
					loan: { id: "loan-9", principalCents: 1_200_000 },
					installments: { total: 48, paid: 0, overdue: 0 },
				});
			}
			return jsonResponse(404, { error: { code: "NOT_FOUND", message: "not found" } });
		};
		const res = await ctx.app.request(`/api/applications/${appId}`, { headers: { cookie } });
		expect(res.status).toBe(200);
		expect(await jsonBody<unknown>(res)).toEqual({
			...appPayload,
			loan: {
				id: "loan-9",
				principalCents: 1_200_000,
				installments: { total: 48, paid: 0, overdue: 0 },
			},
		});
	});

	it("loans 404 → loan:null", async () => {
		const { email } = await createUser(ctx);
		const cookie = await loginCookie(ctx, email);
		ctx.downstream = (req) =>
			new URL(req.url).pathname.startsWith("/internal/")
				? jsonResponse(404, { error: { code: "NOT_FOUND", message: "not found" } })
				: jsonResponse(200, appPayload);
		const res = await ctx.app.request(`/api/applications/${appId}`, { headers: { cookie } });
		expect(res.status).toBe(200);
		expect(await jsonBody<unknown>(res)).toEqual({ ...appPayload, loan: null });
	});

	it("other loans failure → 502 with the error envelope", async () => {
		const { email } = await createUser(ctx);
		const cookie = await loginCookie(ctx, email);
		ctx.downstream = (req) =>
			new URL(req.url).pathname.startsWith("/internal/")
				? jsonResponse(500, { error: { code: "INTERNAL_ERROR", message: "boom" } })
				: jsonResponse(200, appPayload);
		const res = await ctx.app.request(`/api/applications/${appId}`, { headers: { cookie } });
		expect(res.status).toBe(502);
		expect((await jsonBody<{ error: { code: string } }>(res)).error.code).toBe("BAD_GATEWAY");
	});

	it("primary 404 passes through; unreachable upstream → 502", async () => {
		const { email } = await createUser(ctx);
		const cookie = await loginCookie(ctx, email);
		ctx.downstream = () =>
			jsonResponse(404, { error: { code: "NOT_FOUND", message: "not found" } });
		const missing = await ctx.app.request(`/api/applications/${appId}`, { headers: { cookie } });
		expect(missing.status).toBe(404);

		ctx.downstream = () => {
			throw new Error("connection refused");
		};
		const down = await ctx.app.request("/api/loans", { headers: { cookie } });
		expect(down.status).toBe(502);
		expect((await jsonBody<{ error: { code: string } }>(down)).error.code).toBe("BAD_GATEWAY");
	});
});

describe("health", () => {
	it("preserves the {status, checks} shape and reports services separately", async () => {
		ctx.downstream = () => jsonResponse(200, { status: "ok", service: "stub", checks: {} });
		const res = await ctx.app.request("/api/health");
		expect(res.status).toBe(200);
		const body = await jsonBody<{
			status: string;
			checks: Record<string, unknown>;
			services: Record<string, { ok: boolean }>;
		}>(res);
		expect(["ok", "degraded"]).toContain(body.status);
		for (const key of ["db", "kafka", "temporal", "outbox"]) {
			expect(body.checks[key]).toBeDefined();
		}
		for (const key of ["applications", "review", "loans", "portfolio"]) {
			expect(body.services[key]).toBeDefined();
			expect(typeof body.services[key].ok).toBe("boolean");
		}
	});
});
