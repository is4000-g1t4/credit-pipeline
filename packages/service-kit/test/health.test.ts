// withTimeout: a never-resolving promise rejects, a fast one passes through.
// checkDb/checkOutbox map success and failure; checkTemporal fails closed;
// createService /health reports degraded when any check fails.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { checkDb, checkOutbox, checkTemporal, withTimeout } from "../src/health.js";
import { createService, type ServiceApp } from "../src/service.js";
import type { Logger } from "../src/logger.js";

const silentLogger = { info: () => {}, error: () => {} } as unknown as Logger;

describe("withTimeout", () => {
	it("rejects a never-resolving promise", async () => {
		await expect(withTimeout(new Promise(() => {}), 10)).rejects.toThrow("timeout");
	});

	it("resolves a fast promise", async () => {
		await expect(withTimeout(Promise.resolve(42), 1000)).resolves.toBe(42);
	});
});

describe("checkDb", () => {
	it("reports ok on a successful ping", async () => {
		expect(await checkDb(async () => {})).toEqual({ ok: true });
	});

	it("fails closed with the error message", async () => {
		expect(
			await checkDb(async () => {
				throw new Error("db down");
			}),
		).toEqual({ ok: false, error: "db down" });
	});
});

describe("checkOutbox", () => {
	it("maps rows to backlog/deadLettered", async () => {
		expect(await checkOutbox(async () => [{ backlog: 3, dead: 1 }])).toEqual({
			ok: true,
			backlog: 3,
			deadLettered: 1,
		});
	});

	it("throw/timeout → {ok:false, backlog:null, deadLettered:null}", async () => {
		expect(
			await checkOutbox(async () => {
				throw new Error("db down");
			}),
		).toEqual({ ok: false, error: "db down", backlog: null, deadLettered: null });
		expect(await checkOutbox(() => new Promise(() => {}))).toEqual({
			ok: false,
			error: "timeout",
			backlog: null,
			deadLettered: null,
		});
	});
});

describe("checkTemporal", () => {
	it("fails closed when unreachable", async () => {
		const result = await checkTemporal("localhost:1");
		expect(result.ok).toBe(false);
	});
});

describe("createService /health", () => {
	it("reports degraded when a check fails", async () => {
		const routes = new Hono<{ Variables: { user: unknown; requestId: string } }>();
		const app: ServiceApp = createService({
			name: "health-test",
			secret: "test-secret-1234567890abcdef12345678",
			logger: silentLogger,
			routes: routes as ServiceApp,
			health: async () => ({
				db: { ok: true },
				outbox: { ok: false, error: "down", backlog: null, deadLettered: null },
			}),
		});
		const res = await app.request("/health");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			status: "degraded",
			service: "health-test",
			checks: {
				db: { ok: true },
				outbox: { ok: false, error: "down", backlog: null, deadLettered: null },
			},
		});
	});
});
