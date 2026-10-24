// Shared test helpers: synthetic users, signed internal headers, and stub
// fetch responses — the same shapes the per-app test helpers build by hand.
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { HttpError, errorBody } from "../src/http.js";
import { clearReplayCache, requireInternal, type ServiceVariables } from "../src/internal.js";
import { jsonResponse, signedInternalHeaders, testUser } from "../src/test.js";

const SECRET = "test-helpers-secret-1234567890abcdef";

beforeEach(() => {
	clearReplayCache();
});

describe("testUser", () => {
	it("returns the InternalUser shape with unique ids", () => {
		const officer = testUser("officer");
		expect(officer.role).toBe("officer");
		expect(officer.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
		expect(officer.email).toContain(officer.id);
		expect(testUser("applicant").id).not.toBe(officer.id);
	});

	it("honours id/email overrides", () => {
		expect(testUser("service", { id: "s-1", email: "s@example.com" })).toEqual({
			id: "s-1",
			email: "s@example.com",
			role: "service",
		});
	});
});

describe("signedInternalHeaders", () => {
	function signedApp(): Hono<{ Variables: ServiceVariables }> {
		const app = new Hono<{ Variables: ServiceVariables }>();
		app.use("/api/*", requireInternal(SECRET));
		app.get("/api/ping", (c) => c.json({ user: c.var.user }));
		app.post("/api/echo", async (c) => c.json({ user: c.var.user, echo: await c.req.json() }));
		app.onError((err, c) => {
			if (err instanceof HttpError) {
				return c.json(errorBody(err.code, err.message), err.status as 400);
			}
			throw err;
		});
		return app;
	}

	it("signs a GET the middleware accepts", async () => {
		const app = signedApp();
		const user = testUser("officer");
		const res = await app.request("/api/ping", {
			headers: signedInternalHeaders(SECRET, user, "GET", "/api/ping"),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ user });
	});

	it("signs a body and merges extra headers", async () => {
		const app = signedApp();
		const user = testUser("applicant");
		const body = JSON.stringify({ hello: "world" });
		const res = await app.request("/api/echo", {
			method: "POST",
			headers: signedInternalHeaders(SECRET, user, "POST", "/api/echo", {
				body,
				extra: { "content-type": "application/json" },
			}),
			body,
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ user, echo: { hello: "world" } });
	});
});

describe("jsonResponse", () => {
	it("defaults to 200 and honours an explicit status", async () => {
		const ok = jsonResponse({ items: [] });
		expect(ok.status).toBe(200);
		expect(await ok.json()).toEqual({ items: [] });
		const missing = jsonResponse({ error: { code: "NOT_FOUND", message: "not found" } }, 404);
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ error: { code: "NOT_FOUND", message: "not found" } });
	});
});
