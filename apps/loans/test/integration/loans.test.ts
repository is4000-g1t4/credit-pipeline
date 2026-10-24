// Loans-service integration (compose Postgres, fake gateway): role-scoped
// list/detail, demo pay/age guarded by DEMO_MODE + officer, unsigned 401.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, ewsAlerts, installments, loans } from "@credit/db/loans";
import { and, eq } from "drizzle-orm";
import {
	createUser,
	seedLoan,
	setupApp,
	signed,
	type TestContext,
	type TestUser,
	teardown,
} from "../helper.js";

let ctx: TestContext;

beforeAll(() => {
	ctx = setupApp();
});

afterAll(async () => {
	await teardown(ctx);
});

async function jsonBody<T>(res: Response): Promise<T> {
	return (await res.json()) as T;
}

describe("GET /api/loans", () => {
	it("scopes by role and rejects unsigned requests", async () => {
		const a = await createUser(ctx);
		const b = await createUser(ctx);
		const officer = await createUser(ctx, "officer");
		const { loanId } = await seedLoan(ctx, a.id);
		const path = "/api/loans";

		const own = await ctx.app.request(path, { headers: signed(ctx, a, "GET", path) });
		expect(own.status).toBe(200);
		expect(
			(await jsonBody<{ items: Array<{ id: string }> }>(own)).items.map((i) => i.id),
		).toContain(loanId);

		const other = await ctx.app.request(path, { headers: signed(ctx, b, "GET", path) });
		expect(other.status).toBe(200);
		expect(
			(await jsonBody<{ items: Array<{ id: string }> }>(other)).items.map((i) => i.id),
		).not.toContain(loanId);

		const all = await ctx.app.request(path, { headers: signed(ctx, officer, "GET", path) });
		expect(all.status).toBe(200);
		expect(
			(await jsonBody<{ items: Array<{ id: string }> }>(all)).items.map((i) => i.id),
		).toContain(loanId);

		const unsigned = await ctx.app.request(path);
		expect(unsigned.status).toBe(401);
	});

	it("detail allows owner/officer, 404s cross-applicant reads", async () => {
		const a = await createUser(ctx);
		const b = await createUser(ctx);
		const officer = await createUser(ctx, "officer");
		const { loanId } = await seedLoan(ctx, a.id);
		const path = `/api/loans/${loanId}`;

		const own = await ctx.app.request(path, { headers: signed(ctx, a, "GET", path) });
		expect(own.status).toBe(200);
		expect(await jsonBody<unknown>(own)).toHaveProperty("installments");

		const cross = await ctx.app.request(path, { headers: signed(ctx, b, "GET", path) });
		expect(cross.status).toBe(404);

		const seen = await ctx.app.request(path, { headers: signed(ctx, officer, "GET", path) });
		expect(seen.status).toBe(200);
	});
});

describe("internal loan lookup", () => {
	it("returns the summary + counts for owner and officer, 404 otherwise", async () => {
		const a = await createUser(ctx);
		const b = await createUser(ctx);
		const officer = await createUser(ctx, "officer");
		const { applicationId, loanId } = await seedLoan(ctx, a.id);
		const path = `/internal/loans/by-application/${applicationId}`;

		const own = await ctx.app.request(path, { headers: signed(ctx, a, "GET", path) });
		expect(own.status).toBe(200);
		const body = await jsonBody<{
			loan: { id: string };
			installments: { total: number; paid: number; overdue: number };
		}>(own);
		expect(body.loan.id).toBe(loanId);
		expect(body.installments).toEqual({ total: 1, paid: 0, overdue: 0 });

		const seen = await ctx.app.request(path, { headers: signed(ctx, officer, "GET", path) });
		expect(seen.status).toBe(200);

		const cross = await ctx.app.request(path, { headers: signed(ctx, b, "GET", path) });
		expect(cross.status).toBe(404);

		const unsigned = await ctx.app.request(path);
		expect(unsigned.status).toBe(401);
	});
});

describe("internal loans by applicant", () => {
	// helper.ts only models applicant/officer users; the service identity is
	// the same signed headers with the service role.
	async function serviceUser(): Promise<TestUser> {
		return { ...(await createUser(ctx)), role: "service" } as unknown as TestUser;
	}
	const AS_OF = new Date().toISOString().slice(0, 10);
	function withQuery(userId: string, applicationId: string, asOf: string = AS_OF): string {
		return `/internal/loans/by-applicant/${userId}?applicationId=${applicationId}&asOf=${asOf}`;
	}
	async function auditsFor(applicationId: string): Promise<Array<{ loanCount: unknown }>> {
		const rows = await ctx.db
			.select({ payload: auditLog.payload })
			.from(auditLog)
			.where(and(eq(auditLog.applicationId, applicationId), eq(auditLog.action, "context.read")));
		return rows.map((r) => (r.payload ?? {}) as { loanCount: unknown });
	}
	async function auditActionsFor(applicationId: string): Promise<string[]> {
		const rows = await ctx.db
			.select({ action: auditLog.action })
			.from(auditLog)
			.where(eq(auditLog.applicationId, applicationId));
		return rows.map((r) => r.action);
	}

	it("returns the applicant's loans with installment + open EWS counts", async () => {
		const a = await createUser(ctx);
		const svc = await serviceUser();
		const { applicationId: appId, loanId, installmentId } = await seedLoan(ctx, a.id);
		await ctx.db
			.update(installments)
			.set({ status: "paid" })
			.where(eq(installments.id, installmentId));
		const [overdue] = await ctx.db
			.insert(installments)
			.values([
				{
					loanId,
					number: 2,
					dueDate: "2026-12-19",
					principalCents: 25000,
					interestCents: 3458,
					totalCents: 28458,
					status: "overdue",
				},
				{
					loanId,
					number: 3,
					dueDate: "2027-01-19",
					principalCents: 25000,
					interestCents: 3458,
					totalCents: 28458,
				},
			])
			.returning({ id: installments.id });
		await ctx.db.insert(ewsAlerts).values([
			{ loanId, type: "payment_overdue" },
			{ loanId, type: "payment_overdue", installmentId: overdue.id },
			{ loanId, type: "payment_overdue", status: "acknowledged" },
		]);
		const path = withQuery(a.id, appId);
		const bare = path.split("?")[0];

		const res = await ctx.app.request(path, { headers: signed(ctx, svc, "GET", bare) });
		expect(res.status).toBe(200);
		const body = await jsonBody<{
			loans: Array<{
				id: string;
				installments: { total: number; paid: number; overdue: number };
				ewsOpen: number;
			}>;
		}>(res);
		const found = body.loans.find((l) => l.id === loanId);
		expect(found?.installments).toEqual({ total: 3, paid: 1, overdue: 1 });
		expect(found?.ewsOpen).toBe(2);
		expect(found).not.toHaveProperty("applicantUserId");
		expect(JSON.stringify(body)).not.toContain(a.id);
		// Audit carries route + count only (ids, no content).
		const audits = await auditsFor(appId);
		expect(audits.length).toBeGreaterThan(0);
		expect(audits[audits.length - 1]).toEqual({ route: "loans", loanCount: 1 });
	});

	it("requires applicationId and asOf, and filters disbursedAt <= asOf", async () => {
		const a = await createUser(ctx);
		const svc = await serviceUser();
		const { applicationId: appId, loanId } = await seedLoan(ctx, a.id);
		const bare = `/internal/loans/by-applicant/${a.id}`;

		const missingApp = withQuery(a.id, "");
		expect(
			(await ctx.app.request(missingApp, { headers: signed(ctx, svc, "GET", bare) })).status,
		).toBe(400);

		const badAsOf = `/internal/loans/by-applicant/${a.id}?applicationId=${appId}&asOf=not-a-day`;
		expect(
			(await ctx.app.request(badAsOf, { headers: signed(ctx, svc, "GET", bare) })).status,
		).toBe(400);

		// Disbursed now: a case bound to a past day excludes it.
		const original = ctx.applicationsStub.fetch;
		ctx.applicationsStub.fetch = async () =>
			Response.json({
				caseFacts: { asOf: "2020-05-05T00:00:00.000Z" },
				contextAnalysisConsent: true,
				applicantUserId: a.id,
			});
		try {
			const past = withQuery(a.id, appId, "2020-05-05");
			const pastRes = await ctx.app.request(past, { headers: signed(ctx, svc, "GET", bare) });
			expect(pastRes.status).toBe(200);
			expect((await jsonBody<{ loans: unknown[] }>(pastRes)).loans).toHaveLength(0);
		} finally {
			ctx.applicationsStub.fetch = original;
		}

		// The default binding's case as-of is today: a past caller day
		// mismatches the case and 400s.
		const mismatch = withQuery(a.id, appId, "2020-01-01");
		const mismatchRes = await ctx.app.request(mismatch, {
			headers: signed(ctx, svc, "GET", bare),
		});
		expect(mismatchRes.status).toBe(400);

		const now = withQuery(a.id, appId);
		const nowRes = await ctx.app.request(now, { headers: signed(ctx, svc, "GET", bare) });
		expect(nowRes.status).toBe(200);
		expect(
			(await jsonBody<{ loans: Array<{ id: string }> }>(nowRes)).loans.map((l) => l.id),
		).toContain(loanId);
	});

	it("rejects invalid and future asOf dates", async () => {
		const a = await createUser(ctx);
		const svc = await serviceUser();
		const { applicationId: appId } = await seedLoan(ctx, a.id);
		const bare = `/internal/loans/by-applicant/${a.id}`;

		for (const asOf of ["2026-13-01", "2026-02-30", "2999-01-01"]) {
			const path = withQuery(a.id, appId, asOf);
			const res = await ctx.app.request(path, { headers: signed(ctx, svc, "GET", bare) });
			expect(res.status).toBe(400);
			expect((await jsonBody<{ error: { code: string } }>(res)).error.code).toBe(
				"VALIDATION_ERROR",
			);
		}
	});

	it("binds the read to the calling case: consent and applicant must match", async () => {
		const a = await createUser(ctx);
		const svc = await serviceUser();
		const { applicationId: appId } = await seedLoan(ctx, a.id);
		const before = (await auditsFor(appId)).length;

		// Wrong applicant for a bound application: 404, nothing leaked, a
		// denied audit, and no success audit.
		const stranger = await createUser(ctx);
		const bare = `/internal/loans/by-applicant/${stranger.id}`;
		const cross = await ctx.app.request(withQuery(stranger.id, appId), {
			headers: signed(ctx, svc, "GET", bare),
		});
		expect(cross.status).toBe(404);
		expect(await cross.text()).not.toContain(appId);
		expect((await auditsFor(appId)).length).toBe(before);
		expect(await auditActionsFor(appId)).toContain("context.denied");

		// Consent withdrawn at the applications service: 403, no loan query,
		// a denied audit, and no success audit.
		const original = ctx.applicationsStub.fetch;
		ctx.applicationsStub.fetch = async () =>
			Response.json({ contextAnalysisConsent: false, applicantUserId: a.id });
		try {
			const denied = await ctx.app.request(withQuery(a.id, appId), {
				headers: signed(ctx, svc, "GET", `/internal/loans/by-applicant/${a.id}`),
			});
			expect(denied.status).toBe(403);
			expect((await jsonBody<{ error: { code: string } }>(denied)).error.code).toBe(
				"CONTEXT_CONSENT_REQUIRED",
			);
			expect((await auditsFor(appId)).length).toBe(before);
			expect(await auditActionsFor(appId)).toContain("context.denied");
		} finally {
			ctx.applicationsStub.fetch = original;
		}

		// Unknown application: 404, no audit.
		const unknownId = randomUUID();
		const unknown = await ctx.app.request(withQuery(a.id, unknownId), {
			headers: signed(ctx, svc, "GET", `/internal/loans/by-applicant/${a.id}`),
		});
		expect(unknown.status).toBe(404);
		expect(await auditsFor(unknownId)).toHaveLength(0);
		expect(await auditActionsFor(unknownId)).toHaveLength(0);
	});

	it("rejects an asOf that does not match the case as-of", async () => {
		const a = await createUser(ctx);
		const svc = await serviceUser();
		const { applicationId: appId } = await seedLoan(ctx, a.id);
		const bare = `/internal/loans/by-applicant/${a.id}`;
		const original = ctx.applicationsStub.fetch;
		ctx.applicationsStub.fetch = async () =>
			Response.json({
				caseFacts: { asOf: "2020-05-05T00:00:00.000Z" },
				contextAnalysisConsent: true,
				applicantUserId: a.id,
			});
		try {
			const res = await ctx.app.request(withQuery(a.id, appId), {
				headers: signed(ctx, svc, "GET", bare),
			});
			expect(res.status).toBe(400);
			expect((await jsonBody<{ error: { code: string } }>(res)).error.code).toBe(
				"VALIDATION_ERROR",
			);
		} finally {
			ctx.applicationsStub.fetch = original;
		}
	});

	it("rejects applicant, officer, and unsigned callers", async () => {
		const a = await createUser(ctx);
		const officer = await createUser(ctx, "officer");
		const { applicationId: appId } = await seedLoan(ctx, a.id);
		const path = withQuery(a.id, appId);
		const bare = path.split("?")[0];

		const applicant = await ctx.app.request(path, { headers: signed(ctx, a, "GET", bare) });
		expect(applicant.status).toBe(403);

		const seen = await ctx.app.request(path, { headers: signed(ctx, officer, "GET", bare) });
		expect(seen.status).toBe(403);

		const unsigned = await ctx.app.request(path);
		expect(unsigned.status).toBe(401);
	});

	it("signs the applications binding check as a service", async () => {
		const a = await createUser(ctx);
		const svc = await serviceUser();
		const { applicationId: appId } = await seedLoan(ctx, a.id);
		const original = ctx.applicationsStub.fetch;
		let role: string | undefined;
		ctx.applicationsStub.fetch = async (url, init) => {
			role = (init.headers as Record<string, string> | undefined)?.["x-user-role"];
			return original(url, init);
		};
		try {
			const path = withQuery(a.id, appId);
			const res = await ctx.app.request(path, {
				headers: signed(ctx, svc, "GET", path.split("?")[0] as string),
			});
			expect(res.status).toBe(200);
			expect(role).toBe("service");
		} finally {
			ctx.applicationsStub.fetch = original;
		}
	});

	it("isolates applicants and returns [] when the bound case has no loans", async () => {
		const a = await createUser(ctx);
		const b = await createUser(ctx);
		const svc = await serviceUser();
		const { applicationId: bApp, loanId } = await seedLoan(ctx, b.id);

		// b's case read as a: the binding mismatches, 404, nothing leaked.
		const path = withQuery(a.id, bApp);
		const bare = path.split("?")[0];
		const res = await ctx.app.request(path, { headers: signed(ctx, svc, "GET", bare) });
		expect(res.status).toBe(404);
		expect(await res.text()).not.toContain(loanId);

		// Bound to a loan-free case (stub stands in for the applications
		// service): 200 with no loans.
		const fresh = await createUser(ctx);
		const original = ctx.applicationsStub.fetch;
		ctx.applicationsStub.fetch = async () =>
			Response.json({
				caseFacts: { asOf: new Date().toISOString() },
				contextAnalysisConsent: true,
				applicantUserId: fresh.id,
			});
		try {
			const emptyPath = withQuery(fresh.id, randomUUID());
			const emptyBare = emptyPath.split("?")[0];
			const empty = await ctx.app.request(emptyPath, {
				headers: signed(ctx, svc, "GET", emptyBare),
			});
			expect(empty.status).toBe(200);
			expect(await jsonBody<unknown>(empty)).toEqual({ loans: [] });
		} finally {
			ctx.applicationsStub.fetch = original;
		}
	});

	it("404s invalid UUIDs and caps results at 10", async () => {
		const svc = await serviceUser();
		const badPath = "/internal/loans/by-applicant/not-a-uuid";
		const bad = await ctx.app.request(badPath, { headers: signed(ctx, svc, "GET", badPath) });
		expect(bad.status).toBe(404);
		expect((await jsonBody<{ error: { code: string } }>(bad)).error.code).toBe("NOT_FOUND");

		const a = await createUser(ctx);
		for (let i = 0; i < 11; i++) await seedLoan(ctx, a.id);
		// The seeded rows carry distinct applicationIds; the stub binds them
		// all to this applicant so the cap is what is under test.
		const original = ctx.applicationsStub.fetch;
		ctx.applicationsStub.fetch = async () =>
			Response.json({
				caseFacts: { asOf: new Date().toISOString() },
				contextAnalysisConsent: true,
				applicantUserId: a.id,
			});
		try {
			const path = withQuery(a.id, randomUUID());
			const bare = path.split("?")[0];
			const res = await ctx.app.request(path, { headers: signed(ctx, svc, "GET", bare) });
			expect(res.status).toBe(200);
			expect((await jsonBody<{ loans: unknown[] }>(res)).loans).toHaveLength(10);
		} finally {
			ctx.applicationsStub.fetch = original;
		}
	});
});

describe("demo controls", () => {
	it("pay posts a payment for officers, guarded by DEMO_MODE + role", async () => {
		const a = await createUser(ctx);
		const officer = await createUser(ctx, "officer");
		const { loanId, installmentId } = await seedLoan(ctx, a.id);
		const path = `/api/demo/loans/${loanId}/pay`;
		const body = JSON.stringify({ installmentId });

		const paid = await ctx.app.request(path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...signed(ctx, officer, "POST", path, {}, body),
			},
			body,
		});
		expect(paid.status).toBe(200);
		expect(await jsonBody<unknown>(paid)).toMatchObject({ loanId, status: "closed" });

		// Repaying the same installment is a 409, not a second payment.
		const again = await ctx.app.request(path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...signed(ctx, officer, "POST", path, {}, body),
			},
			body,
		});
		expect(again.status).toBe(409);
		expect((await jsonBody<{ error: { code: string } }>(again)).error.code).toBe("ALREADY_PAID");

		// An installment from another loan is not payable through this loan.
		const stranger = await seedLoan(ctx, a.id);
		const crossBody = JSON.stringify({ installmentId: stranger.installmentId });
		const cross = await ctx.app.request(path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...signed(ctx, officer, "POST", path, {}, crossBody),
			},
			body: crossBody,
		});
		expect(cross.status).toBe(404);

		const applicant = await ctx.app.request(path, {
			method: "POST",
			headers: { "content-type": "application/json", ...signed(ctx, a, "POST", path, {}, body) },
			body,
		});
		expect(applicant.status).toBe(403);

		const unsigned = await ctx.app.request(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		});
		expect(unsigned.status).toBe(401);

		const disabled = setupApp({ demoMode: false });
		try {
			const off = await disabled.app.request(path, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...signed(disabled, officer, "POST", path, {}, body),
				},
				body,
			});
			expect(off.status).toBe(403);
			expect((await jsonBody<{ error: { code: string } }>(off)).error.code).toBe(
				"DEMO_MODE_DISABLED",
			);
		} finally {
			await teardown(disabled);
		}
	});

	it("age shifts due dates and runs monitoring; monitoring/run is officer-only", async () => {
		const a = await createUser(ctx);
		const officer = await createUser(ctx, "officer");
		const applicant = await createUser(ctx);
		const { loanId } = await seedLoan(ctx, a.id);

		const agePath = `/api/demo/loans/${loanId}/age`;
		ctx.gateway.monitoringResult = { markedOverdue: 1, alertsCreated: 1, loansUpdated: 1 };
		const ageBody = JSON.stringify({ days: 40 });
		const aged = await ctx.app.request(agePath, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...signed(ctx, officer, "POST", agePath, {}, ageBody),
			},
			body: ageBody,
		});
		expect(aged.status).toBe(200);
		expect(await jsonBody<unknown>(aged)).toMatchObject({ aged: 1, markedOverdue: 1 });
		// The installment due date actually moved 40 days back (seeded at
		// 2026-11-19), and the loan's next due date followed it.
		const items = await ctx.db
			.select({ dueDate: installments.dueDate })
			.from(installments)
			.where(eq(installments.loanId, loanId));
		expect(items.map((i) => i.dueDate)).toEqual(["2026-10-10"]);
		const [loan] = await ctx.db
			.select({ nextDueDate: loans.nextDueDate })
			.from(loans)
			.where(eq(loans.id, loanId));
		expect(loan?.nextDueDate).toBe("2026-10-10");

		const runPath = "/api/demo/monitoring/run";
		const applicantRun = await ctx.app.request(runPath, {
			method: "POST",
			headers: signed(ctx, applicant, "POST", runPath),
		});
		expect(applicantRun.status).toBe(403);

		const unsigned = await ctx.app.request(runPath, { method: "POST" });
		expect(unsigned.status).toBe(401);
	});
});
