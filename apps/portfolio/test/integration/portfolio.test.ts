// Portfolio-service integration (compose Postgres for the feed, fake
// internal fetch for sibling stats): officer-only summary, unsigned 401.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser, setupApp, signed, type TestContext, teardown } from "../helper.js";

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

describe("GET /api/dashboard/summary", () => {
	const path = "/api/dashboard/summary";

	it("returns counts + timing + feed for officers", async () => {
		const officer = createUser("officer");
		ctx.stats = {
			applications: {
				applications: { booked: 2, pending_review: 1 },
				avgDecisionSeconds: 12.5,
				decidedApplications: 2,
			},
			loans: { loans: { active: 2 } },
		};
		const res = await ctx.app.request(path, {
			headers: signed(ctx, officer, "GET", path),
		});
		expect(res.status).toBe(200);
		const body = await jsonBody<{
			applications: Record<string, number>;
			loans: Record<string, number>;
			avgDecisionSeconds: number | null;
			decidedApplications: number;
			recentFeed: unknown[];
		}>(res);
		expect(body.applications).toEqual({ booked: 2, pending_review: 1 });
		expect(body.loans).toEqual({ active: 2 });
		expect(body.avgDecisionSeconds).toBe(12.5);
		expect(body.decidedApplications).toBe(2);
		expect(Array.isArray(body.recentFeed)).toBe(true);
	});

	it("rejects applicants with 403 and unsigned requests with 401", async () => {
		const applicant = createUser();
		const denied = await ctx.app.request(path, {
			headers: signed(ctx, applicant, "GET", path),
		});
		expect(denied.status).toBe(403);

		const unsigned = await ctx.app.request(path);
		expect(unsigned.status).toBe(401);
	});
});

describe("health", () => {
	it("is public and returns the {status, service, checks} shape", async () => {
		const res = await ctx.app.request("/health");
		expect(res.status).toBe(200);
		const body = await jsonBody<{
			status: string;
			service: string;
			checks: Record<string, unknown>;
		}>(res);
		expect(body.service).toBe("portfolio");
		expect(["ok", "degraded"]).toContain(body.status);
		expect(body.checks.db).toBeDefined();
		expect(body.checks.consumer).toBeDefined();
	});
});
