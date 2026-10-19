// Signed service-to-service client for the P1b gateway: builds the internal
// auth headers for `path` (the exact pathname the target service sees in
// `c.req.path` — sign that same string) and issues the fetch.
import { HttpError } from "./http.js";
import { signInternalHeaders } from "./internal.js";

export interface InternalIdentity {
	id: string;
	email: string;
	role: string;
}

export interface InternalFetchInit {
	method?: string;
	body?: unknown;
	headers?: Record<string, string>;
	secret?: string;
	requestId?: string;
	/** Bounded service-to-service timeout (default 5s). */
	timeoutMs?: number;
	/** Injectable fetch (tests pass a fake; production uses global fetch). */
	fetchImpl?: typeof fetch;
}

export async function internalFetch(
	baseUrl: string,
	path: string,
	user: InternalIdentity,
	init: InternalFetchInit = {},
): Promise<Response> {
	const secret = init.secret ?? process.env.INTERNAL_SECRET;
	if (!secret) throw new Error("internalFetch: INTERNAL_SECRET is not set");
	const method = (init.method ?? "GET").toUpperCase();
	const headers: Record<string, string> = {
		...init.headers,
		...signInternalHeaders(secret, {
			userId: user.id,
			role: user.role,
			email: user.email,
			method,
			path,
			...(init.requestId !== undefined ? { requestId: init.requestId } : {}),
		}),
	};
	let body: string | undefined;
	if (init.body !== undefined) {
		body = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
		headers["content-type"] ??= "application/json";
	}
	try {
		return await (init.fetchImpl ?? fetch)(`${baseUrl.replace(/\/$/, "")}${path}`, {
			method,
			headers,
			body,
			signal: AbortSignal.timeout(init.timeoutMs ?? 5_000),
		});
	} catch (err) {
		// Transport failures (including the timeout abort) travel the
		// existing 502 path, never a raw 500 with internals.
		if (err instanceof HttpError) throw err;
		throw new HttpError(502, "BAD_GATEWAY", "upstream service unavailable");
	}
}
