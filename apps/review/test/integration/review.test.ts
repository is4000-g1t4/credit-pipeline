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

/** Signed decision POST with the exact body bytes covered by the signature. */
async function postDecision(
	c: TestContext,
	path: string,
	user: { id: string; email: string; role: "applicant" | "officer" },
	payload: unknown,
): Promise<Response> {
	const body = JSON.stringify(payload);
	return c.app.request(path, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...signed(c, user, "POST", path, {}, body),
		},
		body,
	});
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

		const approveBody = { requestId: randomUUID(), outcome: "approve" };
		const res = await postDecision(c, path, officer, approveBody);
		expect(res.status).toBe(200);
		expect(await jsonBody<unknown>(res)).toEqual({
			outcome: "booked",
			decisionId: "d-book",
			loanId: "l-book",
		});
		expect(c.gateway.decisionCalls.at(-1)?.applicationId).toBe(appId);
		// The full forwarded payload: public fields verbatim plus the
		// server-resolved officer identity — nothing else.
		expect(c.gateway.decisionCalls.at(-1)?.input).toEqual({
			requestId: approveBody.requestId,
			outcome: "approve",
			officerUserId: officer.id,
		});

		// Optional terms ride through untouched.
		const fullId = randomUUID();
		const fullBody = {
			requestId: fullId,
			outcome: "approve",
			approvedAmountCents: 500000,
			termMonths: 24,
			reasonCode: "OFFICER_JUDGEMENT",
			notes: "counter-offer",
		};
		const fullPath = `/api/review/${fullId}/decision`;
		const full = await postDecision(c, fullPath, officer, fullBody);
		expect(full.status).toBe(200);
		expect(c.gateway.decisionCalls.at(-1)?.input).toEqual({
			...fullBody,
			officerUserId: officer.id,
		});

		c.gateway.decisionError = new GatewayError(409, "DECISION_CONFLICT", "already decided");
		const appId2 = randomUUID();
		const path2 = `/api/review/${appId2}/decision`;
		const conflictBody = { requestId: randomUUID(), outcome: "approve" };
		const conflict = await postDecision(c, path2, officer, conflictBody);
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

		const retryBody = {
			requestId,
			outcome: "decline",
			reasonCode: "OFFICER_JUDGEMENT",
			notes: "retry",
		};
		const replay = await postDecision(c, path, officer, retryBody);
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
		const replayBooked = await postDecision(c, bookedPath, officer, retryBody);
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
		const converging = await postDecision(c, convergingPath, officer, retryBody);
		expect(converging.status).toBe(409);
		expect((await jsonBody<{ error: { code: string } }>(converging)).error.code).toBe(
			"BOOKING_INCOMPLETE",
		);

		const conflict = await postDecision(c, path, officer, {
			requestId: randomUUID(),
			outcome: "decline",
			reasonCode: "OFFICER_JUDGEMENT",
			notes: "late",
		});
		expect(conflict.status).toBe(409);

		const applicantCall = await postDecision(c, path, applicant, {
			requestId: randomUUID(),
			outcome: "decline",
			reasonCode: "OFFICER_JUDGEMENT",
			notes: "nope",
		});
		expect(applicantCall.status).toBe(403);
	});

	it("resolves the research selection to the frozen bundle; a research object is 422", async () => {
		const c = fresh();
		const officer = createUser("officer");
		const appId = randomUUID();
		const path = `/api/review/${appId}/decision`;
		const agentRunId = randomUUID();
		const findingId = randomUUID();
		c.research.runs.set(agentRunId, { applicationId: appId, status: "succeeded" });
		const frozen = {
			agentRunId,
			applicationId: appId,
			briefHash: "sha256:test",
			viewedAt: null,
			acceptedFindings: [
				{
					findingId,
					claim: "Cited claim.",
					category: "registry",
					entityMatch: { identifierType: "registration_number", value: "X", confidence: "high" },
					evidence: [
						{ url: "https://example.com/r", quote: "exact quote", snapshotHash: "sha256:q" },
					],
				},
			],
		};
		c.research.bundles.set(agentRunId, frozen);

		const res = await postDecision(c, path, officer, {
			requestId: randomUUID(),
			outcome: "approve",
			agentRunId,
			acceptedFindingIds: [findingId],
		});
		expect(res.status).toBe(200);
		// Server-built bundle forwarded verbatim; client selection stripped.
		const sent = c.gateway.decisionCalls.at(-1)?.input;
		expect(sent?.research).toEqual(frozen);
		expect(sent).not.toHaveProperty("agentRunId");
		expect(sent).not.toHaveProperty("acceptedFindingIds");

		const appId2 = randomUUID();
		const bad = await postDecision(c, `/api/review/${appId2}/decision`, officer, {
			requestId: randomUUID(),
			outcome: "approve",
			research: {
				agentRunId,
				applicationId: appId2,
				briefHash: "sha256:x",
				viewedAt: null,
				acceptedFindings: [],
			},
		});
		expect(bad.status).toBe(422);
	});

	it("409s when the case is not pending and 404s unknown applications", async () => {
		const c = fresh();
		const officer = createUser("officer");
		const processingId = randomUUID();
		c.internal.decisions.set(processingId, { status: "processing", decision: null });
		const processingPath = `/api/review/${processingId}/decision`;
		const notPending = await postDecision(c, processingPath, officer, {
			requestId: randomUUID(),
			outcome: "approve",
		});
		expect(notPending.status).toBe(409);

		const missingId = randomUUID();
		c.internal.missing.add(missingId);
		const missingPath = `/api/review/${missingId}/decision`;
		const missing = await postDecision(c, missingPath, officer, {
			requestId: randomUUID(),
			outcome: "approve",
		});
		expect(missing.status).toBe(404);
	});
});
