// Dual-secret auth: `/api/*` uses `apiSecret`, `/internal/*` uses
// `internalSecret` (each defaulting to `secret`). A wrong secret on either
// prefix is rejected; each secret is accepted only on its own prefix.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { GatewayError } from "../src/gateway.js";
import { HttpError } from "../src/http.js";
import { clearReplayCache, signInternalHeaders } from "../src/internal.js";
import {
	createService,
	installErrorHandlers,
	JSON_BODY_LIMIT,
	requestLogger,
	UUID_SEGMENT_RE,
	type ServiceApp,
} from "../src/service.js";
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

describe("extracted middleware", () => {
	it("redacts UUID path segments and echoes the request id", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const logger = {
			info: (obj: Record<string, unknown>) => {
				seen.push(obj);
			},
			error: () => {},
		} as unknown as Logger;
		const app: ServiceApp = new Hono();
		app.use("*", requestLogger(logger));
		app.get("/api/loans/:id", (c) => c.json({ ok: true }));
		const id = randomUUID();
		const res = await app.request(`/api/loans/${id}`, { headers: { "x-request-id": "req-1" } });
		expect(res.status).toBe(200);
		expect(res.headers.get("x-request-id")).toBe("req-1");
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			requestId: "req-1",
			method: "GET",
			path: "/api/loans/:id",
			status: 200,
		});
		expect(typeof seen[0]?.["ms"]).toBe("number");
	});

	it("exposes the shared JSON limit and UUID pattern", () => {
		expect(JSON_BODY_LIMIT).toBe(100_000);
		expect("loan 1525c4a6-b02c-4e87-a1e5-95b0bbcd567c here".replace(UUID_SEGMENT_RE, ":id")).toBe(
			"loan :id here",
		);
	});

	it("maps 404/HttpError/GatewayError and 500s unknown errors", async () => {
		const app: ServiceApp = new Hono();
		installErrorHandlers(app, silentLogger);
		app.get("/http", () => {
			throw new HttpError(403, "FORBIDDEN", "nope");
		});
		app.get("/gateway", () => {
			throw new GatewayError(502, "BAD_GATEWAY", "down");
		});
		app.get("/boom", () => {
			throw new Error("boom");
		});
		const missing = await app.request("/nope");
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ error: { code: "NOT_FOUND", message: "not found" } });
		const http = await app.request("/http");
		expect(http.status).toBe(403);
		expect(await http.json()).toEqual({ error: { code: "FORBIDDEN", message: "nope" } });
		const gateway = await app.request("/gateway");
		expect(gateway.status).toBe(502);
		expect(await gateway.json()).toEqual({ error: { code: "BAD_GATEWAY", message: "down" } });
		const boom = await app.request("/boom");
		expect(boom.status).toBe(500);
		expect(await boom.json()).toEqual({
			error: { code: "INTERNAL_ERROR", message: "internal error" },
		});
	});
});
