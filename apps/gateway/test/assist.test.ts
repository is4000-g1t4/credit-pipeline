// EN-01/02/03 gateway proxy: /api/assist/* is officer-only and forwards the
// exact path/query/body to the applications service with the signed identity.
// Flag-off 404 is enforced by the applications service, not the gateway.
import { describe, expect, it, vi } from "vitest";
import { resolveInternalHeadersForTest } from "./header-check.js";
import { setupStubApp, STUB_INTERNAL_SECRET, type StubRequest } from "./helper.js";

describe("assist gateway routes", () => {
	it("proxies an officer request unchanged with the long timeout", async () => {
		const spy = vi.spyOn(AbortSignal, "timeout");
		const captured: StubRequest[] = [];
		const { app, officers, cookieFor } = setupStubApp(captured);
		const body = JSON.stringify({ expectedRevision: 1, confirm: true });
		const id = "11111111-1111-4111-8111-111111111111";
		const res = await app.request(`/api/assist/artifacts/${id}/approve?x=1`, {
			method: "POST",
			headers: { cookie: cookieFor(officers[0].id), "content-type": "application/json" },
			body,
		});
		expect(res.status).toBe(200);
		expect(captured).toHaveLength(1);
		expect(captured[0]?.url).toBe(
			`http://applications.test/api/assist/artifacts/${id}/approve?x=1`,
		);
		expect(captured[0]?.body).toBe(body);
		expect(
			resolveInternalHeadersForTest(STUB_INTERNAL_SECRET, {
				method: "POST",
				path: `/api/assist/artifacts/${id}/approve`,
				headers: captured[0]?.headers ?? {},
				body: captured[0]?.body ?? null,
			})?.role,
		).toBe("officer");
		expect(spy).toHaveBeenCalledWith(45_000);
		expect(spy).not.toHaveBeenCalledWith(5_000);
	});

	it("rejects applicants without touching upstream", async () => {
		const captured: StubRequest[] = [];
		const { app, applicant, actAs, cookieFor } = setupStubApp(captured);
		actAs(applicant);
		const res = await app.request(
			"/api/assist/cases/11111111-1111-4111-8111-111111111111/evidence",
			{
				headers: { cookie: cookieFor(applicant.id) },
			},
		);
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
		expect(captured).toHaveLength(0);
	});
});
