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
//   /api/policy*        → policy service (officer only, per-actor limit,
//                         policy upstream timeout)
import {
	errorBody,
	HttpError,
	installErrorHandlers,
	JSON_BODY_LIMIT,
	MAX_UPLOAD_BYTES,
	requestLogger,
	type ServiceApp,
} from "@credit/service-kit";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { authRoutes, requireOfficer, requireUser } from "./auth.js";
import { composeApplicationDetail } from "./composition.js";
import type { GatewayDeps, GatewayVariables } from "./deps.js";
import { healthRoutes } from "./health.js";
import {
	ASSIST_UPSTREAM_TIMEOUT_MS,
	DOCUMENT_UPSTREAM_TIMEOUT_MS,
	fetchUpstream,
	forwardResponse,
	forwardStreaming,
	LONG_UPSTREAM_TIMEOUT_MS,
	proxyTo,
} from "./proxy.js";

/** T01 document upload: 10 MB file + multipart overhead (SPEC-t01-t02 §3).
 * Every other /api/* route keeps the 100 KB JSON bound. */
const isDocumentUpload = (method: string, path: string): boolean =>
	method === "POST" && /^\/api\/applications\/[^/]+\/documents$/.test(path);

type Variables = GatewayVariables;

/** Submit guard (FR-11.4): applicants only, 5/min/user, Idempotency-Key
 * required. Runs after `user`; preserves the 403 → 429 → 400 order. */
const applicantSubmit = (deps: GatewayDeps) =>
	createMiddleware<{ Variables: Variables }>(async (c, next) => {
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
		await next();
	});

const requireDemoOfficer = (deps: GatewayDeps) =>
	createMiddleware<{ Variables: Variables }>(async (c, next) => {
		if (!deps.env.demoMode) {
			throw new HttpError(403, "DEMO_MODE_DISABLED", "demo endpoints are disabled");
		}
		await requireOfficer(deps)(c, next);
	});

export function createApp(deps: GatewayDeps): Hono<{ Variables: Variables }> {
	const app = new Hono<{ Variables: Variables }>();

	// Shared request logging (id/method/redacted-path/ms only — never
	// bodies, queries, or PII).
	app.use("*", requestLogger(deps.logger));

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

	app.use("/api/*", async (c, next) => {
		const maxSize = isDocumentUpload(c.req.method, c.req.path) ? MAX_UPLOAD_BYTES : JSON_BODY_LIMIT;
		return bodyLimit({
			maxSize,
			onError: (ctx) => ctx.json(errorBody("BODY_TOO_LARGE", "request body too large"), 413),
		})(c, next);
	});

	app.route("/api/auth", authRoutes(deps));
	app.route("/api/health", healthRoutes(deps));

	const user = requireUser(deps);
	const officer = requireOfficer(deps);
	const submit = applicantSubmit(deps);
	const demo = requireDemoOfficer(deps);

	// Submit rate limit (FR-11.4): 5/min/user, enforced before proxying.
	app.post("/api/applications", user, submit, async (c) => {
		return proxyTo(c, deps, c.var.user, {
			baseUrl: deps.env.applicationsUrl,
			path: "/api/applications",
		});
	});

	// T17 intake (SPEC-t17-t18 §2.3): draft create + submit ride the submit
	// limiter and the long timeout (submit starts the workflow); the
	// checklist, consent, and customer reads proxy with the normal bound.
	app.post("/api/applications/drafts", user, submit, async (c) => {
		return proxyTo(
			c,
			deps,
			c.var.user,
			{ baseUrl: deps.env.applicationsUrl, path: "/api/applications/drafts" },
			LONG_UPSTREAM_TIMEOUT_MS,
		);
	});

	app.post("/api/applications/:id/submit", user, submit, async (c) => {
		const path = c.req.path;
		return proxyTo(
			c,
			deps,
			c.var.user,
			{ baseUrl: deps.env.applicationsUrl, path },
			LONG_UPSTREAM_TIMEOUT_MS,
		);
	});

	app.get("/api/applications/:id/requirements", user, async (c) => {
		const path = c.req.path;
		return proxyTo(c, deps, c.var.user, { baseUrl: deps.env.applicationsUrl, path });
	});

	// Draft edit (spec §4): owner-only optimistic PATCH. Same normal bound —
	// no workflow starts.
	app.patch("/api/applications/:id/draft", user, async (c) => {
		const path = c.req.path;
		return proxyTo(c, deps, c.var.user, { baseUrl: deps.env.applicationsUrl, path });
	});

	app.patch("/api/applications/:id/context-consent", user, async (c) => {
		const path = c.req.path;
		return proxyTo(c, deps, c.var.user, { baseUrl: deps.env.applicationsUrl, path });
	});

	app.all("/api/customer/*", user, async (c) => {
		const path = c.req.path;
		return proxyTo(c, deps, c.var.user, { baseUrl: deps.env.applicationsUrl, path });
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
		return composeApplicationDetail(c, deps, c.var.user, c.req.param("id"));
	});

	app.patch("/api/applications/:id/document-consent", user, async (c) => {
		const path = c.req.path;
		return proxyTo(c, deps, c.var.user, { baseUrl: deps.env.applicationsUrl, path });
	});

	// T01 document workflow (SPEC-t01-t02 §3/§5): collection + file/pages/
	// download/retry/crosscheck/chase under one wildcard. Scan+OCR run
	// synchronously downstream, so these ride the 50s document timeout.
	for (const pattern of ["/api/applications/:id/documents", "/api/applications/:id/documents/*"]) {
		app.all(pattern, user, async (c) => {
			const path = c.req.path;
			return proxyTo(
				c,
				deps,
				c.var.user,
				{ baseUrl: deps.env.applicationsUrl, path },
				DOCUMENT_UPSTREAM_TIMEOUT_MS,
			);
		});
	}

	// Case assistant (officer Q&A): same review upstream, the shared per-actor
	// AI limiter (with the policy console), and the long assist timeout
	// (agentic loop). Must sit before the generic /api/review/* proxy below.
	app.post("/api/review/:id/assistant", officer, async (c) => {
		const me = c.var.user;
		if (!deps.policyLimiter.check(me.id)) {
			throw new HttpError(429, "RATE_LIMITED", "too many assistant requests");
		}
		const path = c.req.path;
		const upstream = await fetchUpstream(
			deps,
			me,
			c.req.method,
			{ baseUrl: deps.env.reviewUrl, path },
			new URL(c.req.url).search,
			c.get("requestId") as string,
			c,
			ASSIST_UPSTREAM_TIMEOUT_MS,
		);
		// The Ask panel opts into SSE so tool activity streams; keep the
		// regular JSON path byte-for-byte for every other caller.
		return upstream.headers.get("content-type")?.includes("text/event-stream")
			? forwardStreaming(c, upstream)
			: forwardResponse(c, upstream);
	});

	app.all("/api/review/*", officer, async (c) => {
		const path = c.req.path;
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

	// E2 document integrity (officer only). The applications service owns the
	// flag and the assigned-case check; this proxy only binds identity/path.
	for (const pattern of ["/api/applications/:id/integrity", "/api/applications/:id/integrity/*"]) {
		app.all(pattern, officer, async (c) => {
			const path = c.req.path;
			return proxyTo(
				c,
				deps,
				c.var.user,
				{ baseUrl: deps.env.applicationsUrl, path },
				DOCUMENT_UPSTREAM_TIMEOUT_MS,
			);
		});
	}

	// EN-05 fraud review (officer only). Case-assignment checks live in the
	// applications service; applicants are denied before the upstream call.
	for (const pattern of ["/api/fraud-review", "/api/fraud-review/*"]) {
		app.all(pattern, officer, async (c) => {
			const path = c.req.path;
			return proxyTo(
				c,
				deps,
				c.var.user,
				{ baseUrl: deps.env.applicationsUrl, path },
				LONG_UPSTREAM_TIMEOUT_MS,
			);
		});
	}

	app.all("/api/loans/*", user, async (c) => {
		const path = c.req.path;
		return proxyTo(c, deps, c.var.user, { baseUrl: deps.env.loansUrl, path });
	});

	app.all("/api/demo/*", demo, async (c) => {
		const path = c.req.path;
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
		const path = c.req.path;
		return proxyTo(c, deps, c.var.user, { baseUrl: deps.env.portfolioUrl, path });
	});

	app.all("/api/portfolio/*", officer, async (c) => {
		const path = c.req.path;
		return proxyTo(c, deps, c.var.user, { baseUrl: deps.env.portfolioUrl, path });
	});

	// Policy console (officer only). The 10/min per-actor AI limiter applies
	// only to asks; register/section reads and version writes are not AI
	// calls and keep their own paths.
	app.post("/api/policy/ask", officer, async (c) => {
		const me = c.var.user;
		if (!deps.policyLimiter.check(me.id)) {
			throw new HttpError(429, "RATE_LIMITED", "too many policy requests");
		}
		const path = c.req.path;
		return proxyTo(
			c,
			deps,
			me,
			{ baseUrl: deps.env.policyUrl, path },
			deps.env.policyUpstreamTimeoutMs,
		);
	});

	app.all("/api/policy/*", officer, async (c) => {
		const path = c.req.path;
		return proxyTo(
			c,
			deps,
			c.var.user,
			{ baseUrl: deps.env.policyUrl, path },
			deps.env.policyUpstreamTimeoutMs,
		);
	});

	// EN-01/02/03 case assist (officer only): evidence bundle, generated
	// artifacts, validation. The applications service owns the flag: with
	// ASSIST_ENABLED=false every assist route 404s downstream.
	app.all("/api/assist/*", officer, async (c) => {
		const path = c.req.path;
		return proxyTo(
			c,
			deps,
			c.var.user,
			{ baseUrl: deps.env.applicationsUrl, path },
			ASSIST_UPSTREAM_TIMEOUT_MS,
		);
	});

	// Typed error envelope (no stacks); the health shape, cookie auth, and
	// origin check above stay gateway-specific. The cast bridges
	// GatewayVariables (cookie session) to the signed identity shape —
	// the handlers only touch the status/code/message envelope.
	installErrorHandlers(app as unknown as ServiceApp, deps.logger);

	return app;
}
