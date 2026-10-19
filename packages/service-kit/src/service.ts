// Service factory: one Hono app per microservice with request logging
// (request id + method/path/status/ms only — never bodies, queries, or PII),
// a JSON body size limit, the typed error envelope (no stacks), a public
// `/health` (`{status, service, checks}`), and internal-auth on
// `/api/*` + `/internal/*`. Mounted `routes` carry `/api/...` paths.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { GatewayError } from "./gateway.js";
import { type HealthChecks } from "./health.js";
import { errorBody, HttpError } from "./http.js";
import { requireInternal, type ServiceVariables } from "./internal.js";
import type { Logger } from "./logger.js";

export type { ServiceVariables };
export type ServiceApp = Hono<{ Variables: ServiceVariables }>;

const MAX_JSON_BYTES = 100_000;

export interface ServiceOptions {
	name: string;
	secret: string;
	logger: Logger;
	routes: ServiceApp;
	health: () => Promise<HealthChecks>;
}

export function createService(opts: ServiceOptions): ServiceApp {
	const app: ServiceApp = new Hono();

	app.use("*", async (c, next) => {
		const start = Date.now();
		const requestId = c.req.header("x-request-id") ?? randomUUID();
		c.set("requestId", requestId);
		c.header("x-request-id", requestId);
		try {
			await next();
		} finally {
			opts.logger.info(
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

	for (const pattern of ["/api/*", "/internal/*"]) {
		app.use(
			pattern,
			bodyLimit({
				maxSize: MAX_JSON_BYTES,
				onError: (c) => c.json(errorBody("BODY_TOO_LARGE", "request body too large"), 413),
			}),
		);
	}

	// Public — bypasses internal auth so orchestrators can probe readiness.
	app.get("/health", async (c) => {
		const checks = await opts.health();
		const ok = Object.values(checks).every((check) => check.ok);
		return c.json({ status: ok ? "ok" : "degraded", service: opts.name, checks });
	});

	const internal = requireInternal(opts.secret);
	app.use("/api/*", internal);
	app.use("/internal/*", internal);

	app.route("/", opts.routes);

	app.notFound((c) => c.json(errorBody("NOT_FOUND", "not found"), 404));
	app.onError((err, c) => {
		if (err instanceof HttpError) {
			return c.json(errorBody(err.code, err.message, err.fields), err.status as 400);
		}
		if (err instanceof GatewayError) {
			return c.json(errorBody(err.code, err.message), err.status as 400);
		}
		opts.logger.error({ err }, "unhandled error");
		return c.json(errorBody("INTERNAL_ERROR", "internal error"), 500);
	});

	return app;
}
