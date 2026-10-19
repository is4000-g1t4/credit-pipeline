// Integration setup: real Postgres (compose), fake gateway. Unique users
// per test keep runs deterministic — rows accumulate harmlessly in dev.
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({
	path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

import { randomUUID } from "node:crypto";
import { createDb } from "@credit/db";
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

export interface TestContext {
	app: ReturnType<typeof createApp>;
	db: ReturnType<typeof createDb>["db"];
	sql: ReturnType<typeof createDb>["sql"];
	gateway: FakeGateway;
	secret: string;
}

export function setupApp(): TestContext {
	const env = loadEnv();
	const { db, sql } = createDb(env.databaseUrl);
	const gateway = stubGateway();
	const app = createApp({
		db,
		sql,
		env,
		gateway,
		logger: createLogger("applications-test"),
	});
	return { app, db, sql, gateway, secret: env.internalSecret };
}

// Identity is signed headers only in this DB (applicant_user_id is a plain
// uuid — no users table here), so test users are synthetic.
export async function createUser(
	_ctx: TestContext,
	role: "applicant" | "officer" = "applicant",
): Promise<TestUser> {
	const email = `svc-${randomUUID()}@example.com`;
	return { id: randomUUID(), email, role };
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

/** Minimal valid individual application for `email` (must match the identity). */
export function individualPayload(email: string, amountCents = 1200000): Record<string, unknown> {
	return {
		type: "individual",
		product: "personal_loan",
		amountCents,
		termMonths: 48,
		purpose: "svc integration test",
		consents: [true, true, true],
		identity: {
			fullName: "Svc Applicant",
			dob: "1990-05-01",
			nationalId: "SVCTEST01",
			email,
			phone: "+1-555-0100",
			address: "1 Test Street",
		},
		individual: {
			employmentStatus: "employed",
			employerName: "Acme",
			employmentYears: 6,
			monthlyIncomeCents: 420000,
			existingDebtCents: 61000,
			bankRelationshipYears: 3,
		},
	};
}

export async function teardown(ctx: TestContext): Promise<void> {
	await ctx.sql.end();
}
