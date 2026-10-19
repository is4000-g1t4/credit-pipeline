// Loans-service integration (compose Postgres, fake gateway): role-scoped
// list/detail, demo pay/age guarded by DEMO_MODE + officer, unsigned 401.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser, seedLoan, setupApp, signed, type TestContext, teardown } from "../helper.js";

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

describe("demo controls", () => {
	it("pay posts a payment for officers, guarded by DEMO_MODE + role", async () => {
		const a = await createUser(ctx);
		const officer = await createUser(ctx, "officer");
		const { loanId, installmentId } = await seedLoan(ctx, a.id);
		const path = `/api/demo/loans/${loanId}/pay`;
		const body = JSON.stringify({ installmentId });

		const paid = await ctx.app.request(path, {
			method: "POST",
			headers: { "content-type": "application/json", ...signed(ctx, officer, "POST", path) },
			body,
		});
		expect(paid.status).toBe(200);
		expect(await jsonBody<unknown>(paid)).toMatchObject({ loanId, status: "closed" });

		const applicant = await ctx.app.request(path, {
			method: "POST",
			headers: { "content-type": "application/json", ...signed(ctx, a, "POST", path) },
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
					...signed(disabled, officer, "POST", path),
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
		const aged = await ctx.app.request(agePath, {
			method: "POST",
			headers: { "content-type": "application/json", ...signed(ctx, officer, "POST", agePath) },
			body: JSON.stringify({ days: 40 }),
		});
		expect(aged.status).toBe(200);
		expect(await jsonBody<unknown>(aged)).toMatchObject({ aged: 1, markedOverdue: 1 });

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
