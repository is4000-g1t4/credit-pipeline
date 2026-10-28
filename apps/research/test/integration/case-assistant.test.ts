// Case-assistant route tests: flag gating, consent gating, happy path,
// validation, and error mapping. The applications service is faked via the
// fetchResearchContext seam; the model via a stub runner — no network.
import { randomUUID } from "node:crypto";
import { HttpError } from "@credit/service-kit";
import { describe, expect, it } from "vitest";
import { CaseAssistantError, stubCaseAssistantRunner } from "../../src/case-assistant.js";
import { caseFacts, OFFICER, post, setupApp, teardown, type TestContext } from "../helper.js";

process.env.LOG_LEVEL ??= "silent";

const applicationId = "11111111-1111-4111-8111-111111111111";

function consented() {
	return {
		fetchResearchContext: async () => ({
			caseFacts: caseFacts({ applicationId }) as unknown as Record<string, unknown>,
			contextAnalysisConsent: true,
		}),
	};
}

function assistantPath(id = applicationId): string {
	return `/internal/research/applications/${id}/assistant`;
}

describe("POST :applicationId/assistant", () => {
	it("404s CASE_ASSISTANT_DISABLED when the flag is off", async () => {
		const ctx: TestContext = setupApp(undefined, { env: { caseAssistantEnabled: false } });
		try {
			const res = await post(ctx, assistantPath(), OFFICER, { question: "Anything?" });
			expect(res.status).toBe(404);
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
				"CASE_ASSISTANT_DISABLED",
			);
		} finally {
			await teardown(ctx);
		}
	});

	it("403s CONTEXT_CONSENT_REQUIRED without context consent", async () => {
		const ctx: TestContext = setupApp(undefined, {
			env: { caseAssistantEnabled: true },
			fetchResearchContext: async () => ({
				caseFacts: caseFacts({ applicationId }) as unknown as Record<string, unknown>,
				contextAnalysisConsent: false,
			}),
		});
		try {
			const res = await post(ctx, assistantPath(), OFFICER, { question: "Anything?" });
			expect(res.status).toBe(403);
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
				"CONTEXT_CONSENT_REQUIRED",
			);
		} finally {
			await teardown(ctx);
		}
	});

	it("404s when the officer lacks case access, before the context fetch or model", async () => {
		const ctx: TestContext = setupApp(undefined, {
			env: { caseAssistantEnabled: true },
			checkAssistantCaseAccess: async () => {
				throw new HttpError(404, "NOT_FOUND", "not found");
			},
			fetchResearchContext: async () => {
				throw new Error("context must not be fetched");
			},
		});
		try {
			const res = await post(ctx, assistantPath(), OFFICER, { question: "Summarise the case." });
			expect(res.status).toBe(404);
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND");
		} finally {
			await teardown(ctx);
		}
	});

	it("returns the contract response on the happy path with no PII", async () => {
		const ctx: TestContext = setupApp(undefined, {
			env: { caseAssistantEnabled: true },
			...consented(),
			caseAssistant: stubCaseAssistantRunner({
				outputs: [
					{
						answer: "Two accounts show steady inflows over the window.",
						limitations: [],
						toolCalls: [{ name: "list_accounts", resultCount: 1, sourceTypes: ["case"] }],
						policyRefs: [],
					},
				],
			}),
		});
		try {
			const res = await post(ctx, assistantPath(), OFFICER, {
				question: "Summarize the accounts.",
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body["answer"]).toBe("Two accounts show steady inflows over the window.");
			expect(body["toolCalls"]).toEqual([
				{ name: "list_accounts", resultCount: 1, sourceTypes: ["case"] },
			]);
			expect(body["policyRefs"]).toEqual([]);
			expect(body["usage"]).toBeDefined();
			expect(body["model"]).toBeDefined();
			expect(body["promptVersion"]).toBeDefined();
			expect(body["agentVersion"]).toBeDefined();
			expect(typeof body["latencyMs"]).toBe("number");
			// Case PII rides the fake context, never the response.
			const raw = JSON.stringify(body);
			expect(raw).not.toContain("Jane Doe");
			expect(raw).not.toContain("Acme Ltd");
		} finally {
			await teardown(ctx);
		}
	});

	it("validates UUIDs and bodies", async () => {
		const ctx: TestContext = setupApp(undefined, {
			env: { caseAssistantEnabled: true },
			...consented(),
		});
		try {
			const badId = await post(ctx, assistantPath("not-a-uuid"), OFFICER, {
				question: "Anything?",
			});
			expect(badId.status).toBe(404);
			const missing = await post(ctx, assistantPath(), OFFICER, {});
			expect(missing.status).toBe(422);
			const tooLong = await post(ctx, assistantPath(), OFFICER, {
				question: "x".repeat(1001),
			});
			expect(tooLong.status).toBe(422);
		} finally {
			await teardown(ctx);
		}
	});

	it("maps UNSAFE_OUTPUT to 422 without leaking the answer", async () => {
		const ctx: TestContext = setupApp(undefined, {
			env: { caseAssistantEnabled: true },
			...consented(),
			caseAssistant: stubCaseAssistantRunner({
				outputs: [],
				throw: new CaseAssistantError("UNSAFE_OUTPUT", "assistant answer repeats a case name"),
			}),
		});
		try {
			const res = await post(ctx, assistantPath(), OFFICER, { question: "Anything?" });
			expect(res.status).toBe(422);
			const body = (await res.json()) as { error: { code: string; message: string } };
			expect(body.error.code).toBe("UNSAFE_OUTPUT");
			expect(JSON.stringify(body)).not.toContain("Jane Doe");
		} finally {
			await teardown(ctx);
		}
	});

	it("maps timeouts to 504", async () => {
		const ctx: TestContext = setupApp(undefined, {
			env: { caseAssistantEnabled: true },
			...consented(),
			caseAssistant: stubCaseAssistantRunner({
				outputs: [],
				throw: new CaseAssistantError("CASE_ASSISTANT_TIMEOUT", "assistant run timed out"),
			}),
		});
		try {
			const res = await post(ctx, assistantPath(), OFFICER, { question: "Anything?" });
			expect(res.status).toBe(504);
			expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
				"CASE_ASSISTANT_TIMEOUT",
			);
		} finally {
			await teardown(ctx);
		}
	});

	it("uses a fresh application id per case without cross-talk", async () => {
		const otherId = randomUUID();
		const ctx: TestContext = setupApp(undefined, {
			env: { caseAssistantEnabled: true },
			fetchResearchContext: async (id: string) => ({
				caseFacts: caseFacts({ applicationId: id }) as unknown as Record<string, unknown>,
				contextAnalysisConsent: true,
			}),
		});
		try {
			const res = await post(ctx, assistantPath(otherId), OFFICER, { question: "Anything?" });
			expect(res.status).toBe(200);
		} finally {
			await teardown(ctx);
		}
	});
});
