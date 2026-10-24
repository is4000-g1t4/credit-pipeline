// Policy gateway proxy (officer-only): every /api/policy/* path proxies
// unchanged to the policy service under the long ask timeout, behind a
// per-actor limiter. Compose-free: the shared stub app captures the
// upstream request; a stub db answers the session lookup.
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveInternalHeadersForTest } from "./header-check.js";
import { setupStubApp, STUB_INTERNAL_SECRET, type StubRequest } from "./helper.js";

const POLICY_TIMEOUT_MS = 60_000;

afterEach(() => {
	vi.restoreAllMocks();
});

describe("policy gateway routes", () => {
	it("proxies ask for officers with path/query/body signed and the long timeout", async () => {
		const spy = vi.spyOn(AbortSignal, "timeout");
		const captured: StubRequest[] = [];
		const { app, officers, cookieFor } = setupStubApp(captured);
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
		expect(captured[0].body).toBe(body);
		expect(
			resolveInternalHeadersForTest(STUB_INTERNAL_SECRET, {
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
		const captured: StubRequest[] = [];
		const { app, applicant, actAs, cookieFor } = setupStubApp(captured);
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
		const captured: StubRequest[] = [];
		const { app, officers, actAs, cookieFor } = setupStubApp(captured, { policyLimit: 2 });
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
		expect(((await limited.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
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
		const captured: StubRequest[] = [];
		const { app, officers, cookieFor } = setupStubApp(captured);
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
