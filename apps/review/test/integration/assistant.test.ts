// Case-assistant proxy (officer Q&A over the case file): officer-only
// gated POST, strict body validation, then passthrough to the research
// internal endpoint with shared upstream error semantics.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createUser, setupApp, signed, type TestContext } from "../helper.js";

function fresh(opts: { caseAssistantEnabled?: boolean } = {}): TestContext {
	return setupApp(opts);
}

async function post(
	c: TestContext,
	path: string,
	user: { id: string; email: string; role: "applicant" | "officer" },
	payload?: unknown,
): Promise<Response> {
	const body = payload === undefined ? undefined : JSON.stringify(payload);
	return c.app.request(path, {
		method: "POST",
		headers: {
			...(body !== undefined ? { "content-type": "application/json" } : {}),
			...signed(c, user, "POST", path, {}, body),
		},
		body,
	});
}

async function jsonBody<T>(res: Response): Promise<T> {
	return (await res.json()) as T;
}

function errorCode(res: Promise<Response> | Response): Promise<string> {
	return Promise.resolve(res).then((r) =>
		jsonBody<{ error: { code: string } }>(r).then((b) => b.error.code),
	);
}

describe("POST /api/review/:id/assistant", () => {
	it("404s CASE_ASSISTANT_DISABLED when the flag is off, without touching research", async () => {
		const c = fresh({ caseAssistantEnabled: false });
		const officer = createUser("officer");
		const appId = randomUUID();
		const res = await post(c, `/api/review/${appId}/assistant`, officer, {
			question: "Summarise the case.",
		});
		expect(res.status).toBe(404);
		expect(await errorCode(res)).toBe("CASE_ASSISTANT_DISABLED");
		expect(c.research.calls).toHaveLength(0);
	});

	it("proxies the validated body and passes the research answer through", async () => {
		const c = fresh();
		const officer = createUser("officer");
		const appId = randomUUID();
		const payload = {
			question: "What is the applicant's stated income?",
			history: [{ role: "user", text: "Hello" }],
		};
		const res = await post(c, `/api/review/${appId}/assistant`, officer, payload);
		expect(res.status).toBe(200);
		const body = await jsonBody<Record<string, unknown>>(res);
		expect(body["answer"]).toBe("Stub answer.");
		expect(body["model"]).toBe("stub");
		// The exact validated payload reaches research, signed as the officer.
		expect(c.research.assistantBodies).toEqual([payload]);
		expect(c.research.calls).toContain(`POST /internal/research/applications/${appId}/assistant`);
	});

	it("passes SSE through when the browser accepts text/event-stream", async () => {
		const c = fresh();
		const officer = createUser("officer");
		const appId = randomUUID();
		const path = `/api/review/${appId}/assistant`;
		const body = JSON.stringify({ question: "Summarise the case." });
		const res = await c.app.request(path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "text/event-stream",
				...signed(c, officer, "POST", path, {}, body),
			},
			body,
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		expect(await res.text()).toContain('"type":"tool"');
		expect(c.research.assistantBodies).toHaveLength(1);
	});

	it("403s applicants; 404s non-UUID ids", async () => {
		const c = fresh();
		const applicant = createUser();
		const appId = randomUUID();
		expect(
			(
				await post(c, `/api/review/${appId}/assistant`, applicant, {
					question: "Summarise the case.",
				})
			).status,
		).toBe(403);
		const officer = createUser("officer");
		expect(
			(
				await post(c, "/api/review/not-a-uuid/assistant", officer, {
					question: "Summarise the case.",
				})
			).status,
		).toBe(404);
		expect(c.research.assistantBodies).toHaveLength(0);
	});

	it("422s invalid bodies: short/long questions, history caps, strict shape", async () => {
		const c = fresh();
		const officer = createUser("officer");
		const path = `/api/review/${randomUUID()}/assistant`;
		const cases: unknown[] = [
			{},
			{ question: "hi" },
			{ question: "x".repeat(1001) },
			{ question: "Valid question?", unknown: 1 },
			{ question: "Valid?", history: [{ role: "user", text: 42 }] },
			{
				question: "Valid?",
				history: Array.from({ length: 9 }, (_, i) => ({ role: "user", text: `m${i}` })),
			},
			{
				question: "Valid?",
				history: [
					{ role: "user", text: "x".repeat(3000) },
					{ role: "assistant", text: "y".repeat(3001) },
				],
			},
			{ question: "Valid?", history: [{ role: "system", text: "nope" }] },
		];
		for (const payload of cases) {
			const res = await post(c, path, officer, payload);
			expect(res.status).toBe(422);
			expect(await errorCode(res)).toBe("VALIDATION_ERROR");
		}
		expect(c.research.assistantBodies).toHaveLength(0);
	});

	it("passes upstream 4xx through and maps upstream 5xx to 502", async () => {
		const c = fresh();
		const officer = createUser("officer");

		const missingId = randomUUID();
		c.research.assistantMissing.add(missingId);
		const missing = await post(c, `/api/review/${missingId}/assistant`, officer, {
			question: "Summarise the case.",
		});
		expect(missing.status).toBe(404);

		const conflictId = randomUUID();
		c.research.assistantConflict.add(conflictId);
		const conflict = await post(c, `/api/review/${conflictId}/assistant`, officer, {
			question: "Summarise the case.",
		});
		expect(conflict.status).toBe(409);
		expect(await errorCode(conflict)).toBe("CASE_NOT_PENDING");

		// Transport failure surfaces as 502, never a raw error.
		c.research.down = true;
		const down = await post(c, `/api/review/${randomUUID()}/assistant`, officer, {
			question: "Summarise the case.",
		});
		expect(down.status).toBe(502);
	});
});
