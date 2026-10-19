// Integration setup: real Postgres (compose), fake gateway. Unique users
// per test keep runs deterministic — rows accumulate harmlessly in dev.
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({
	path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

import { randomUUID } from "node:crypto";
import { generateReference } from "@credit/core";
import { createDb, installments, loans } from "@credit/db/loans";
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

export function setupApp(overrides: { demoMode?: boolean } = {}): TestContext {
	// Clone: loadEnv() is the validated singleton, and mutating it would
	// leak demoMode=false into later cases (caught by the age/monitoring test).
	const env = { ...loadEnv(), ...overrides };
	const { db, sql } = createDb(env.databaseUrl);
	const gateway = stubGateway();
	const app = createApp({
		db,
		sql,
		env,
		gateway,
		logger: createLogger("loans-test"),
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

/** One loan + a single scheduled installment, owned by `userId`. The loan
 * row carries denormalised application columns — no application row needed. */
export async function seedLoan(
	ctx: TestContext,
	userId: string,
): Promise<{ applicationId: string; loanId: string; installmentId: string }> {
	const applicationId = randomUUID();
	const [loanRow] = await ctx.db
		.insert(loans)
		.values({
			applicationId,
			applicationReference: generateReference(2026),
			applicantUserId: userId,
			product: "personal_loan",
			principalCents: 1200000,
			termMonths: 48,
			rateBps: 650,
			monthlyPaymentCents: 28458,
			outstandingCents: 1200000,
		})
		.returning({ id: loans.id });
	const [item] = await ctx.db
		.insert(installments)
		.values({
			loanId: loanRow.id,
			number: 1,
			dueDate: "2026-11-19",
			principalCents: 25000,
			interestCents: 3458,
			totalCents: 28458,
		})
		.returning({ id: installments.id });
	return { applicationId, loanId: loanRow.id, installmentId: item.id };
}

export async function teardown(ctx: TestContext): Promise<void> {
	await ctx.sql.end();
}
