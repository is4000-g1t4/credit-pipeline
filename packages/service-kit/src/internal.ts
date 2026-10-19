// Internal service-to-service auth: HMAC-SHA256 over
// `${method}\n${path}\n${userId}\n${email}\n${role}\n${ts}` with INTERNAL_SECRET.
// The gateway (P1b) signs the end-user identity it already authenticated;
// services trust the signed headers, never cookies. `path` is the URL
// pathname exactly as the receiving service sees it in `c.req.path`
// (no query string), `method` upper-cased, `ts` millis since epoch.
// Email is part of the signed message so it cannot be swapped.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createMiddleware } from "hono/factory";
import { HttpError } from "./http.js";

export const CLOCK_SKEW_MS = 5 * 60 * 1000;

export type InternalRole = "applicant" | "officer";

export interface InternalUser {
	id: string;
	email: string;
	role: InternalRole;
}

export interface ServiceVariables {
	user: InternalUser;
	requestId: string;
}

function canonicalMessage(
	method: string,
	path: string,
	userId: string,
	email: string,
	role: string,
	ts: string,
): string {
	return `${method.toUpperCase()}\n${path}\n${userId}\n${email.toLowerCase()}\n${role}\n${ts}`;
}

function signature(secret: string, message: string): string {
	return createHmac("sha256", secret).update(message).digest("hex");
}

export interface SignOptions {
	userId: string;
	role: string;
	email: string;
	method: string;
	path: string;
	ts?: number;
	requestId?: string;
}

/** Builds the full signed header set for one request. Pure clock arg for tests. */
export function signInternalHeaders(secret: string, opts: SignOptions): Record<string, string> {
	const ts = String(opts.ts ?? Date.now());
	const sig = signature(
		secret,
		canonicalMessage(opts.method, opts.path, opts.userId, opts.email, opts.role, ts),
	);
	return {
		"x-user-id": opts.userId,
		"x-user-role": opts.role,
		"x-user-email": opts.email,
		"x-internal-ts": ts,
		"x-internal-signature": sig,
		"x-request-id": opts.requestId ?? randomUUID(),
	};
}

/** Returns the trusted user, or null on any missing/tampered/stale input. */
export function resolveInternalUser(
	secret: string,
	input: {
		method: string;
		path: string;
		userId: string;
		role: string;
		email: string;
		ts: string;
		signature: string;
	},
	now: number = Date.now(),
): InternalUser | null {
	if (!input.userId || !input.signature) return null;
	if (input.role !== "applicant" && input.role !== "officer") return null;
	const ts = Number(input.ts);
	if (!Number.isFinite(ts) || Math.abs(now - ts) > CLOCK_SKEW_MS) return null;
	const expected = signature(
		secret,
		canonicalMessage(input.method, input.path, input.userId, input.email, input.role, input.ts),
	);
	const a = Buffer.from(input.signature, "utf8");
	const b = Buffer.from(expected, "utf8");
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
	return { id: input.userId, email: input.email, role: input.role };
}

/** Guards `/api/*` + `/internal/*`; exports the resolved user on context. */
export const requireInternal = (secret: string) =>
	createMiddleware<{ Variables: ServiceVariables }>(async (c, next) => {
		const user = resolveInternalUser(secret, {
			method: c.req.method,
			path: c.req.path,
			userId: c.req.header("x-user-id") ?? "",
			role: c.req.header("x-user-role") ?? "",
			email: c.req.header("x-user-email") ?? "",
			ts: c.req.header("x-internal-ts") ?? "",
			signature: c.req.header("x-internal-signature") ?? "",
		});
		if (!user) throw new HttpError(401, "UNAUTHENTICATED", "invalid internal signature");
		c.set("user", user);
		c.set("requestId", c.req.header("x-request-id") ?? randomUUID());
		await next();
	});
