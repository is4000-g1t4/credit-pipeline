// Gateway app factory (SPEC §6). Test seam: pass fakes for db/fetchImpl;
// the production server wires the real ones. Middleware: pino request
// logging with a request id (method/path/status/ms only — never bodies,
// queries, or PII), production origin allow-list, JSON body size limit,
// typed error envelope, no stacks.
//
// Routing (paths and query strings preserved; content-type/idempotency-key
// forwarded; upstream status/body passed through):
//   /api/auth/*        local (cookie session owned here)
//   /api/applications*  → applications service (detail composes `loan`)
//   /api/review*        → review service (officer only)
//   /api/loans* + /api/demo* → loans service (demo officer-only + DEMO_MODE)
//   /api/dashboard*     → portfolio service (officer only)
import { randomUUID } from "node:crypto";
import { errorBody, HttpError, signInternalHeaders } from "@credit/service-kit";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { authRoutes, requireOfficer, requireUser } from "./auth.js";
import type { GatewayDeps, GatewayVariables } from "./deps.js";
import { healthRoutes } from "./health.js";
import {
	fetchUpstream,
	forwardResponse,
	LONG_UPSTREAM_TIMEOUT_MS,
	proxyTo,
	UPSTREAM_TIMEOUT_MS,
} from "./proxy.js";

const MAX_JSON_BYTES = 100_000;

type Variables = GatewayVariables;

const requireDemoOfficer = (deps: GatewayDeps) =>
	createMiddleware<{ Variables: Variables }>(async (c, next) => {
		if (!deps.env.demoMode) {
			throw new HttpError(403, "DEMO_MODE_DISABLED", "demo endpoints are disabled");
		}
		await requireOfficer(deps)(c, next);
	});

export function createApp(deps: GatewayDeps): Hono<{ Variables: Variables }> {
	const app = new Hono<{ Variables: Variables }>();

	app.use("*", async (c, next) => {
		const start = Date.now();
		const requestId = c.req.header("x-request-id") ?? randomUUID();
		c.set("requestId", requestId);
		c.header("x-request-id", requestId);
		try {
			await next();
		} finally {
			deps.logger.info(
				{
					requestId,
					method: c.req.method,
					path: c.req.path,
					status: c.res.status,
					ms: Date.now() - start,
				},
				"request",
			);
		}
	});

	// Production origin allow-list (FR-11.6): same-origin Vite proxy only.
	// Skipped outside production so tests and local curl stay simple.
	app.use("*", async (c, next) => {
		if (deps.env.nodeEnv === "production" && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
			if (c.req.header("origin") !== deps.env.webOrigin) {
				throw new HttpError(403, "ORIGIN_FORBIDDEN", "origin not allowed");
			}
		}
		await next();
	});

	app.use(
		"/api/*",
		bodyLimit({
			maxSize: MAX_JSON_BYTES,
			onError: (c) => c.json(errorBody("BODY_TOO_LARGE", "request body too large"), 413),
		}),
	);

	app.route("/api/auth", authRoutes(deps));
	app.route("/api/health", healthRoutes(deps));

	const user = requireUser(deps);
	const officer = requireOfficer(deps);
	const demo = requireDemoOfficer(deps);

	// Submit rate limit (FR-11.4): 5/min/user, enforced before proxying.
	app.post("/api/applications", user, async (c) => {
		const me = c.var.user;
		if (me.role !== "applicant") {
			throw new HttpError(403, "FORBIDDEN", "applicants only");
		}
		if (!deps.submitLimiter.check(me.id)) {
			throw new HttpError(429, "RATE_LIMITED", "too many submissions");
		}
		const key = c.req.header("Idempotency-Key")?.trim();
		if (!key) {
			throw new HttpError(400, "MISSING_IDEMPOTENCY_KEY", "Idempotency-Key header is required");
		}
		return proxyTo(c, deps, me, {
			baseUrl: deps.env.applicationsUrl,
			path: "/api/applications",
		});
	});

	app.get("/api/applications", user, async (c) => {
		return proxyTo(c, deps, c.var.user, {
			baseUrl: deps.env.applicationsUrl,
			path: "/api/applications",
		});
	});

	// Detail composition: the applications payload plus `loan` from the
	// loans service (same signed user). 404 on the lookup → `loan: null`
	// (no loan booked yet); any other lookup failure → 502.
	app.get("/api/applications/:id", user, async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		const query = new URL(c.req.url).search;
		const requestId = c.var.requestId;
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
			const fetchImpl = deps.fetchImpl ?? fetch;
			const loanPath = `/internal/loans/by-application/${id}`;
			const loanRes = await fetchImpl(`${deps.env.loansUrl.replace(/\/$/, "")}${loanPath}`, {
				method: "GET",
				headers: {
					...signInternalHeaders(deps.env.internalSecret, {
						userId: me.id,
						role: me.role,
						email: me.email,
						method: "GET",
						path: loanPath,
						requestId,
					}),
				},
				signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
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
	});

	app.all("/api/review/*", officer, async (c) => {
		const path = new URL(c.req.url).pathname;
		// Officer decisions ride a Temporal update + booking that can exceed
		// the normal 5s proxy bound.
		return proxyTo(
			c,
			deps,
			c.var.user,
			{ baseUrl: deps.env.reviewUrl, path },
			LONG_UPSTREAM_TIMEOUT_MS,
		);
	});

	app.all("/api/loans/*", user, async (c) => {
		const path = new URL(c.req.url).pathname;
		return proxyTo(c, deps, c.var.user, { baseUrl: deps.env.loansUrl, path });
	});

	app.all("/api/demo/*", demo, async (c) => {
		const path = new URL(c.req.url).pathname;
		// Demo age/monitoring waits up to 30s server-side for the sweep.
		return proxyTo(
			c,
			deps,
			c.var.user,
			{ baseUrl: deps.env.loansUrl, path },
			LONG_UPSTREAM_TIMEOUT_MS,
		);
	});

	app.all("/api/dashboard/*", officer, async (c) => {
		const path = new URL(c.req.url).pathname;
		return proxyTo(c, deps, c.var.user, { baseUrl: deps.env.portfolioUrl, path });
	});

	app.notFound((c) => c.json(errorBody("NOT_FOUND", "not found"), 404));
	app.onError((err, c) => {
		if (err instanceof HttpError) {
			return c.json(errorBody(err.code, err.message, err.fields), err.status as 400);
		}
		deps.logger.error({ err }, "unhandled error");
		return c.json(errorBody("INTERNAL_ERROR", "internal error"), 500);
	});

	return app;
}
