// Applications-service integration (compose Postgres, fake gateway):
// signed submit + idempotency + 3-active limit, list/detail scoping,
// unsigned requests rejected with 401.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createUser,
	individualPayload,
	setupApp,
	signed,
	type TestContext,
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

async function postApplication(
	user: { id: string; email: string; role: "applicant" | "officer" },
	payload: unknown,
	key: string,
) {
	const path = "/api/applications";
	return ctx.app.request(path, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...signed(ctx, user, "POST", path, { "Idempotency-Key": key }),
		},
		body: JSON.stringify(payload),
	});
}

describe("POST /api/applications", () => {
	it("signed applicant can submit; same key replays, changed payload is 409", async () => {
		const user = await createUser(ctx);
		const key = randomUUID();
		const payload = individualPayload(user.email);
		const first = await postApplication(user, payload, key);
		expect(first.status).toBe(201);
		const firstBody = await jsonBody<{ id: string; reference: string }>(first);
		expect(firstBody.reference).toMatch(/^APP-\d{4}-[A-Z2-7]{6}$/);
		expect(ctx.gateway.started).toContain(firstBody.id);

		const replay = await postApplication(user, payload, key);
		expect(replay.status).toBe(201);
		expect((await jsonBody<{ id: string }>(replay)).id).toBe(firstBody.id);

		const changed = await postApplication(user, { ...payload, amountCents: 1300000 }, key);
		expect(changed.status).toBe(409);
		expect((await jsonBody<{ error: { code: string } }>(changed)).error.code).toBe(
			"IDEMPOTENCY_CONFLICT",
		);
	});

	it("the 4th non-terminal application is 409", async () => {
		const user = await createUser(ctx);
		for (let i = 0; i < 3; i++) {
			const res = await postApplication(user, individualPayload(user.email), randomUUID());
			expect(res.status).toBe(201);
		}
		const fourth = await postApplication(user, individualPayload(user.email), randomUUID());
		expect(fourth.status).toBe(409);
		expect((await jsonBody<{ error: { code: string } }>(fourth)).error.code).toBe(
			"TOO_MANY_APPLICATIONS",
		);
	});

	it("unsigned requests are 401 and officers cannot submit", async () => {
		const user = await createUser(ctx);
		const unsigned = await ctx.app.request("/api/applications", {
			method: "POST",
			headers: { "content-type": "application/json", "Idempotency-Key": randomUUID() },
			body: JSON.stringify(individualPayload(user.email)),
		});
		expect(unsigned.status).toBe(401);

		const officer = await createUser(ctx, "officer");
		const denied = await postApplication(officer, individualPayload(officer.email), randomUUID());
		expect(denied.status).toBe(403);
	});
});

describe("list/detail scoping", () => {
	it("applicants see only their own; officers see all", async () => {
		const a = await createUser(ctx);
		const b = await createUser(ctx);
		const officer = await createUser(ctx, "officer");
		const created = await postApplication(a, individualPayload(a.email), randomUUID());
		expect(created.status).toBe(201);
		const { id } = await jsonBody<{ id: string }>(created);

		const listPath = "/api/applications";
		const own = await ctx.app.request(listPath, { headers: signed(ctx, a, "GET", listPath) });
		expect(own.status).toBe(200);
		expect(
			(await jsonBody<{ items: Array<{ id: string }> }>(own)).items.map((i) => i.id),
		).toContain(id);

		const other = await ctx.app.request(listPath, { headers: signed(ctx, b, "GET", listPath) });
		expect(other.status).toBe(200);
		expect(
			(await jsonBody<{ items: Array<{ id: string }> }>(other)).items.map((i) => i.id),
		).not.toContain(id);

		const all = await ctx.app.request(listPath, { headers: signed(ctx, officer, "GET", listPath) });
		expect(all.status).toBe(200);
		expect(
			(await jsonBody<{ items: Array<{ id: string }> }>(all)).items.map((i) => i.id),
		).toContain(id);

		const unsigned = await ctx.app.request(listPath);
		expect(unsigned.status).toBe(401);
	});

	it("officer cross-read is allowed, applicant cross-read is 404, detail omits the loan", async () => {
		const a = await createUser(ctx);
		const b = await createUser(ctx);
		const officer = await createUser(ctx, "officer");
		const created = await postApplication(a, individualPayload(a.email), randomUUID());
		const { id } = await jsonBody<{ id: string }>(created);
		const path = `/api/applications/${id}`;

		const cross = await ctx.app.request(path, { headers: signed(ctx, b, "GET", path) });
		expect(cross.status).toBe(404);

		const own = await ctx.app.request(path, { headers: signed(ctx, officer, "GET", path) });
		expect(own.status).toBe(200);
		const body = await jsonBody<Record<string, unknown>>(own);
		expect(body).not.toHaveProperty("loan");
		expect(body).toHaveProperty("decision");
		expect(body).toHaveProperty("timeline");
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
		expect(body.service).toBe("applications");
		expect(["ok", "degraded"]).toContain(body.status);
		expect(body.checks.db).toBeDefined();
		expect(body.checks.temporal).toBeDefined();
	});
});
