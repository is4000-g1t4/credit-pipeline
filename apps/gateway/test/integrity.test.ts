// E2/EN-05 gateway proxy: integrity + fraud-review are officer-only and
// forward the exact path/query/body to the applications service with the
// signed identity. Flag-off 404 is enforced by the applications service,
// not the gateway. Compose-free: the shared stub app captures the upstream
// request; a stub db answers the session lookup.
import { describe, expect, it, vi } from "vitest";
import { resolveInternalHeadersForTest } from "./header-check.js";
import { setupStubApp, STUB_INTERNAL_SECRET, type StubRequest } from "./helper.js";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";

// Integrity rides the 50s document bound (scan/OCR run synchronously
// downstream); fraud-review rides the 45s officer-decision bound.
const DOCUMENT_TIMEOUT_MS = 50_000;
const LONG_TIMEOUT_MS = 45_000;

describe("integrity gateway routes", () => {
	it("proxies an officer integrity read with path/query signed and the document timeout", async () => {
		const spy = vi.spyOn(AbortSignal, "timeout");
		const captured: StubRequest[] = [];
		const { app, officers, cookieFor } = setupStubApp(captured);
		const res = await app.request(`/api/applications/${APP_ID}/integrity?status=open`, {
			headers: { cookie: cookieFor(officers[0].id) },
		});
		expect(res.status).toBe(200);
		expect(captured).toHaveLength(1);
		expect(captured[0]?.method).toBe("GET");
		expect(captured[0]?.url).toBe(
			`http://applications.test/api/applications/${APP_ID}/integrity?status=open`,
		);
		expect(
			resolveInternalHeadersForTest(STUB_INTERNAL_SECRET, {
				method: "GET",
				path: `/api/applications/${APP_ID}/integrity`,
				headers: captured[0]?.headers ?? {},
			})?.role,
		).toBe("officer");
		expect(spy).toHaveBeenCalledWith(DOCUMENT_TIMEOUT_MS);
		expect(spy).not.toHaveBeenCalledWith(5_000);
	});

	it("proxies nested integrity paths verbatim", async () => {
		const captured: StubRequest[] = [];
		const { app, officers, cookieFor } = setupStubApp(captured);
		const res = await app.request(`/api/applications/${APP_ID}/integrity/analyses/${RUN_ID}`, {
			headers: { cookie: cookieFor(officers[0].id) },
		});
		expect(res.status).toBe(200);
		expect(captured).toHaveLength(1);
		expect(captured[0]?.url).toBe(
			`http://applications.test/api/applications/${APP_ID}/integrity/analyses/${RUN_ID}`,
		);
	});

	it("rejects applicants and anonymous callers without touching upstream", async () => {
		const captured: StubRequest[] = [];
		const { app, applicant, actAs, cookieFor } = setupStubApp(captured);
		actAs(applicant);
		const res = await app.request(`/api/applications/${APP_ID}/integrity/analyses`, {
			method: "POST",
			headers: { cookie: cookieFor(applicant.id), "content-type": "application/json" },
			body: "{}",
		});
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
		const anon = await app.request(`/api/applications/${APP_ID}/integrity`);
		expect(anon.status).toBe(401);
		expect(((await anon.json()) as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");
		expect(captured).toHaveLength(0);
	});
});

describe("fraud-review gateway routes", () => {
	it("proxies queue + me reads for officers with the long timeout", async () => {
		const spy = vi.spyOn(AbortSignal, "timeout");
		const captured: StubRequest[] = [];
		const { app, officers, cookieFor } = setupStubApp(captured);
		const cookie = cookieFor(officers[0].id);
		const queue = await app.request("/api/fraud-review/queue?status=all", {
			headers: { cookie },
		});
		expect(queue.status).toBe(200);
		const me = await app.request("/api/fraud-review/me", { headers: { cookie } });
		expect(me.status).toBe(200);
		expect(captured.map((c) => `${c.method} ${c.url}`)).toEqual([
			"GET http://applications.test/api/fraud-review/queue?status=all",
			"GET http://applications.test/api/fraud-review/me",
		]);
		for (const req of captured) {
			expect(
				resolveInternalHeadersForTest(STUB_INTERNAL_SECRET, {
					method: "GET",
					path: new URL(req.url).pathname,
					headers: req.headers,
				})?.role,
			).toBe("officer");
		}
		expect(spy).toHaveBeenCalledWith(LONG_TIMEOUT_MS);
		expect(spy).not.toHaveBeenCalledWith(5_000);
	});

	it("proxies duplicate lookup POSTs with the body bound to the signature", async () => {
		const captured: StubRequest[] = [];
		const { app, officers, cookieFor } = setupStubApp(captured);
		const body = JSON.stringify({ sha256: "ab".repeat(32) });
		const res = await app.request("/api/fraud-review/duplicates/lookup", {
			method: "POST",
			headers: { cookie: cookieFor(officers[0].id), "content-type": "application/json" },
			body,
		});
		expect(res.status).toBe(200);
		expect(captured).toHaveLength(1);
		expect(captured[0]?.method).toBe("POST");
		expect(captured[0]?.url).toBe("http://applications.test/api/fraud-review/duplicates/lookup");
		expect(captured[0]?.body).toBe(body);
		expect(
			resolveInternalHeadersForTest(STUB_INTERNAL_SECRET, {
				method: "POST",
				path: "/api/fraud-review/duplicates/lookup",
				headers: captured[0]?.headers ?? {},
				body: captured[0]?.body ?? null,
			})?.role,
		).toBe("officer");
	});

	it("rejects applicants and anonymous callers without touching upstream", async () => {
		const captured: StubRequest[] = [];
		const { app, applicant, actAs, cookieFor } = setupStubApp(captured);
		actAs(applicant);
		const res = await app.request("/api/fraud-review/queue", {
			headers: { cookie: cookieFor(applicant.id) },
		});
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
		const anon = await app.request("/api/fraud-review/duplicates/lookup", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		expect(anon.status).toBe(401);
		expect(captured).toHaveLength(0);
	});
});
