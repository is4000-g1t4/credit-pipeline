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
import { createLogger } from "@credit/service-kit";
import {
	signedInternalHeaders,
	stubGateway,
	testUser,
	type FakeGateway,
} from "@credit/service-kit/test";
import { eq } from "drizzle-orm";
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
	/** Mutable stub for the applications binding check (research-context).
	 * Tests swap `.fetch` to simulate consent withdrawal or mismatch. */
	applicationsStub: {
		fetch: (url: string, init: RequestInit) => Promise<Response>;
	};
}

export type ApplicationsFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Default stub: mirrors the real binding check against seeded loan rows —
 * consent true, applicant from the loan with this applicationId, the case
 * as-of as today, 404 for unknown applications. No applications service needed. */
function defaultApplicationsFetch(db: ReturnType<typeof createDb>["db"]): ApplicationsFetch {
	return async (url: string, _init: RequestInit): Promise<Response> => {
		const match = url.match(/\/internal\/applications\/([^/?]+)\/research-context/);
		const rows = match
			? await db
					.select({ applicantUserId: loans.applicantUserId })
					.from(loans)
					.where(eq(loans.applicationId, match[1]))
			: [];
		if (rows.length === 0) return Response.json({}, { status: 404 });
		return Response.json({
			caseFacts: { asOf: new Date().toISOString() },
			contextAnalysisConsent: true,
			applicantUserId: rows[0].applicantUserId,
		});
	};
}

export function setupApp(
	overrides: { demoMode?: boolean; applicationsFetch?: ApplicationsFetch } = {},
): TestContext {
	// Clone: loadEnv() is the validated singleton, and mutating it would
	// leak demoMode=false into later cases (caught by the age/monitoring test).
	const { applicationsFetch, ...envOverrides } = overrides;
	const env = { ...loadEnv(), ...envOverrides };
	const { db, sql } = createDb(env.databaseUrl);
	const gateway = stubGateway();
	const applicationsStub = {
		fetch: applicationsFetch ?? defaultApplicationsFetch(db),
	};
	const app = createApp({
		db,
		sql,
		env,
		gateway,
		logger: createLogger("loans-test"),
		fetchImpl: (url: string, init: RequestInit) => applicationsStub.fetch(url, init),
	});
	return { app, db, sql, gateway, secret: env.internalSecret, applicationsStub };
}

// Identity is signed headers only in this DB (applicant_user_id is a plain
// uuid — no users table here), so test users are synthetic.
export async function createUser(
	_ctx: TestContext,
	role: "applicant" | "officer" = "applicant",
): Promise<TestUser> {
	const base = testUser(role);
	return { id: base.id, email: base.email, role };
}

/** Signed internal headers for `app.request`, as the P1b gateway would send. */
export function signed(
	ctx: TestContext,
	user: TestUser,
	method: string,
	path: string,
	extra: Record<string, string> = {},
	body?: string,
): Record<string, string> {
	return signedInternalHeaders(ctx.secret, user, method, path, { body, extra });
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
