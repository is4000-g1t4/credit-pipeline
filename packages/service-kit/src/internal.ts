// Internal service-to-service auth: HMAC-SHA256 over
// `${method}\n${path}\n${userId}\n${email}\n${role}\n${ts}\n${bodyHash}\n${requestId}`
// with INTERNAL_SECRET. The gateway (P1b) signs the end-user identity it
// already authenticated; services trust the signed headers, never cookies.
// `path` is the URL pathname exactly as the receiving service sees it in
// `c.req.path` (no query string), `method` upper-cased, `ts` millis since
// epoch. Email is part of the signed message so it cannot be swapped.
// `bodyHash` is hex SHA-256 over the exact request bytes (empty-body hash
// when there is no body); `requestId` binds the signature to one delivery
// and feeds the short in-memory replay cache in `requireInternal`.
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createMiddleware } from "hono/factory";
import { HttpError } from "./http.js";

export const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** A (requestId, signature) pair is rejected on reuse inside this window. */
export const REPLAY_TTL_MS = 10 * 60 * 1000;
const REPLAY_MAX_ENTRIES = 10_000;

/** `x-request-id` is a UUID (what all senders generate) or a bounded
 * opaque token (≤64 chars). Anything else is rejected before verification
 * so oversized ids can never grow the replay key space. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[A-Za-z0-9._~-]{1,64}$/;

export function isValidRequestId(value: string): boolean {
	return UUID_RE.test(value) || TOKEN_RE.test(value);
}

export type InternalRole = "applicant" | "officer" | "service";

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
	bodyHash: string,
	requestId: string,
): string {
	return `${method.toUpperCase()}\n${path}\n${userId}\n${email.toLowerCase()}\n${role}\n${ts}\n${bodyHash}\n${requestId}`;
}

function signature(secret: string, message: string): string {
	return createHmac("sha256", secret).update(message).digest("hex");
}

/** Hex SHA-256 over the exact request bytes; empty-body hash when absent. */
export function bodySha256Hex(body?: string | ArrayBuffer | Uint8Array | null): string {
	const hash = createHash("sha256");
	if (typeof body === "string") {
		hash.update(body, "utf8");
	} else if (body instanceof Uint8Array) {
		hash.update(body);
	} else if (body instanceof ArrayBuffer) {
		hash.update(Buffer.from(body));
	}
	return hash.digest("hex");
}

/** The `x-body-sha256` value for requests without a body (GET/HEAD). */
export const EMPTY_BODY_SHA256 = bodySha256Hex();

export interface SignOptions {
	userId: string;
	role: string;
	email: string;
	method: string;
	path: string;
	ts?: number;
	requestId?: string;
	/** Exact request bytes being sent; omitted (GET/HEAD) signs the empty hash. */
	body?: string | ArrayBuffer | Uint8Array | null;
}

/** Builds the full signed header set for one request. Pure clock arg for tests. */
export function signInternalHeaders(secret: string, opts: SignOptions): Record<string, string> {
	const ts = String(opts.ts ?? Date.now());
	const requestId = opts.requestId ?? randomUUID();
	const bodyHash = bodySha256Hex(opts.body);
	const sig = signature(
		secret,
		canonicalMessage(
			opts.method,
			opts.path,
			opts.userId,
			opts.email,
			opts.role,
			ts,
			bodyHash,
			requestId,
		),
	);
	return {
		"x-user-id": opts.userId,
		"x-user-role": opts.role,
		"x-user-email": opts.email,
		"x-internal-ts": ts,
		"x-internal-signature": sig,
		"x-request-id": requestId,
		"x-body-sha256": bodyHash,
	};
}

/** Short replay cache, keyed by request id + signature. In-memory is fine. */
const seenRequests = new Map<string, number>();

/** Test seam: reset the replay cache between cases. */
export function clearReplayCache(): void {
	seenRequests.clear();
}

function isReplay(key: string, now: number): boolean {
	const at = seenRequests.get(key);
	if (at !== undefined && now - at < REPLAY_TTL_MS) return true;
	if (seenRequests.size >= REPLAY_MAX_ENTRIES) {
		for (const [k, t] of seenRequests) {
			if (now - t >= REPLAY_TTL_MS) seenRequests.delete(k);
		}
		// Sustained volume with no expired entries: evict the oldest
		// (insertion-ordered Map) so the cache stays bounded.
		if (seenRequests.size >= REPLAY_MAX_ENTRIES) {
			const oldest = seenRequests.keys().next();
			if (!oldest.done) seenRequests.delete(oldest.value);
		}
	}
	seenRequests.set(key, now);
	return false;
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
		bodyHash: string;
		requestId: string;
	},
	now: number = Date.now(),
): InternalUser | null {
	if (!input.userId || !input.signature || !input.requestId || !input.bodyHash) return null;
	if (!isValidRequestId(input.requestId)) return null;
	if (input.role !== "applicant" && input.role !== "officer" && input.role !== "service")
		return null;
	const ts = Number(input.ts);
	if (!Number.isFinite(ts) || Math.abs(now - ts) > CLOCK_SKEW_MS) return null;
	const expected = signature(
		secret,
		canonicalMessage(
			input.method,
			input.path,
			input.userId,
			input.email,
			input.role,
			input.ts,
			input.bodyHash,
			input.requestId,
		),
	);
	const a = Buffer.from(input.signature, "utf8");
	const b = Buffer.from(expected, "utf8");
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
	return { id: input.userId, email: input.email, role: input.role as InternalRole };
}

/** Guards routes only automation may call (T00 service grants,
 * research-context). Unsigned callers 401 upstream in `requireInternal`;
 * here any valid signature without the service role is 403. Officer and
 * applicant behavior is unchanged — they are rejected, never accepted. */
export const requireService = createMiddleware<{ Variables: ServiceVariables }>(async (c, next) => {
	const me = c.var.user;
	if (!me) throw new HttpError(401, "UNAUTHENTICATED", "login required");
	if (me.role !== "service") throw new HttpError(403, "FORBIDDEN", "service role required");
	await next();
});
/** Guards routes one role may call: 401 without a signed user, 403 on
 * role mismatch. The default message names the role (`officer` →
 * "officer role required"); pass `message` to override it. */
export const requireRole = (role: InternalRole, message?: string) =>
	createMiddleware<{ Variables: ServiceVariables }>(async (c, next) => {
		const me = c.var.user;
		if (!me) throw new HttpError(401, "UNAUTHENTICATED", "login required");
		if (me.role !== role) throw new HttpError(403, "FORBIDDEN", message ?? `${role} role required`);
		await next();
	});

/** Officer-only routes (review queues, approvals, case reads). */
export const requireOfficer = requireRole("officer");
/** Guards `/api/*` + `/internal/*`; exports the resolved user on context. */
export const requireInternal = (secret: string) =>
	createMiddleware<{ Variables: ServiceVariables }>(async (c, next) => {
		const requestId = c.req.header("x-request-id") ?? "";
		const bodyHash = c.req.header("x-body-sha256") ?? "";
		const user = resolveInternalUser(secret, {
			method: c.req.method,
			path: c.req.path,
			userId: c.req.header("x-user-id") ?? "",
			role: c.req.header("x-user-role") ?? "",
			email: c.req.header("x-user-email") ?? "",
			ts: c.req.header("x-internal-ts") ?? "",
			signature: c.req.header("x-internal-signature") ?? "",
			bodyHash,
			requestId,
		});
		if (!user) throw new HttpError(401, "UNAUTHENTICATED", "invalid internal signature");
		// Verify the hash against the actual bytes (clone: handlers still
		// read the body via readJson). A swapped body fails closed.
		let actual: string;
		try {
			actual = bodySha256Hex(await c.req.raw.clone().arrayBuffer());
		} catch {
			throw new HttpError(401, "UNAUTHENTICATED", "invalid internal signature");
		}
		const x = Buffer.from(actual, "utf8");
		const y = Buffer.from(bodyHash, "utf8");
		if (x.length !== y.length || !timingSafeEqual(x, y)) {
			throw new HttpError(401, "UNAUTHENTICATED", "invalid internal signature");
		}
		if (isReplay(`${requestId}:${c.req.header("x-internal-signature")}`, Date.now())) {
			throw new HttpError(401, "UNAUTHENTICATED", "invalid internal signature");
		}
		c.set("user", user);
		c.set("requestId", requestId);
		await next();
	});
