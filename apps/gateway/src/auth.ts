// Auth (SPEC FR-11.1/11.2/11.4): scrypt verify via @credit/db, HMAC-SHA256
// signed cookie session={userId,exp} (7d, httpOnly, sameSite=lax, host-only
// Path=/ so it survives the Vite proxy), constant-time compare, login
// limiters: 10/min per normalized email + 30/min per IP. The IP cap is
// deliberately loose — the same-origin web proxy shares one peer IP across
// all demo users, so a tight per-IP cap would lock the demo out; the
// per-email cap is the real brute-force guard. Moved verbatim from the
// monolith — the gateway owns the user session; downstream services trust
// the signed internal identity.
// Pure helpers (sign/verify/limiter) are unit-tested.
import { createHmac, timingSafeEqual } from "node:crypto";
import { users } from "@credit/db/auth";
import { verifyPassword } from "@credit/db";
import { HttpError, readJson, zodFields } from "@credit/service-kit";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { GatewayDeps, GatewayVariables, SessionUser } from "./deps.js";
import type { GatewayEnv } from "./env.js";

export const SESSION_COOKIE = "session";
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

/** Client IP for the login limiter: x-forwarded-for, which the Bun server
 * unconditionally overwrites with the real peer address (see server.ts), so
 * a client-supplied value can never reach us. Else "unknown". app.request
 * tests have no transport info, so they share one bucket, same as before. */
function clientIp(c: { req: { header(name: string): string | undefined } } & object): string {
	const forwarded = (c as { req: { header(name: string): string | undefined } }).req
		.header("x-forwarded-for")
		?.split(",")[0]
		?.trim();
	if (forwarded) return forwarded;
	return "unknown";
}

function b64urlEncode(raw: string): string {
	return Buffer.from(raw, "utf8").toString("base64url");
}

function signPayload(payload: string, secret: string): string {
	return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signSession(userId: string, secret: string, now: number = Date.now()): string {
	const payload = b64urlEncode(JSON.stringify({ userId, exp: now + SESSION_TTL_MS }));
	return `${payload}.${signPayload(payload, secret)}`;
}

/** Returns the userId, or null on any tamper/expiry/malformed input. */
export function verifySession(
	value: string,
	secret: string,
	now: number = Date.now(),
): string | null {
	const dot = value.lastIndexOf(".");
	if (dot < 1) return null;
	const payload = value.slice(0, dot);
	const sig = value.slice(dot + 1);
	const expected = signPayload(payload, secret);
	const a = Buffer.from(sig, "utf8");
	const b = Buffer.from(expected, "utf8");
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
	} catch {
		return null;
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		typeof (parsed as { userId?: unknown }).userId !== "string" ||
		typeof (parsed as { exp?: unknown }).exp !== "number"
	) {
		return null;
	}
	const { userId, exp } = parsed as { userId: string; exp: number };
	if (exp <= now) return null;
	return userId;
}

export function parseCookies(header: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of header.split(";")) {
		const eqIdx = part.indexOf("=");
		if (eqIdx < 1) continue;
		out[part.slice(0, eqIdx).trim()] = part.slice(eqIdx + 1).trim();
	}
	return out;
}

export function sessionCookieHeader(value: string, env: GatewayEnv): string {
	// Host-only (no Domain) + Path=/ so the Vite /api proxy keeps sending it.
	// Secure only in production — localhost dev is plain HTTP.
	const parts = [
		`${SESSION_COOKIE}=${value}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		`Max-Age=${SESSION_TTL_MS / 1000}`,
	];
	if (env.nodeEnv === "production") parts.push("Secure");
	return parts.join("; ");
}

export function clearSessionCookieHeader(): string {
	return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// In-memory fixed-window limiter (SPEC FR-11.4). Per-process by design —
// single-node demo scale (SPEC §12.10). Pure clock arg for tests.
export interface RateLimiter {
	check(key: string, now?: number): boolean;
}

export function createRateLimiter(limit: number, windowMs: number): RateLimiter {
	const hits = new Map<string, number[]>();
	let checks = 0;
	const sweep = (now: number) => {
		for (const [key, times] of hits) {
			const recent = times.filter((t) => now - t < windowMs);
			if (recent.length === 0) hits.delete(key);
			else if (recent.length !== times.length) hits.set(key, recent);
		}
	};
	return {
		check(key: string, now: number = Date.now()): boolean {
			// Per-email keys are attacker-controlled; evict expired buckets so
			// the in-memory map stays bounded (demo-grade limiter).
			if (hits.size > 1000 || ++checks % 256 === 0) sweep(now);
			const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
			if (recent.length >= limit) {
				hits.set(key, recent);
				return false;
			}
			recent.push(now);
			hits.set(key, recent);
			return true;
		},
	};
}

async function loadUser(deps: GatewayDeps, userId: string): Promise<SessionUser | null> {
	const rows = await deps.db.select().from(users).where(eq(users.id, userId));
	const row = rows[0];
	if (!row) return null;
	return {
		id: row.id,
		email: row.email,
		fullName: row.fullName,
		role: row.role,
	};
}

export const requireUser = (deps: GatewayDeps) =>
	createMiddleware<{ Variables: GatewayVariables }>(async (c, next) => {
		const cookies = parseCookies(c.req.header("cookie") ?? "");
		const userId = verifySession(cookies[SESSION_COOKIE] ?? "", deps.env.sessionSecret);
		if (!userId) throw new HttpError(401, "UNAUTHENTICATED", "login required");
		const user = await loadUser(deps, userId);
		if (!user) throw new HttpError(401, "UNAUTHENTICATED", "login required");
		c.set("user", user);
		await next();
	});

export const requireOfficer = (deps: GatewayDeps) =>
	createMiddleware<{ Variables: GatewayVariables }>(async (c, next) => {
		const cookies = parseCookies(c.req.header("cookie") ?? "");
		const userId = verifySession(cookies[SESSION_COOKIE] ?? "", deps.env.sessionSecret);
		if (!userId) throw new HttpError(401, "UNAUTHENTICATED", "login required");
		const user = await loadUser(deps, userId);
		if (!user) throw new HttpError(401, "UNAUTHENTICATED", "login required");
		if (user.role !== "officer") {
			throw new HttpError(403, "FORBIDDEN", "officer role required");
		}
		c.set("user", user);
		await next();
	});

const loginSchema = z
	.object({
		email: z.string().email().max(320),
		password: z.string().min(1).max(200),
	})
	.strict();

export function authRoutes(deps: GatewayDeps): Hono<{ Variables: GatewayVariables }> {
	const app = new Hono<{ Variables: GatewayVariables }>();

	app.post("/login", async (c) => {
		const ip = clientIp(c);
		if (!deps.loginLimiter.check(ip)) {
			throw new HttpError(429, "RATE_LIMITED", "too many login attempts");
		}
		const parsed = loginSchema.safeParse(await readJson(c));
		if (!parsed.success) {
			throw new HttpError(400, "VALIDATION_ERROR", "invalid login", zodFields(parsed.error));
		}
		// Per-email guard (normalized): the web proxy shares one peer IP,
		// so this — not the loose IP cap — stops brute-forcing one account.
		if (!deps.loginEmailLimiter.check(parsed.data.email.trim().toLowerCase())) {
			throw new HttpError(429, "RATE_LIMITED", "too many login attempts");
		}
		const rows = await deps.db.select().from(users).where(eq(users.email, parsed.data.email));
		const row = rows[0];
		const ok = row ? await verifyPassword(parsed.data.password, row.passwordHash) : false;
		if (!row || !ok) {
			throw new HttpError(401, "INVALID_CREDENTIALS", "invalid email or password");
		}
		c.header(
			"Set-Cookie",
			sessionCookieHeader(signSession(row.id, deps.env.sessionSecret), deps.env),
		);
		return c.json({
			user: {
				id: row.id,
				email: row.email,
				fullName: row.fullName,
				role: row.role,
			},
		});
	});

	app.post("/logout", (c) => {
		c.header("Set-Cookie", clearSessionCookieHeader());
		return c.json({ ok: true });
	});

	app.get("/me", requireUser(deps), (c) => {
		const user = c.var.user;
		return c.json({
			user: {
				id: user.id,
				email: user.email,
				fullName: user.fullName,
				role: user.role,
			},
			// Lets the web app show/hide officer demo controls (demo
			// endpoints are DEMO_MODE-gated server-side too).
			demoMode: deps.env.demoMode,
		});
	});

	return app;
}
