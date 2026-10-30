// Case-assistant gateway proxy: POST /api/review/:id/assistant is
// officer-only, behind its own per-actor limiter message, and rides the
// long assist timeout to the review service — ahead of the generic
// /api/review/* proxy.
import { describe, expect, it, vi } from "vitest";
import { resolveInternalHeadersForTest } from "./header-check.js";
import { setupStubApp, STUB_INTERNAL_SECRET, type StubRequest } from "./helper.js";

const ASSIST_TIMEOUT_MS = 120_000;

describe("case-assistant gateway route", () => {
	it("proxies an officer question to review with the assist timeout", async () => {
		const spy = vi.spyOn(AbortSignal, "timeout");
		const captured: StubRequest[] = [];
		const { app, officers, cookieFor } = setupStubApp(captured);
		const id = "11111111-1111-4111-8111-111111111111";
		const body = JSON.stringify({ question: "Summarise the case." });
		const res = await app.request(`/api/review/${id}/assistant?x=1`, {
			method: "POST",
			headers: { cookie: cookieFor(officers[0].id), "content-type": "application/json" },
			body,
		});
		expect(res.status).toBe(200);
		expect(captured).toHaveLength(1);
		expect(captured[0].method).toBe("POST");
		expect(captured[0].url).toBe(`http://review.test/api/review/${id}/assistant?x=1`);
		expect(captured[0].body).toBe(body);
		expect(
			resolveInternalHeadersForTest(STUB_INTERNAL_SECRET, {
				method: "POST",
				path: `/api/review/${id}/assistant`,
				headers: captured[0].headers,
				body: captured[0].body,
			})?.role,
		).toBe("officer");
		expect(spy).toHaveBeenCalledWith(ASSIST_TIMEOUT_MS);
		expect(spy).not.toHaveBeenCalledWith(45_000);
	});

	it("forwards the client's Accept header so the review stream can opt in", async () => {
		const captured: StubRequest[] = [];
		const { app, officers, cookieFor } = setupStubApp(captured);
		const id = "11111111-1111-4111-8111-111111111111";
		const res = await app.request(`/api/review/${id}/assistant`, {
			method: "POST",
			headers: {
				cookie: cookieFor(officers[0].id),
				"content-type": "application/json",
				accept: "text/event-stream",
			},
			body: JSON.stringify({ question: "Summarise the case." }),
		});
		expect(res.status).toBe(200);
		expect(captured[0]?.headers.accept).toBe("text/event-stream");
	});

	it("rejects applicants and unauthenticated callers without touching upstream", async () => {
		const captured: StubRequest[] = [];
		const { app, applicant, actAs, cookieFor } = setupStubApp(captured);
		actAs(applicant);
		const id = "11111111-1111-4111-8111-111111111111";
		const res = await app.request(`/api/review/${id}/assistant`, {
			method: "POST",
			headers: { cookie: cookieFor(applicant.id), "content-type": "application/json" },
			body: JSON.stringify({ question: "Summarise the case." }),
		});
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
		const anon = await app.request(`/api/review/${id}/assistant`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ question: "Summarise the case." }),
		});
		expect(anon.status).toBe(401);
		expect(captured).toHaveLength(0);
	});

	it("rate-limits per officer with the assistant message; other officers unaffected", async () => {
		const captured: StubRequest[] = [];
		const { app, officers, actAs, cookieFor } = setupStubApp(captured, { policyLimit: 2 });
		const id = "11111111-1111-4111-8111-111111111111";
		const ask = (officerId: string) =>
			app.request(`/api/review/${id}/assistant`, {
				method: "POST",
				headers: { cookie: cookieFor(officerId), "content-type": "application/json" },
				body: JSON.stringify({ question: "Summarise the case." }),
			});
		actAs(officers[0]);
		expect((await ask(officers[0].id)).status).toBe(200);
		expect((await ask(officers[0].id)).status).toBe(200);
		const limited = await ask(officers[0].id);
		expect(limited.status).toBe(429);
		const limitedBody = (await limited.json()) as { error: { code: string; message: string } };
		expect(limitedBody.error.code).toBe("RATE_LIMITED");
		expect(limitedBody.error.message).toBe("too many assistant requests");
		expect(captured).toHaveLength(2);
		// A different officer has their own budget.
		actAs(officers[1]);
		expect((await ask(officers[1].id)).status).toBe(200);
		expect(captured).toHaveLength(3);
	});
});
