// Signed reverse proxy to the downstream services. The gateway verifies
// the cookie session (requireUser/requireOfficer in auth.ts), then signs
// the trusted identity with INTERNAL_SECRET (`x-user-id/role/email`,
// `x-internal-ts/signature`, `x-request-id`); services never see cookies.
// Paths and query strings are preserved; content-type and the idempotency
// key are forwarded; the upstream status/body pass through untouched.
// Transport failures become 502 (standard envelope, no stacks).
import { HttpError, signInternalHeaders } from "@credit/service-kit";
import type { Context } from "hono";
import type { FetchImpl, GatewayDeps, SessionUser } from "./deps.js";

export interface ProxyTarget {
	baseUrl: string;
	/** Exact pathname the downstream service sees in `c.req.path` (signed). */
	path: string;
}

/** Bounded gateway→service timeout: a hung service fails the request
 * instead of holding a gateway worker forever. */
export const UPSTREAM_TIMEOUT_MS = 5_000;
/** Long timeout for routes whose downstream work can exceed 5s: demo
 * age/monitoring (the server waits up to 30s) and officer decisions
 * (Temporal update + booking). */
export const LONG_UPSTREAM_TIMEOUT_MS = 45_000;
/** Document uploads run scan+OCR synchronously (≤35s server-side); the
 * proxy bound stays above it with headroom for the encrypted download. */
export const DOCUMENT_UPSTREAM_TIMEOUT_MS = 50_000;
/** Agentic memo generation can run a bounded multi-step tool loop; keep the
 * gateway bound above the applications-side memo timeout. */
export const ASSIST_UPSTREAM_TIMEOUT_MS = 120_000;

function signedHeaders(
	deps: GatewayDeps,
	user: SessionUser,
	method: string,
	path: string,
	requestId: string,
	body?: ArrayBuffer,
): Record<string, string> {
	return signInternalHeaders(deps.env.internalSecret, {
		userId: user.id,
		role: user.role,
		email: user.email,
		method,
		path,
		requestId,
		body,
	});
}

/** Raw upstream fetch: signed identity, preserved query, forwarded body. */
export async function fetchUpstream(
	deps: GatewayDeps,
	user: SessionUser,
	method: string,
	target: ProxyTarget,
	query: string,
	requestId: string,
	c: Context,
	timeoutMs: number = UPSTREAM_TIMEOUT_MS,
): Promise<Response> {
	const fetchImpl: FetchImpl = deps.fetchImpl ?? fetch;
	let body: ArrayBuffer | undefined;
	if (method !== "GET" && method !== "HEAD") {
		const buf = await c.req.arrayBuffer().catch(() => null);
		if (buf && buf.byteLength > 0) body = buf;
	}
	const headers: Record<string, string> = {
		...signedHeaders(deps, user, method, target.path, requestId, body),
	};
	const contentType = c.req.header("content-type");
	if (contentType) headers["content-type"] = contentType;
	const idempotencyKey = c.req.header("Idempotency-Key");
	if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
	try {
		return await fetchImpl(`${target.baseUrl.replace(/\/$/, "")}${target.path}${query}`, {
			method,
			headers,
			body,
			// Bounded so a hung service cannot hold a gateway worker forever;
			// the catch below maps the abort to the standard 502 path. The
			// client disconnect aborts the upstream too (either signal fires).
			signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(timeoutMs)]),
		});
	} catch {
		throw new HttpError(502, "BAD_GATEWAY", "upstream service unavailable");
	}
}

/** Headers a downstream service may set on a proxied response. Anything
 * else (cookies, internal tracing) stays behind the gateway. */
const FORWARDED_HEADERS = [
	"content-type",
	"content-length",
	"content-disposition",
	"cache-control",
	"x-content-type-options",
] as const;

/** Forwards the upstream status/body byte-for-byte: binary-safe
 * (`arrayBuffer`, no text decoding) so PDF/image downloads survive, with
 * only the allowlisted headers preserved. JSON bodies pass through as the
 * same bytes they arrived as. */
export async function forwardResponse(c: Context, upstream: Response): Promise<Response> {
	let bytes: ArrayBuffer;
	try {
		bytes = await upstream.arrayBuffer();
	} catch {
		throw new HttpError(502, "BAD_GATEWAY", "upstream service unavailable");
	}
	const headers: Record<string, string> = {};
	for (const name of FORWARDED_HEADERS) {
		const value = upstream.headers.get(name);
		if (value !== null) headers[name] = value;
	}
	if (headers["content-type"] === undefined) headers["content-type"] = "application/json";
	return c.body(bytes, upstream.status as 200, headers);
}

/** One-shot signed proxy for routes that need no composition. */
export async function proxyTo(
	c: Context,
	deps: GatewayDeps,
	user: SessionUser,
	target: ProxyTarget,
	timeoutMs: number = UPSTREAM_TIMEOUT_MS,
): Promise<Response> {
	const query = new URL(c.req.url).search;
	const requestId = c.get("requestId") as string;
	const upstream = await fetchUpstream(
		deps,
		user,
		c.req.method,
		target,
		query,
		requestId,
		c,
		timeoutMs,
	);
	return forwardResponse(c, upstream);
}
