// UBS gateway routes: draft PATCH and portfolio summary proxy to the owning
// services with the signed session identity; role gates match the existing
// user/officer split. Compose-free stub app captures upstream requests.
import { describe, expect, it } from "vitest";
import { resolveInternalHeadersForTest } from "./header-check.js";
import { setupStubApp, STUB_INTERNAL_SECRET, type StubRequest } from "./helper.js";

describe("UBS gateway routes", () => {
	it("proxies draft PATCH for the applicant with the body and signature", async () => {
		const captured: StubRequest[] = [];
		const { app, applicant, actAs, cookieFor } = setupStubApp(captured);
		actAs(applicant);
		const body = JSON.stringify({ expectedUpdatedAt: "<iso>", application: {} });
		const res = await app.request("/api/applications/abc/draft", {
			method: "PATCH",
			headers: { cookie: cookieFor(applicant.id), "content-type": "application/json" },
			body,
		});
		expect(res.status).toBe(200);
		expect(captured).toHaveLength(1);
		expect(captured[0]?.method).toBe("PATCH");
		expect(captured[0]?.url).toBe("http://applications.test/api/applications/abc/draft");
		expect(captured[0]?.body).toBe(body);
		expect(
			resolveInternalHeadersForTest(STUB_INTERNAL_SECRET, {
				method: "PATCH",
				path: "/api/applications/abc/draft",
				headers: captured[0]?.headers ?? {},
				body: captured[0]?.body ?? null,
			})?.role,
		).toBe("applicant");
	});

	it("rejects an unauthenticated draft PATCH before the upstream call", async () => {
		const captured: StubRequest[] = [];
		const { app } = setupStubApp(captured);
		const res = await app.request("/api/applications/abc/draft", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		expect(res.status).toBe(401);
		expect(captured).toHaveLength(0);
	});

	it("proxies portfolio summary for officers and rejects applicants", async () => {
		const captured: StubRequest[] = [];
		const { app, officers, applicant, actAs, cookieFor } = setupStubApp(captured);
		const officerRes = await app.request("/api/portfolio/summary", {
			headers: { cookie: cookieFor(officers[0].id) },
		});
		expect(officerRes.status).toBe(200);
		expect(captured.at(-1)?.url).toBe("http://portfolio.test/api/portfolio/summary");

		actAs(applicant);
		const applicantRes = await app.request("/api/portfolio/summary", {
			headers: { cookie: cookieFor(applicant.id) },
		});
		expect(applicantRes.status).toBe(403);
		expect(captured).toHaveLength(1);
	});
});
