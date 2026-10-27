// Portfolio read integration (compose Postgres): bounded /api/loans paging
// (limit/offset/status, total/nextOffset/truncated) + the officer-only
// /internal/portfolio/summary book aggregates. Rows from other tests share
// the DB, so the summary asserts before/after deltas, not absolute totals.
import { reportingWeekStart } from "@credit/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ewsAlerts, loans } from "@credit/db/loans";
import { eq } from "drizzle-orm";
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

interface LoansPage {
	items: Array<{ id: string; reference: string; status: string; disbursedAt: string }>;
	total: number;
	limit: number;
	offset: number;
	nextOffset: number | null;
	truncated: boolean;
}

interface Summary {
	principalCents: number;
	outstandingCents: number;
	overdueExposureCents: number;
	activeLoans: number;
	overdueLoans: number;
	openAlerts: number;
	alertsTotal: number;
	alertsTruncated: boolean;
	coverageRatio: null;
	series: Array<{ weekStart: string; bookedCents: number }>;
	composition: Array<{ product: string; outstandingCents: number }>;
	alerts: Array<{
		id: string;
		loanId: string;
		reference: string;
		type: string;
		severity: string;
		status: string;
		createdAt: string;
	}>;
}

describe("GET /api/loans paging", () => {
	it("returns the default page shape and walks pages oldest-first-last", async () => {
		const a = await createUser(ctx);
		const now = Date.now();
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) {
			const { loanId } = await seedLoan(ctx, a.id);
			await ctx.db
				.update(loans)
				.set({ disbursedAt: new Date(now - i * 86_400_000) })
				.where(eq(loans.id, loanId));
			ids.push(loanId);
		}
		const path = "/api/loans";

		const first = await ctx.app.request(path, { headers: signed(ctx, a, "GET", path) });
		expect(first.status).toBe(200);
		const page = await jsonBody<LoansPage>(first);
		expect(page.total).toBe(3);
		expect(page.limit).toBe(50);
		expect(page.offset).toBe(0);
		expect(page.nextOffset).toBeNull();
		expect(page.truncated).toBe(false);
		expect(page.items.map((i) => i.id)).toEqual([ids[0], ids[1], ids[2]]);
		expect(page.items[0]).toHaveProperty("reference");

		const capped = await ctx.app.request(`${path}?limit=2`, {
			headers: signed(ctx, a, "GET", path),
		});
		const cappedPage = await jsonBody<LoansPage>(capped);
		expect(cappedPage.items).toHaveLength(2);
		expect(cappedPage.total).toBe(3);
		expect(cappedPage.nextOffset).toBe(2);
		expect(cappedPage.truncated).toBe(true);

		const tail = await ctx.app.request(`${path}?limit=2&offset=2`, {
			headers: signed(ctx, a, "GET", path),
		});
		const tailPage = await jsonBody<LoansPage>(tail);
		expect(tailPage.items.map((i) => i.id)).toEqual([ids[2]]);
		expect(tailPage.nextOffset).toBeNull();
		expect(tailPage.truncated).toBe(false);
	});

	it("validates status/offset/limit", async () => {
		const a = await createUser(ctx);
		const path = "/api/loans";
		const get = (qs: string) =>
			ctx.app.request(`${path}${qs}`, { headers: signed(ctx, a, "GET", path) });

		const badStatus = await get("?status=bogus");
		expect(badStatus.status).toBe(400);
		expect((await jsonBody<{ error: { code: string } }>(badStatus)).error.code).toBe(
			"VALIDATION_ERROR",
		);

		const badOffset = await get("?offset=1001");
		expect(badOffset.status).toBe(400);
		expect((await jsonBody<{ error: { code: string } }>(badOffset)).error.code).toBe(
			"VALIDATION_ERROR",
		);

		const badLimit = await get("?limit=nope");
		expect(badLimit.status).toBe(400);

		const negative = await jsonBody<LoansPage>(await get("?offset=-5"));
		expect(negative.offset).toBe(0);

		const huge = await jsonBody<LoansPage>(await get("?limit=500"));
		expect(huge.limit).toBe(100);
	});

	it("filters by status within the caller's scope", async () => {
		const a = await createUser(ctx);
		const officer = await createUser(ctx, "officer");
		const first = await seedLoan(ctx, a.id);
		const second = await seedLoan(ctx, a.id);
		await ctx.db.update(loans).set({ status: "overdue" }).where(eq(loans.id, first.loanId));
		await ctx.db.update(loans).set({ status: "closed" }).where(eq(loans.id, second.loanId));
		const path = "/api/loans";
		const get = (qs: string, user = a) =>
			ctx.app.request(`${path}${qs}`, { headers: signed(ctx, user, "GET", path) });

		expect((await jsonBody<LoansPage>(await get(""))).total).toBe(2);
		const overdue = await jsonBody<LoansPage>(await get("?status=overdue"));
		expect(overdue.total).toBe(1);
		expect(overdue.items[0]?.id).toBe(first.loanId);
		const closed = await jsonBody<LoansPage>(await get("?status=closed"));
		expect(closed.total).toBe(1);
		expect(closed.items[0]?.id).toBe(second.loanId);
		expect((await jsonBody<LoansPage>(await get("?status=active"))).total).toBe(0);

		// Officers still see across applicants.
		const seen = await jsonBody<LoansPage>(await get("", officer));
		expect(seen.items.map((i) => i.id)).toEqual(
			expect.arrayContaining([first.loanId, second.loanId]),
		);
	});
});

describe("GET /internal/portfolio/summary", () => {
	const path = "/internal/portfolio/summary";

	it("aggregates the current book, excludes closed loans and closed-loan alerts", async () => {
		const officer = await createUser(ctx, "officer");
		const applicant = await createUser(ctx);
		const before = await jsonBody<Summary>(
			await ctx.app.request(path, { headers: signed(ctx, officer, "GET", path) }),
		);

		const now = new Date();
		const active = await seedLoan(ctx, applicant.id);
		const overdue = await seedLoan(ctx, applicant.id);
		const closed = await seedLoan(ctx, applicant.id);
		await ctx.db
			.update(loans)
			.set({
				product: "sme_term_loan",
				principalCents: 5_000_000,
				outstandingCents: 4_000_000,
				status: "active",
				disbursedAt: now,
			})
			.where(eq(loans.id, active.loanId));
		await ctx.db
			.update(loans)
			.set({
				product: "personal_loan",
				principalCents: 2_000_000,
				outstandingCents: 1_500_000,
				status: "overdue",
				disbursedAt: now,
			})
			.where(eq(loans.id, overdue.loanId));
		await ctx.db
			.update(loans)
			.set({
				product: "sme_term_loan",
				principalCents: 9_000_000,
				outstandingCents: 0,
				status: "closed",
				disbursedAt: now,
			})
			.where(eq(loans.id, closed.loanId));
		const [activeAlert] = await ctx.db
			.insert(ewsAlerts)
			.values({
				loanId: active.loanId,
				type: "payment_overdue",
				createdAt: new Date(now.getTime() - 3_600_000),
			})
			.returning({ id: ewsAlerts.id });
		const [overdueAlert] = await ctx.db
			.insert(ewsAlerts)
			.values({ loanId: overdue.loanId, type: "payment_overdue", createdAt: now })
			.returning({ id: ewsAlerts.id });
		// Acknowledged alerts and closed-loan alerts stay out of the list.
		await ctx.db
			.insert(ewsAlerts)
			.values({ loanId: active.loanId, type: "payment_overdue", status: "acknowledged" });
		await ctx.db.insert(ewsAlerts).values({ loanId: closed.loanId, type: "payment_overdue" });

		const after = await jsonBody<Summary>(
			await ctx.app.request(path, { headers: signed(ctx, officer, "GET", path) }),
		);

		// Current book excludes the closed loan; the overdue loan counts in the book.
		expect(after.principalCents - before.principalCents).toBe(7_000_000);
		expect(after.outstandingCents - before.outstandingCents).toBe(5_500_000);
		expect(after.overdueExposureCents - before.overdueExposureCents).toBe(1_500_000);
		expect(after.activeLoans - before.activeLoans).toBe(2);
		expect(after.overdueLoans - before.overdueLoans).toBe(1);
		expect(after.coverageRatio).toBeNull();

		// Composition groups outstanding by product over the current book.
		const outstandingFor = (s: Summary, product: string) =>
			s.composition.find((c) => c.product === product)?.outstandingCents ?? 0;
		expect(outstandingFor(after, "sme_term_loan") - outstandingFor(before, "sme_term_loan")).toBe(
			4_000_000,
		);
		expect(outstandingFor(after, "personal_loan") - outstandingFor(before, "personal_loan")).toBe(
			1_500_000,
		);

		// Series includes the closed loan (booked this week) and stays 12 buckets.
		expect(after.series).toHaveLength(12);
		expect(after.series.map((b) => b.weekStart)).toEqual(
			after.series.map((b) => b.weekStart).sort(),
		);
		const currentWeek = reportingWeekStart(new Date());
		const bookedDelta = (s: Summary) =>
			s.series.find((b) => b.weekStart === currentWeek)?.bookedCents ?? 0;
		expect(bookedDelta(after) - bookedDelta(before)).toBe(16_000_000);

		// Alerts: the two open alerts on current-book loans, newest first;
		// the acknowledged alert and the closed-loan alert are excluded from
		// both the list and the count.
		expect(after.openAlerts - before.openAlerts).toBe(2);
		expect(after.alertsTotal).toBe(after.openAlerts);
		expect(after.alertsTruncated).toBe(after.alertsTotal > after.alerts.length);
		const mine = after.alerts.filter(
			(a) => a.loanId === active.loanId || a.loanId === overdue.loanId,
		);
		expect(mine).toHaveLength(2);
		expect(mine[0]?.id).toBe(overdueAlert?.id);
		expect(mine[1]?.id).toBe(activeAlert?.id);
		expect(mine[0]).toMatchObject({
			loanId: overdue.loanId,
			type: "payment_overdue",
			severity: "medium",
			status: "open",
		});
		expect(mine[0]?.reference).toBeTruthy();
		expect(mine[0]).not.toHaveProperty("details");
		expect(typeof mine[0]?.createdAt).toBe("string");
		expect(after.alerts.some((a) => a.loanId === closed.loanId)).toBe(false);
	});

	it("rejects applicants with 403 and unsigned requests with 401", async () => {
		const applicant = await createUser(ctx);
		const denied = await ctx.app.request(path, { headers: signed(ctx, applicant, "GET", path) });
		expect(denied.status).toBe(403);
		expect((await ctx.app.request(path)).status).toBe(401);
	});
});
