// Internal-auth signing/verification: valid round-trip, tampered inputs,
// wrong secret, clock-skew expiry, body-swap rejection, and replay
// rejection — all pure, compose-free.
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import {
	bodySha256Hex,
	CLOCK_SKEW_MS,
	clearReplayCache,
	EMPTY_BODY_SHA256,
	isValidRequestId,
	requireInternal,
	requireOfficer,
	requireRole,
	requireService,
	resolveInternalUser,
	type InternalRole,
	type ServiceVariables,
	signInternalHeaders,
} from "../src/internal.js";
import { HttpError, errorBody } from "../src/http.js";

const SECRET = "test-internal-secret-1234567890abcdef";
const USER = { userId: "user-1", role: "applicant", email: "maria@example.com" };
const REQ = { method: "GET", path: "/api/applications" };

function headers(
	secret: string = SECRET,
	opts: Partial<typeof REQ & typeof USER & { ts: number; body: string; requestId: string }> = {},
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
		body: opts.body,
		requestId: opts.requestId,
	});
}

function resolveInput(signed: Record<string, string>) {
	return {
		method: REQ.method,
		path: REQ.path,
		userId: USER.userId,
		role: USER.role,
		email: USER.email,
		ts: signed["x-internal-ts"],
		signature: signed["x-internal-signature"],
		bodyHash: signed["x-body-sha256"],
		requestId: signed["x-request-id"],
	};
}

function protectedApp(secret: string = SECRET): Hono<{ Variables: ServiceVariables }> {
	const app = new Hono<{ Variables: ServiceVariables }>();
	app.use("/api/*", requireInternal(secret));
	app.get("/api/applications", (c) => c.json({ user: c.var.user }));
	app.post("/api/applications", async (c) =>
		c.json({ user: c.var.user, echo: await c.req.json() }),
	);
	app.onError((err, c) => {
		if (err instanceof HttpError) {
			return c.json(errorBody(err.code, err.message), err.status as 400);
		}
		throw err;
	});
	return app;
}

beforeEach(() => {
	clearReplayCache();
});

describe("bodySha256Hex", () => {
	it("hashes the empty body and matches the signer default", () => {
		expect(bodySha256Hex()).toBe(EMPTY_BODY_SHA256);
		expect(bodySha256Hex(undefined)).toBe(EMPTY_BODY_SHA256);
		expect(EMPTY_BODY_SHA256).toMatch(/^[0-9a-f]{64}$/);
	});

	it("distinguishes bodies byte-for-byte", () => {
		expect(bodySha256Hex("{}")).not.toBe(EMPTY_BODY_SHA256);
		expect(bodySha256Hex("{}")).toBe(bodySha256Hex("{}"));
		expect(bodySha256Hex("{}")).not.toBe(bodySha256Hex("{ }"));
	});
});

describe("resolveInternalUser", () => {
	it("accepts a valid signature", () => {
		const signed = headers(SECRET, { ts: 1_000_000 });
		const user = resolveInternalUser(SECRET, resolveInput(signed), 1_000_000);
		expect(user).toEqual({ id: "user-1", email: "maria@example.com", role: "applicant" });
	});

	it("rejects tampered method/path/user/email/role/timestamp/body/request", () => {
		const signed = headers(SECRET, { ts: 1_000_000 });
		const base = resolveInput(signed);
		expect(resolveInternalUser(SECRET, { ...base, path: "/api/loans" }, 1_000_000)).toBeNull();
		expect(resolveInternalUser(SECRET, { ...base, method: "POST" }, 1_000_000)).toBeNull();
		expect(resolveInternalUser(SECRET, { ...base, userId: "user-2" }, 1_000_000)).toBeNull();
		expect(
			resolveInternalUser(SECRET, { ...base, email: "mallory@example.com" }, 1_000_000),
		).toBeNull();
		const officerSigned = headers(SECRET, { role: "officer", ts: 1_000_000 });
		expect(
			resolveInternalUser(
				SECRET,
				{
					...resolveInput(officerSigned),
					role: "officer",
				},
				1_000_000,
			),
		).not.toBeNull();
		expect(
			resolveInternalUser(SECRET, { ...base, signature: "0".repeat(64) }, 1_000_000),
		).toBeNull();
		expect(resolveInternalUser(SECRET, { ...base, signature: "" }, 1_000_000)).toBeNull();
		// Invalid values fail even when the signature matches (re-signed, so
		// rejection comes from the value check rather than HMAC mismatch).
		const adminSigned = headers(SECRET, { role: "admin", ts: 1_000_000 });
		expect(
			resolveInternalUser(SECRET, { ...resolveInput(adminSigned), role: "admin" }, 1_000_000),
		).toBeNull();
		// Swapped body hash or request id breaks the signature.
		expect(
			resolveInternalUser(SECRET, { ...base, bodyHash: bodySha256Hex("{}") }, 1_000_000),
		).toBeNull();
		expect(resolveInternalUser(SECRET, { ...base, bodyHash: "" }, 1_000_000)).toBeNull();
		for (const requestId of ["", "has space", "x".repeat(65)]) {
			const reSigned = headers(SECRET, { requestId, ts: 1_000_000 });
			expect(resolveInternalUser(SECRET, resolveInput(reSigned), 1_000_000)).toBeNull();
		}
	});

	it("rejects the wrong secret and stale/future timestamps", () => {
		const signed = headers(SECRET, { ts: 1_000_000 });
		const base = resolveInput(signed);
		expect(resolveInternalUser("other-secret", base, 1_000_000)).toBeNull();
		// 5-minute skew: inside passes, outside fails both directions.
		expect(resolveInternalUser(SECRET, base, 1_000_000 + CLOCK_SKEW_MS - 1)).not.toBeNull();
		expect(resolveInternalUser(SECRET, base, 1_000_000 + CLOCK_SKEW_MS + 1)).toBeNull();
		expect(resolveInternalUser(SECRET, base, 1_000_000 - CLOCK_SKEW_MS - 1)).toBeNull();
		expect(resolveInternalUser(SECRET, { ...base, ts: "not-a-number" }, 1_000_000)).toBeNull();
	});

	it("binds the timestamp into the signature", () => {
		const signed = headers(SECRET, { ts: 1_000_000 });
		const base = resolveInput(signed);
		// 1ms later the same signature still verifies.
		expect(resolveInternalUser(SECRET, base, 1_000_001)).not.toBeNull();
		// Presenting a different ts breaks the signature even while fresh.
		expect(resolveInternalUser(SECRET, { ...base, ts: "1000001" }, 1_000_001)).toBeNull();
		// A valid signature outside the skew window is stale.
		expect(resolveInternalUser(SECRET, base, 1_000_000 + CLOCK_SKEW_MS + 1)).toBeNull();
	});

	it("accepts the service role with the same signature semantics", () => {
		const signed = headers(SECRET, {
			userId: "svc-auto",
			role: "service",
			email: "service@example.com",
			ts: 1_000_000,
		});
		const user = resolveInternalUser(
			SECRET,
			{
				method: REQ.method,
				path: REQ.path,
				userId: "svc-auto",
				role: "service",
				email: "service@example.com",
				ts: signed["x-internal-ts"],
				signature: signed["x-internal-signature"],
				bodyHash: signed["x-body-sha256"],
				requestId: signed["x-request-id"],
			},
			1_000_000,
		);
		expect(user).toEqual({ id: "svc-auto", email: "service@example.com", role: "service" });
		// An applicant signature relabelled as service fails verification.
		const relabelled = resolveInput(headers(SECRET, { ts: 1_000_000 }));
		expect(resolveInternalUser(SECRET, { ...relabelled, role: "service" }, 1_000_000)).toBeNull();
	});
});

function serviceApp(secret: string = SECRET): Hono<{ Variables: ServiceVariables }> {
	const app = new Hono<{ Variables: ServiceVariables }>();
	app.use("/internal/*", requireInternal(secret));
	app.use("/internal/*", requireService);
	app.get("/internal/svc", (c) => c.json({ user: c.var.user }));
	app.onError((err, c) => {
		if (err instanceof HttpError) {
			return c.json(errorBody(err.code, err.message), err.status as 400);
		}
		throw err;
	});
	return app;
}

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

	it("accepts a signed POST body and still lets the handler read it", async () => {
		const app = protectedApp();
		const body = JSON.stringify({ hello: "world" });
		const res = await app.request("/api/applications", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...headers(SECRET, { method: "POST", path: "/api/applications", body }),
			},
			body,
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			user: { id: "user-1", email: "maria@example.com", role: "applicant" },
			echo: { hello: "world" },
		});
	});

	it("rejects a swapped body with 401", async () => {
		const app = protectedApp();
		const signed = headers(SECRET, {
			method: "POST",
			path: "/api/applications",
			body: JSON.stringify({ hello: "world" }),
		});
		const swapped = await app.request("/api/applications", {
			method: "POST",
			headers: { "content-type": "application/json", ...signed },
			body: JSON.stringify({ hello: "mallory" }),
		});
		expect(swapped.status).toBe(401);
	});

	it("rejects a missing body hash with 401", async () => {
		const app = protectedApp();
		const signed = headers();
		delete signed["x-body-sha256"];
		const res = await app.request(REQ.path, { headers: signed });
		expect(res.status).toBe(401);
	});

	it("rejects a replayed (requestId, signature) pair with 401", async () => {
		const app = protectedApp();
		const signed = headers();
		const first = await app.request(REQ.path, { headers: signed });
		expect(first.status).toBe(200);
		const replay = await app.request(REQ.path, { headers: signed });
		expect(replay.status).toBe(401);
	});

	it("rejects malformed or oversized request ids with 401", async () => {
		const app = protectedApp();
		// Re-signed with the bad id, so 401 comes from request-id validation
		// rather than HMAC mismatch.
		for (const requestId of ["", "x".repeat(65), "has space", "semi;colon", "<script>"]) {
			const signed = headers(SECRET, { requestId });
			const res = await app.request(REQ.path, { headers: signed });
			expect(res.status).toBe(401);
		}
		// A bounded opaque token still verifies when correctly signed.
		const token = "run-abc_123.~XYZ";
		expect(isValidRequestId(token)).toBe(true);
		const now = Date.now();
		const signed = signInternalHeaders(SECRET, {
			userId: USER.userId,
			role: USER.role,
			email: USER.email,
			method: REQ.method,
			path: REQ.path,
			ts: now,
			requestId: token,
		});
		const res = await app.request(REQ.path, { headers: signed });
		expect(res.status).toBe(200);
	});
});

describe("requireRole / requireOfficer", () => {
	function roleApp(mw: typeof requireOfficer): Hono<{ Variables: ServiceVariables }> {
		const app = new Hono<{ Variables: ServiceVariables }>();
		// Test seam: the `x-test-role` header stands in for the signed user
		// `requireInternal` would set; absent means unauthenticated.
		app.use("/officer/*", async (c, next) => {
			const role = c.req.header("x-test-role");
			if (role) {
				c.set("user", { id: "u-1", email: "u@example.com", role: role as InternalRole });
			}
			await next();
		});
		app.use("/officer/*", mw);
		app.get("/officer/ping", (c) => c.json({ ok: true }));
		app.onError((err, c) => {
			if (err instanceof HttpError) {
				return c.json(errorBody(err.code, err.message), err.status as 400);
			}
			throw err;
		});
		return app;
	}

	it("401s without a user, 403s on role mismatch, passes on match", async () => {
		const app = roleApp(requireOfficer);
		expect(await (await app.request("/officer/ping")).status).toBe(401);
		const forbidden = await app.request("/officer/ping", {
			headers: { "x-test-role": "applicant" },
		});
		expect(forbidden.status).toBe(403);
		expect(await forbidden.json()).toEqual({
			error: { code: "FORBIDDEN", message: "officer role required" },
		});
		const ok = await app.request("/officer/ping", { headers: { "x-test-role": "officer" } });
		expect(ok.status).toBe(200);
	});

	it("requireRole parametrizes the role and message", async () => {
		const app = roleApp(requireRole("service"));
		const officer = await app.request("/officer/ping", {
			headers: { "x-test-role": "officer" },
		});
		expect(officer.status).toBe(403);
		expect(await officer.json()).toEqual({
			error: { code: "FORBIDDEN", message: "service role required" },
		});
		const svc = await app.request("/officer/ping", { headers: { "x-test-role": "service" } });
		expect(svc.status).toBe(200);
		const custom = roleApp(requireRole("officer", "officer only"));
		const res = await custom.request("/officer/ping", {
			headers: { "x-test-role": "applicant" },
		});
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: { code: "FORBIDDEN", message: "officer only" } });
	});
});

describe("requireService middleware", () => {
	it("accepts service, 403s officer/applicant, 401s unsigned", async () => {
		const app = serviceApp();
		const svc = await app.request("/internal/svc", {
			headers: headers(SECRET, {
				userId: "svc-auto",
				role: "service",
				email: "service@example.com",
				path: "/internal/svc",
			}),
		});
		expect(svc.status).toBe(200);
		expect(await svc.json()).toEqual({
			user: { id: "svc-auto", email: "service@example.com", role: "service" },
		});

		const officer = await app.request("/internal/svc", {
			headers: headers(SECRET, { role: "officer", path: "/internal/svc" }),
		});
		expect(officer.status).toBe(403);

		const applicant = await app.request("/internal/svc", {
			headers: headers(SECRET, { path: "/internal/svc" }),
		});
		expect(applicant.status).toBe(403);

		const unsigned = await app.request("/internal/svc");
		expect(unsigned.status).toBe(401);
	});
});
