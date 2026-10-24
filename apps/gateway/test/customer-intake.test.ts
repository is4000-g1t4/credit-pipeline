// T17 gateway proxy routes (compose-free): drafts/submit ride the submit
// limiter + long timeout, requirements/consent/customer proxy through, and
// the existing documents wildcard still covers reuse. The stub app captures
// the upstream request; tests assert the forwarded bodies, not just the
// paths.
import { describe, expect, it } from "vitest";
import { resolveInternalHeadersForTest } from "./header-check.js";
import { setupStubApp, STUB_INTERNAL_SECRET, type StubRequest } from "./helper.js";

describe("T17 gateway routes", () => {
	it("proxies drafts with the idempotency key and body preserved", async () => {
		const captured: StubRequest[] = [];
		const { app, applicant, actAs, cookieFor } = setupStubApp(captured);
		actAs(applicant);
		const sent = JSON.stringify({ type: "individual" });
		const res = await app.request("/api/applications/drafts", {
			method: "POST",
			headers: {
				cookie: cookieFor(applicant.id),
				"content-type": "application/json",
				"Idempotency-Key": "draft-key-1",
			},
			body: sent,
		});
		expect(res.status).toBe(200);
		expect(captured).toHaveLength(1);
		expect(captured[0].method).toBe("POST");
		expect(captured[0].url).toBe("http://applications.test/api/applications/drafts");
		expect(captured[0].headers["idempotency-key"]).toBe("draft-key-1");
		expect(captured[0].body).toBe(sent);
		expect(
			resolveInternalHeadersForTest(STUB_INTERNAL_SECRET, {
				method: "POST",
				path: "/api/applications/drafts",
				headers: captured[0].headers,
				body: captured[0].body,
			})?.role,
		).toBe("applicant");
	});

	it("requires the idempotency key on create, drafts and submit", async () => {
		const captured: StubRequest[] = [];
		const { app, applicant, actAs, cookieFor } = setupStubApp(captured);
		actAs(applicant);
		const id = "22222222-2222-4222-8222-222222222222";
		for (const init of [
			{ path: "/api/applications", method: "POST" },
			{ path: "/api/applications/drafts", method: "POST" },
			{ path: `/api/applications/${id}/submit`, method: "POST" },
		] as const) {
			const res = await app.request(init.path, {
				method: init.method,
				headers: { cookie: cookieFor(applicant.id), "content-type": "application/json" },
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
		const captured: StubRequest[] = [];
		const { app, applicant, actAs, cookieFor } = setupStubApp(captured);
		actAs(applicant);
		for (let i = 0; i < 5; i++) {
			const res = await app.request("/api/applications/drafts", {
				method: "POST",
				headers: {
					cookie: cookieFor(applicant.id),
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
				cookie: cookieFor(applicant.id),
				"content-type": "application/json",
				"Idempotency-Key": "k-5",
			},
			body: "{}",
		});
		expect(limited.status).toBe(429);
		expect(captured).toHaveLength(5);
	});

	it("proxies submit/requirements/context-consent/customer paths with bodies untouched", async () => {
		const captured: StubRequest[] = [];
		const { app, applicant, actAs, cookieFor } = setupStubApp(captured);
		actAs(applicant);
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
					cookie: cookieFor(applicant.id),
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
		// Bodies ride through byte-for-byte, including the reuse payload.
		expect(captured.map((c) => c.body)).toEqual([
			"{}",
			null,
			'{"consent":true}',
			null,
			null,
			'{"a":1}',
		]);
		for (const entry of captured) {
			expect(entry.url.startsWith("http://applications.test")).toBe(true);
		}
	});

	it("rejects unauthenticated customer reads", async () => {
		const captured: StubRequest[] = [];
		const { app } = setupStubApp(captured);
		const res = await app.request("/api/customer/profile");
		expect(res.status).toBe(401);
		expect(captured).toHaveLength(0);
	});
});
