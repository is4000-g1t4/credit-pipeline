// Dual-secret auth: `/api/*` uses `apiSecret`, `/internal/*` uses
// `internalSecret` (each defaulting to `secret`). A wrong secret on either
// prefix is rejected; each secret is accepted only on its own prefix.
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { clearReplayCache, signInternalHeaders } from "../src/internal.js";
import { createService, type ServiceApp } from "../src/service.js";
import type { Logger } from "../src/logger.js";

const API_SECRET = "api-secret-1234567890abcdef12345678";
const INTERNAL_SECRET = "internal-secret-1234567890abcdef12";
const USER = { userId: "officer-1", role: "officer", email: "officer@example.com" };

const silentLogger = {
	info: () => {},
	error: () => {},
} as unknown as Logger;

function dualSecretApp(): ServiceApp {
	const routes = new Hono<{ Variables: { user: unknown; requestId: string } }>();
	routes.get("/api/ping", (c) => c.json({ ok: true }));
	routes.get("/internal/ping", (c) => c.json({ ok: true }));
	return createService({
		name: "dual-secret-test",
		secret: "fallback-secret-that-signs-nothing",
		apiSecret: API_SECRET,
		internalSecret: INTERNAL_SECRET,
		logger: silentLogger,
		routes: routes as ServiceApp,
		health: async () => ({}),
	});
}

function signed(secret: string, path: string): Record<string, string> {
	return signInternalHeaders(secret, {
		userId: USER.userId,
		role: USER.role,
		email: USER.email,
		method: "GET",
		path,
	});
}

beforeEach(() => {
	clearReplayCache();
});

describe("createService dual secrets", () => {
	it("accepts each secret only on its own prefix", async () => {
		const app = dualSecretApp();
		const apiOk = await app.request("/api/ping", { headers: signed(API_SECRET, "/api/ping") });
		expect(apiOk.status).toBe(200);
		const internalOk = await app.request("/internal/ping", {
			headers: signed(INTERNAL_SECRET, "/internal/ping"),
		});
		expect(internalOk.status).toBe(200);
	});

	it("rejects the wrong secret on both prefixes", async () => {
		const app = dualSecretApp();
		const apiWithInternal = await app.request("/api/ping", {
			headers: signed(INTERNAL_SECRET, "/api/ping"),
		});
		expect(apiWithInternal.status).toBe(401);
		const internalWithApi = await app.request("/internal/ping", {
			headers: signed(API_SECRET, "/internal/ping"),
		});
		expect(internalWithApi.status).toBe(401);
	});

	it("keeps single-secret callers working (both prefixes share `secret`)", async () => {
		const routes = new Hono<{ Variables: { user: unknown; requestId: string } }>();
		routes.get("/api/ping", (c) => c.json({ ok: true }));
		routes.get("/internal/ping", (c) => c.json({ ok: true }));
		const app = createService({
			name: "single-secret-test",
			secret: API_SECRET,
			logger: silentLogger,
			routes: routes as ServiceApp,
			health: async () => ({}),
		});
		const api = await app.request("/api/ping", { headers: signed(API_SECRET, "/api/ping") });
		expect(api.status).toBe(200);
		const internal = await app.request("/internal/ping", {
			headers: signed(API_SECRET, "/internal/ping"),
		});
		expect(internal.status).toBe(200);
	});
});
