// Integration setup: real Postgres (compose) is NOT needed by the review
// service — it is stateless. Tests inject a stub gateway plus a fake
// internal fetch standing in for the applications/loans services.
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({
	path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

import { randomUUID } from "node:crypto";
import { createLogger, signInternalHeaders } from "@credit/service-kit";
import { stubGateway, type FakeGateway } from "@credit/service-kit/test";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";

process.env.LOG_LEVEL ??= "silent";

export interface TestUser {
	id: string;
	email: string;
	role: "applicant" | "officer";
}

export interface InternalStub {
	/** GET /internal/review/queue body. */
	queue: { items: unknown[] };
	/** GET /internal/applications/:id/decision by application id. */
	decisions: Map<string, { status: string; decision: unknown }>;
	/** Application ids whose decision probe is 404. */
	missing: Set<string>;
	/** GET /internal/loans/by-application/:id by application id (absent → 404). */
	loans: Map<string, { loan: { id: string } }>;
	calls: string[];
}

export interface TestContext {
	app: ReturnType<typeof createApp>;
	gateway: FakeGateway;
	internal: InternalStub;
	secret: string;
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

export function setupApp(): TestContext {
	const env = loadEnv();
	const gateway = stubGateway();
	const internal: InternalStub = {
		queue: { items: [] },
		decisions: new Map(),
		missing: new Set(),
		loans: new Map(),
		calls: [],
	};
	const fetchImpl = (async (url: string | URL | Request): Promise<Response> => {
		const raw = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
		const path = new URL(raw).pathname;
		internal.calls.push(path);
		if (path === "/internal/review/queue") return jsonResponse(200, internal.queue);
		let match = path.match(/^\/internal\/applications\/([^/]+)\/decision$/);
		if (match) {
			if (internal.missing.has(match[1])) return jsonResponse(404, { error: "not found" });
			return jsonResponse(
				200,
				internal.decisions.get(match[1]) ?? { status: "pending_review", decision: null },
			);
		}
		match = path.match(/^\/internal\/loans\/by-application\/([^/]+)$/);
		if (match) {
			const loan = internal.loans.get(match[1]);
			return loan ? jsonResponse(200, loan) : jsonResponse(404, { error: "not found" });
		}
		return jsonResponse(404, { error: "not found" });
	}) as typeof fetch;
	const app = createApp({
		env,
		gateway,
		logger: createLogger("review-test"),
		fetchImpl,
	});
	return { app, gateway, internal, secret: env.internalSecret };
}

export function createUser(role: "applicant" | "officer" = "applicant"): TestUser {
	return { id: randomUUID(), email: `svc-${randomUUID()}@example.com`, role };
}

/** Signed internal headers for `app.request`, as the P1b gateway would send. */
export function signed(
	ctx: TestContext,
	user: TestUser,
	method: string,
	path: string,
	extra: Record<string, string> = {},
): Record<string, string> {
	return {
		...signInternalHeaders(ctx.secret, {
			userId: user.id,
			role: user.role,
			email: user.email,
			method,
			path,
		}),
		...extra,
	};
}
