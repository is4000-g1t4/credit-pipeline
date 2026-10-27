// Application detail composition (SPEC §6): the applications payload plus
// `loan` from the loans service (same signed user). 404 on the lookup →
// `loan: null` (no loan booked yet); any other lookup failure → 502.
import { HttpError, internalFetch } from "@credit/service-kit";
import type { Context } from "hono";
import type { GatewayDeps, SessionUser } from "./deps.js";
import { fetchUpstream, forwardResponse, UPSTREAM_TIMEOUT_MS } from "./proxy.js";

/** GET /api/applications/:id: applications payload plus `loan`. */
export async function composeApplicationDetail(
	c: Context,
	deps: GatewayDeps,
	me: SessionUser,
	id: string,
): Promise<Response> {
	const query = new URL(c.req.url).search;
	const requestId = c.get("requestId") as string;
	const upstream = await fetchUpstream(
		deps,
		me,
		"GET",
		{ baseUrl: deps.env.applicationsUrl, path: `/api/applications/${id}` },
		query,
		requestId,
		c,
	);
	if (!upstream.ok) return forwardResponse(c, upstream);
	let data: Record<string, unknown>;
	try {
		data = (await upstream.json()) as Record<string, unknown>;
	} catch {
		throw new HttpError(502, "BAD_GATEWAY", "upstream service unavailable");
	}
	try {
		// Same signed identity the proxy path uses, with the 5s bound —
		// internalFetch maps transport failures to the 502 path below.
		const loanPath = `/internal/loans/by-application/${id}`;
		const loanRes = await internalFetch(deps.env.loansUrl, loanPath, me, {
			secret: deps.env.internalSecret,
			fetchImpl: deps.fetchImpl,
			requestId,
			timeoutMs: UPSTREAM_TIMEOUT_MS,
		});
		if (loanRes.ok) {
			const loanBody = (await loanRes.json()) as {
				loan: Record<string, unknown>;
				installments: unknown;
			};
			data.loan = { ...loanBody.loan, installments: loanBody.installments };
		} else if (loanRes.status === 404) {
			data.loan = null;
		} else {
			throw new HttpError(502, "BAD_GATEWAY", "upstream service unavailable");
		}
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw new HttpError(502, "BAD_GATEWAY", "upstream service unavailable");
	}
	return c.json(data);
}
