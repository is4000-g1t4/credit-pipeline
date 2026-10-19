// Review-service integration: officer-only queue (proxied), decision replay
// by request_id via the fake internal fetch, fake-gateway 200/409 mapping.
// No database — the service is stateless.
import { randomUUID } from "node:crypto";
import { GatewayError } from "@credit/service-kit";
import { describe, expect, it } from "vitest";
import { createUser, setupApp, signed, type TestContext } from "../helper.js";

let ctx: TestContext;

function fresh(): TestContext {
	ctx = setupApp();
	return ctx;
}

async function jsonBody<T>(res: Response): Promise<T> {
	return (await res.json()) as T;
}

describe("GET /api/review/queue", () => {
	it("requires the officer role; unsigned is 401; passes the queue through", async () => {
		const c = fresh();
		const applicant = createUser();
		const path = "/api/review/queue";

		const denied = await c.app.request(path, {
			headers: signed(c, applicant, "GET", path),
		});
		expect(denied.status).toBe(403);

		const unsigned = await c.app.request(path);
		expect(unsigned.status).toBe(401);

		const officer = createUser("officer");
		c.internal.queue = { items: [{ id: "app-1", reference: "APP-2026-X" }] };
		const ok = await c.app.request(path, {
			headers: signed(c, officer, "GET", path),
		});
		expect(ok.status).toBe(200);
		expect(await jsonBody<unknown>(ok)).toEqual({
			items: [{ id: "app-1", reference: "APP-2026-X" }],
		});
		expect(c.internal.calls).toContain("/internal/review/queue");
	});
});

describe("POST /api/review/:id/decision", () => {
	it("awaits the gateway update (200) and maps a gateway 409", async () => {
		const c = fresh();
		const officer = createUser("officer");
		const appId = randomUUID();
		const path = `/api/review/${appId}/decision`;
		c.gateway.decisionResult = { outcome: "booked", decisionId: "d-book", loanId: "l-book" };
		c.gateway.decisionError = null;

		const res = await c.app.request(path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...signed(c, officer, "POST", path),
			},
			body: JSON.stringify({ requestId: randomUUID(), outcome: "approve" }),
		});
		expect(res.status).toBe(200);
		expect(await jsonBody<unknown>(res)).toEqual({
			outcome: "booked",
			decisionId: "d-book",
			loanId: "l-book",
		});
		expect(c.gateway.decisionCalls.at(-1)?.applicationId).toBe(appId);

		c.gateway.decisionError = new GatewayError(409, "DECISION_CONFLICT", "already decided");
		const appId2 = randomUUID();
		const path2 = `/api/review/${appId2}/decision`;
		const conflict = await c.app.request(path2, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...signed(c, officer, "POST", path2),
			},
			body: JSON.stringify({ requestId: randomUUID(), outcome: "approve" }),
		});
		expect(conflict.status).toBe(409);
		c.gateway.decisionError = null;
	});

	it("replays a terminal decision on matching requestId, 409 otherwise", async () => {
		const c = fresh();
		const applicant = createUser();
		const officer = createUser("officer");
		const appId = randomUUID();
		const requestId = randomUUID();
		c.internal.decisions.set(appId, {
			status: "declined",
			decision: { id: "dec-1", outcome: "declined", requestId },
		});
		const path = `/api/review/${appId}/decision`;

		const replay = await c.app.request(path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...signed(c, officer, "POST", path),
			},
			body: JSON.stringify({
				requestId,
				outcome: "decline",
				reasonCode: "OFFICER_JUDGEMENT",
				notes: "retry",
			}),
		});
		expect(replay.status).toBe(200);
		expect(await jsonBody<unknown>(replay)).toEqual({
			outcome: "declined",
			decisionId: "dec-1",
			loanId: null,
		});
		expect(c.gateway.decisionCalls).toHaveLength(0);

		// Same requestId with a booked loan resolves the loan id.
		const bookedId = randomUUID();
		c.internal.decisions.set(bookedId, {
			status: "booked",
			decision: { id: "dec-2", outcome: "approved", requestId },
		});
		c.internal.loans.set(bookedId, { loan: { id: "loan-2" } });
		const bookedPath = `/api/review/${bookedId}/decision`;
		const replayBooked = await c.app.request(bookedPath, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...signed(c, officer, "POST", bookedPath),
			},
			body: JSON.stringify({
				requestId,
				outcome: "decline",
				reasonCode: "OFFICER_JUDGEMENT",
				notes: "retry",
			}),
		});
		expect(replayBooked.status).toBe(200);
		expect(await jsonBody<unknown>(replayBooked)).toEqual({
			outcome: "booked",
			decisionId: "dec-2",
			loanId: "loan-2",
		});

		// Same requestId on an approved decision with no loan yet: the saga
		// is still converging — 409 BOOKING_INCOMPLETE, not booked + null.
		const convergingId = randomUUID();
		c.internal.decisions.set(convergingId, {
			status: "processing",
			decision: { id: "dec-3", outcome: "approved", requestId },
		});
		const convergingPath = `/api/review/${convergingId}/decision`;
		const converging = await c.app.request(convergingPath, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...signed(c, officer, "POST", convergingPath),
			},
			body: JSON.stringify({
				requestId,
				outcome: "decline",
				reasonCode: "OFFICER_JUDGEMENT",
				notes: "retry",
			}),
		});
		expect(converging.status).toBe(409);
		expect((await jsonBody<{ error: { code: string } }>(converging)).error.code).toBe(
			"BOOKING_INCOMPLETE",
		);

		const conflict = await c.app.request(path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...signed(c, officer, "POST", path),
			},
			body: JSON.stringify({
				requestId: randomUUID(),
				outcome: "decline",
				reasonCode: "OFFICER_JUDGEMENT",
				notes: "late",
			}),
		});
		expect(conflict.status).toBe(409);

		const applicantCall = await c.app.request(path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...signed(c, applicant, "POST", path),
			},
			body: JSON.stringify({
				requestId: randomUUID(),
				outcome: "decline",
				reasonCode: "OFFICER_JUDGEMENT",
				notes: "nope",
			}),
		});
		expect(applicantCall.status).toBe(403);
	});

	it("409s when the case is not pending and 404s unknown applications", async () => {
		const c = fresh();
		const officer = createUser("officer");
		const processingId = randomUUID();
		c.internal.decisions.set(processingId, { status: "processing", decision: null });
		const processingPath = `/api/review/${processingId}/decision`;
		const notPending = await c.app.request(processingPath, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...signed(c, officer, "POST", processingPath),
			},
			body: JSON.stringify({ requestId: randomUUID(), outcome: "approve" }),
		});
		expect(notPending.status).toBe(409);

		const missingId = randomUUID();
		c.internal.missing.add(missingId);
		const missingPath = `/api/review/${missingId}/decision`;
		const missing = await c.app.request(missingPath, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...signed(c, officer, "POST", missingPath),
			},
			body: JSON.stringify({ requestId: randomUUID(), outcome: "approve" }),
		});
		expect(missing.status).toBe(404);
	});
});
