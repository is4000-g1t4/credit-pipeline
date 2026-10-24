// Service factory: one Hono app per microservice with request logging
// (request id + method/path/status/ms only — never bodies, queries, or PII),
// a JSON body size limit, the typed error envelope (no stacks), a public
// `/health` (`{status, service, checks}`), and internal-auth on
// `/api/*` + `/internal/*`. Mounted `routes` carry `/api/...` paths.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { GatewayError } from "./gateway.js";
import { type HealthChecks } from "./health.js";
import { errorBody, HttpError } from "./http.js";
import { requireInternal, type ServiceVariables } from "./internal.js";
import type { Logger } from "./logger.js";

export type { ServiceVariables };
export type ServiceApp = Hono<{ Variables: ServiceVariables }>;

/** Default JSON body cap (100 KB). Services opt into larger per-path
 * limits via `bodyLimitOverrides` (T01 uploads); never the default. */
export const JSON_BODY_LIMIT = 100_000;

/** 10 MB file + multipart overhead (T01 document uploads). Services opt
 * into it per-path via `bodyLimitOverrides`; it is never the default. */
export const MAX_UPLOAD_BYTES = 11_000_000;

export interface BodyLimitOverride {
	/** Exact HTTP method, or every method when omitted. */
	method?: string;
	/** Tested against `c.req.path` (no query string). */
	pathPattern: RegExp;
	maxBytes: number;
}

/** UUID path segments (application/run/officer ids) — redacted in logs. */
export const UUID_SEGMENT_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export interface ServiceOptions {
	name: string;
	secret: string;
	/** HMAC secret for `/api/*` (gateway-signed user identity). Defaults
	 * to `secret` so existing callers keep working. */
	apiSecret?: string;
	/** HMAC secret for `/internal/*`. Defaults to `secret`; the policy
	 * service passes its dedicated `POLICY_INTERNAL_SECRET` here so a
	 * gateway secret alone cannot call internal case routes. */
	internalSecret?: string;
	logger: Logger;
	routes: ServiceApp;
	health: () => Promise<HealthChecks>;
	/** Route-specific body limits (first match wins); default 100 KB. The
	 * service passes its own paths — service-kit hardcodes no domain routes. */
	bodyLimitOverrides?: BodyLimitOverride[];
}

/** Request logging: echoes/sets `x-request-id`, then logs request id +
 * method/redacted path/status/ms — never bodies, queries, or PII. */
export const requestLogger = (logger: Logger) =>
	createMiddleware<{ Variables: ServiceVariables }>(async (c, next) => {
		const start = Date.now();
		const requestId = c.req.header("x-request-id") ?? randomUUID();
		c.set("requestId", requestId);
		c.header("x-request-id", requestId);
		try {
			await next();
		} finally {
			logger.info(
				{
					requestId,
					method: c.req.method,
					// AC-11: paths carry application/run/officer UUIDs —
					// log the shape, never the ids.
					path: c.req.path.replace(UUID_SEGMENT_RE, ":id"),
					status: c.res.status,
					ms: Date.now() - start,
				},
				"request",
			);
		}
	});

/** 404 envelope plus the typed error mapping (no stacks): HttpError and
 * GatewayError keep their code/message, anything else is a 500. */
export function installErrorHandlers(app: ServiceApp, logger: Logger): void {
	app.notFound((c) => c.json(errorBody("NOT_FOUND", "not found"), 404));
	app.onError((err, c) => {
		if (err instanceof HttpError) {
			return c.json(errorBody(err.code, err.message, err.fields), err.status as 400);
		}
		if (err instanceof GatewayError) {
			return c.json(errorBody(err.code, err.message), err.status as 400);
		}
		logger.error({ err }, "unhandled error");
		return c.json(errorBody("INTERNAL_ERROR", "internal error"), 500);
	});
}

export function createService(opts: ServiceOptions): ServiceApp {
	const app: ServiceApp = new Hono();

	app.use("*", requestLogger(opts.logger));

	for (const pattern of ["/api/*", "/internal/*"]) {
		app.use(pattern, async (c, next) => {
			let maxSize = JSON_BODY_LIMIT;
			for (const override of opts.bodyLimitOverrides ?? []) {
				if (override.method !== undefined && override.method !== c.req.method) continue;
				// Global-flag patterns keep match state: reset per request.
				override.pathPattern.lastIndex = 0;
				if (override.pathPattern.test(c.req.path)) {
					maxSize = override.maxBytes;
					break;
				}
			}
			return bodyLimit({
				maxSize,
				onError: (ctx) => ctx.json(errorBody("BODY_TOO_LARGE", "request body too large"), 413),
			})(c, next);
		});
	}

	// Public — bypasses internal auth so orchestrators can probe readiness.
	app.get("/health", async (c) => {
		const checks = await opts.health();
		const ok = Object.values(checks).every((check) => check.ok);
		return c.json({ status: ok ? "ok" : "degraded", service: opts.name, checks });
	});

	const apiAuth = requireInternal(opts.apiSecret ?? opts.secret);
	const internalAuth = requireInternal(opts.internalSecret ?? opts.secret);
	app.use("/api/*", apiAuth);
	app.use("/internal/*", internalAuth);

	app.route("/", opts.routes);

	installErrorHandlers(app, opts.logger);

	return app;
}
