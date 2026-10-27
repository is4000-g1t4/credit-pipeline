// dashboardRoutes unit test (compose-free): decisionsToday passthrough on
// /api/dashboard/summary + the /api/portfolio/summary proxy to loans.
// Sibling services are stubbed via fetchImpl; the feed read uses a fake db.
import { createDb } from "@credit/db";
import { createLogger } from "@credit/service-kit";
import { signedInternalHeaders, testUser } from "@credit/service-kit/test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

type Db = ReturnType<typeof createDb>["db"];

const SECRET = "test-internal-secret";
const OFFICER = { ...testUser("officer"), role: "officer" as const };
const APPLICANT = { ...testUser("applicant"), role: "applicant" as const };

interface Stub {
	apps: unknown;
	loansStats: unknown;
	loansSummary: unknown;
	loansSummaryStatus: number;
}

function setup(stub: Stub) {
	const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
		const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (raw.startsWith("http://applications")) return Response.json(stub.apps);
		if (raw.startsWith("http://loans/internal/portfolio/summary")) {
			return Response.json(stub.loansSummary, { status: stub.loansSummaryStatus });
		}
		if (raw.startsWith("http://loans")) return Response.json(stub.loansStats);
		return Response.json({}, { status: 404 });
	}) as typeof fetch;
	const fakeDb = {
		select: () => ({ from: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }),
	} as unknown as Db;
	const app = createApp({
		db: fakeDb,
		sql: { end: async () => {} } as never,
		env: {
			databaseUrl: "postgres://localhost:5432/unused",
			kafkaBrokers: "localhost:9092",
			applicationsUrl: "http://applications",
			loansUrl: "http://loans",
			internalSecret: SECRET,
			port: 4004,
			host: "127.0.0.1",
		},
		logger: createLogger("portfolio-test"),
		fetchImpl,
	});
	return app;
}

function headers(
	user: { id: string; email: string; role: "applicant" | "officer" | "service" },
	method: string,
	path: string,
): Record<string, string> {
	return signedInternalHeaders(SECRET, user, method, path, {});
}

async function jsonBody<T>(res: Response): Promise<T> {
	return (await res.json()) as T;
}

const baseStub: Stub = {
	apps: { applications: { booked: 2 }, avgDecisionSeconds: 12.5, decidedApplications: 2 },
	loansStats: { loans: { active: 2 } },
	loansSummary: { principalCents: 7 },
	loansSummaryStatus: 200,
};

describe("GET /api/dashboard/summary decisionsToday", () => {
	const path = "/api/dashboard/summary";

	it("passes through decisionsToday additively", async () => {
		const app = setup({
			...baseStub,
			apps: { ...(baseStub.apps as Record<string, unknown>), decisionsToday: 4 },
		});
		const res = await app.request(path, { headers: headers(OFFICER, "GET", path) });
		expect(res.status).toBe(200);
		const body = await jsonBody<Record<string, unknown>>(res);
		expect(body.decisionsToday).toBe(4);
		// Existing fields unchanged.
		expect(body.applications).toEqual({ booked: 2 });
		expect(body.loans).toEqual({ active: 2 });
		expect(body.avgDecisionSeconds).toBe(12.5);
		expect(body.decidedApplications).toBe(2);
	});

	it("defaults decisionsToday to null when upstream omits it", async () => {
		const app = setup(baseStub);
		const res = await app.request(path, { headers: headers(OFFICER, "GET", path) });
		expect(res.status).toBe(200);
		expect((await jsonBody<Record<string, unknown>>(res)).decisionsToday).toBeNull();
	});
});

describe("GET /api/portfolio/summary", () => {
	const path = "/api/portfolio/summary";
	const payload = {
		principalCents: 100,
		outstandingCents: 80,
		overdueExposureCents: 5,
		activeLoans: 3,
		overdueLoans: 1,
		openAlerts: 1,
		alertsTotal: 1,
		alertsTruncated: false,
		coverageRatio: null,
		series: [],
		composition: [],
		alerts: [],
	};

	it("proxies the loans aggregation verbatim for officers", async () => {
		const app = setup({ ...baseStub, loansSummary: payload });
		const res = await app.request(path, { headers: headers(OFFICER, "GET", path) });
		expect(res.status).toBe(200);
		expect(await jsonBody<unknown>(res)).toEqual(payload);
	});

	it("returns 502 when loans is unavailable", async () => {
		const app = setup({ ...baseStub, loansSummary: {}, loansSummaryStatus: 500 });
		const res = await app.request(path, { headers: headers(OFFICER, "GET", path) });
		expect(res.status).toBe(502);
	});

	it("rejects applicants with 403 and unsigned requests with 401", async () => {
		const app = setup({ ...baseStub, loansSummary: payload });
		expect((await app.request(path, { headers: headers(APPLICANT, "GET", path) })).status).toBe(
			403,
		);
		expect((await app.request(path)).status).toBe(401);
	});
});
