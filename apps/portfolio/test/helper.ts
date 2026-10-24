// Integration setup: real Postgres (compose) for the read model, fake
// internal fetch for the sibling stats endpoints. Identity is signed
// headers only — test users are synthetic.
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({
	path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

import { createDb } from "@credit/db";
import { createLogger } from "@credit/service-kit";
import { jsonResponse, signedInternalHeaders, testUser } from "@credit/service-kit/test";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";

process.env.LOG_LEVEL ??= "silent";

export interface TestUser {
	id: string;
	email: string;
	role: "applicant" | "officer";
}

export interface StatsStub {
	applications: {
		applications: Record<string, number>;
		avgDecisionSeconds: number | null;
		decidedApplications: number;
	};
	loans: { loans: Record<string, number> };
}

export interface TestContext {
	app: ReturnType<typeof createApp>;
	db: ReturnType<typeof createDb>["db"];
	sql: ReturnType<typeof createDb>["sql"];
	stats: StatsStub;
	secret: string;
}

export function setupApp(): TestContext {
	const env = loadEnv();
	const { db, sql } = createDb(env.databaseUrl);
	const ctx: TestContext = {
		app: undefined as never,
		db,
		sql,
		stats: {
			applications: { applications: {}, avgDecisionSeconds: null, decidedApplications: 0 },
			loans: { loans: {} },
		},
		secret: env.internalSecret,
	};
	const fetchImpl = (async (url: string | URL | Request): Promise<Response> => {
		const raw = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
		const path = new URL(raw).pathname;
		if (path === "/internal/stats") {
			return raw.includes("4001") || raw.includes("applications")
				? jsonResponse(ctx.stats.applications, 200)
				: jsonResponse(ctx.stats.loans, 200);
		}
		return jsonResponse({ error: "not found" }, 404);
	}) as typeof fetch;
	ctx.app = createApp({
		db,
		sql,
		env,
		logger: createLogger("portfolio-test"),
		fetchImpl,
	});
	return ctx;
}

export function createUser(role: "applicant" | "officer" = "applicant"): TestUser {
	const base = testUser(role);
	return { id: base.id, email: base.email, role };
}

/** Signed internal headers for `app.request`, as the P1b gateway would send. */
export function signed(
	ctx: TestContext,
	user: TestUser,
	method: string,
	path: string,
	body?: string,
): Record<string, string> {
	return signedInternalHeaders(ctx.secret, user, method, path, { body });
}

export async function teardown(ctx: TestContext): Promise<void> {
	await ctx.sql.end();
}
