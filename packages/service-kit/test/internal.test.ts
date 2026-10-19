// Internal-auth signing/verification: valid round-trip, tampered inputs,
// wrong secret, and clock-skew expiry — all pure, compose-free.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
	CLOCK_SKEW_MS,
	requireInternal,
	resolveInternalUser,
	type ServiceVariables,
	signInternalHeaders,
} from "../src/internal.js";
import { HttpError, errorBody } from "../src/http.js";

const SECRET = "test-internal-secret-1234567890abcdef";
const USER = { userId: "user-1", role: "applicant", email: "maria@example.com" };
const REQ = { method: "GET", path: "/api/applications" };

function headers(
	secret: string = SECRET,
	opts: Partial<typeof REQ & typeof USER & { ts: number }> = {},
) {
	return signInternalHeaders(secret, {
		userId: opts.userId ?? USER.userId,
		role: opts.role ?? USER.role,
		email: opts.email ?? USER.email,
		method: opts.method ?? REQ.method,
		path: opts.path ?? REQ.path,
		// Fresh timestamp by default (the middleware checks clock skew
		// against the real clock); pass an explicit `ts` to test staleness.
		ts: opts.ts ?? Date.now(),
	});
}

function protectedApp(secret: string = SECRET): Hono<{ Variables: ServiceVariables }> {
	const app = new Hono<{ Variables: ServiceVariables }>();
	app.use("/api/*", requireInternal(secret));
	app.get("/api/applications", (c) => c.json({ user: c.var.user }));
	app.onError((err, c) => {
		if (err instanceof HttpError) {
			return c.json(errorBody(err.code, err.message), err.status as 400);
		}
		throw err;
	});
	return app;
}

describe("resolveInternalUser", () => {
	it("accepts a valid signature", () => {
		const signed = headers(SECRET, { ts: 1_000_000 });
		const user = resolveInternalUser(
			SECRET,
			{
				method: REQ.method,
				path: REQ.path,
				userId: USER.userId,
				role: USER.role,
				email: USER.email,
				ts: signed["x-internal-ts"],
				signature: signed["x-internal-signature"],
			},
			1_000_000,
		);
		expect(user).toEqual({ id: "user-1", email: "maria@example.com", role: "applicant" });
	});

	it("rejects tampered method/path/user/email/role/timestamp", () => {
		const signed = headers(SECRET, { ts: 1_000_000 });
		const base = {
			method: REQ.method,
			path: REQ.path,
			userId: USER.userId,
			role: USER.role,
			email: USER.email,
			ts: signed["x-internal-ts"],
			signature: signed["x-internal-signature"],
		};
		expect(resolveInternalUser(SECRET, { ...base, path: "/api/loans" }, 1_000_000)).toBeNull();
		expect(resolveInternalUser(SECRET, { ...base, method: "POST" }, 1_000_000)).toBeNull();
		expect(resolveInternalUser(SECRET, { ...base, userId: "user-2" }, 1_000_000)).toBeNull();
		expect(
			resolveInternalUser(SECRET, { ...base, email: "mallory@example.com" }, 1_000_000),
		).toBeNull();
		expect(
			resolveInternalUser(
				SECRET,
				{
					...base,
					role: "officer",
					signature: headers(SECRET, { role: "officer", ts: 1_000_000 })["x-internal-signature"],
				},
				1_000_000,
			),
		).not.toBeNull();
		expect(
			resolveInternalUser(SECRET, { ...base, signature: "0".repeat(64) }, 1_000_000),
		).toBeNull();
		expect(resolveInternalUser(SECRET, { ...base, signature: "" }, 1_000_000)).toBeNull();
		expect(resolveInternalUser(SECRET, { ...base, role: "admin" }, 1_000_000)).toBeNull();
	});

	it("rejects the wrong secret and stale/future timestamps", () => {
		const signed = headers(SECRET, { ts: 1_000_000 });
		const base = {
			method: REQ.method,
			path: REQ.path,
			userId: USER.userId,
			role: USER.role,
			email: USER.email,
			ts: signed["x-internal-ts"],
			signature: signed["x-internal-signature"],
		};
		expect(resolveInternalUser("other-secret", base, 1_000_000)).toBeNull();
		// 5-minute skew: inside passes, outside fails both directions.
		expect(resolveInternalUser(SECRET, base, 1_000_000 + CLOCK_SKEW_MS - 1)).not.toBeNull();
		expect(resolveInternalUser(SECRET, base, 1_000_000 + CLOCK_SKEW_MS + 1)).toBeNull();
		expect(resolveInternalUser(SECRET, base, 1_000_000 - CLOCK_SKEW_MS - 1)).toBeNull();
		expect(resolveInternalUser(SECRET, { ...base, ts: "not-a-number" }, 1_000_000)).toBeNull();
	});
});

describe("requireInternal middleware", () => {
	it("lets signed requests through and rejects unsigned ones with 401", async () => {
		const app = protectedApp();
		const ok = await app.request(REQ.path, { headers: headers() });
		expect(ok.status).toBe(200);
		expect(await ok.json()).toEqual({
			user: { id: "user-1", email: "maria@example.com", role: "applicant" },
		});

		const unsigned = await app.request(REQ.path);
		expect(unsigned.status).toBe(401);

		const wrongSecret = await app.request(REQ.path, { headers: headers("other-secret") });
		expect(wrongSecret.status).toBe(401);

		const stale = await app.request(REQ.path, { headers: headers(SECRET, { ts: 1 }) });
		expect(stale.status).toBe(401);
	});
});
