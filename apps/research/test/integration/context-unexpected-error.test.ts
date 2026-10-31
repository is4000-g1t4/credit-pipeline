// T11/T18 failure independence (review finding 10): an unexpected
// context-stage error AFTER external success persists/fails the stage
// best-effort and finalizes the run from the external outcome only — the
// valid external brief is never discarded. Real credit_research Postgres,
// fake external agent, throwing context runner, mocked stage-failure
// writer (simulates the DB blowing up inside the stage catch).
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/lifecycle.js", async (importOriginal) => {
	const mod = (await importOriginal()) as Record<string, unknown>;
	return {
		...mod,
		persistContextFailure: async () => {
			throw new Error("stage failure persist boom");
		},
	};
});

import { ContextToolError, stubContextRunner } from "../../src/agents/context-analyst/index.js";
import { caseFacts, get, post, setupApp, successFixture, teardown, user } from "../helper.js";

process.env.LOG_LEVEL ??= "silent";

describe("unexpected context error after external success", () => {
	it("finalizes the run succeeded with the external brief intact", async () => {
		const use = successFixture();
		const ctx = setupApp(use, {
			env: { contextEnabled: true },
			contextRunner: stubContextRunner({
				outputs: [],
				throw: new ContextToolError("boom"),
			}),
			fetchContextConsent: async () => true,
		});
		try {
			const officer = user("officer");
			const facts = caseFacts();
			const res = await post(ctx, "/internal/research/runs/ensure", officer, {
				applicationId: facts.applicationId,
				caseFacts: { ...facts },
				aiResearchConsent: facts.aiResearchConsent,
			});
			expect(res.status).toBe(202);

			// Poll the RUN only: the context stage row is stuck (its failure
			// persist blew up) until failAgentRun fails it.
			interface SettledRun {
				run: { id: string; status: string; errorCode: string | null };
				brief: { summary: string } | null;
				context: { status: string };
			}
			const deadline = Date.now() + 15_000;
			let settled: SettledRun | null = null;
			for (;;) {
				const latest = await get(
					ctx,
					`/internal/research/applications/${facts.applicationId}/latest`,
					officer,
				);
				expect(latest.status).toBe(200);
				const parsed = (await latest.json()) as SettledRun;
				if (parsed.run.status === "succeeded" || parsed.run.status === "failed") {
					settled = parsed;
					break;
				}
				if (Date.now() > deadline) throw new Error("run did not settle");
				await new Promise((r) => setTimeout(r, 50));
			}
			expect(settled?.run.status).toBe("succeeded");
			expect(settled?.brief?.summary).toContain("Registry shows");
			// The stage did not succeed; the run did (external outcome rules).
			expect(settled?.context.status).not.toBe("succeeded");
		} finally {
			await teardown(ctx);
		}
	});
});
