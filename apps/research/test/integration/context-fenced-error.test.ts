// A fenced (zombie) run attempt whose context stage errors unexpectedly
// must fail only the stage IT claimed, never the stage a newer attempt
// owns. Real credit_research Postgres; the stage-failure writer is wrapped
// so it blows up only for the zombie's own stage token (simulating a DB
// error inside the stage catch), forcing run.ts's unexpected-error path.
import { randomUUID } from "node:crypto";
import { createLogger } from "@credit/service-kit";
import { describe, expect, it, vi } from "vitest";

const throwFor = vi.hoisted(() => new Set<string>());

vi.mock("../../src/lifecycle.js", async (importOriginal) => {
	const mod = (await importOriginal()) as typeof import("../../src/lifecycle.js");
	return {
		...mod,
		persistContextFailure: async (...args: Parameters<typeof mod.persistContextFailure>) => {
			if (throwFor.has(args[2])) throw new Error("stage failure persist boom");
			return mod.persistContextFailure(...args);
		},
	};
});

import {
	stubAgentRunner,
	stubLanguageRepair,
	stubSupportJudge,
} from "../../src/agents/case-brief/index.js";
import { ContextToolError, stubContextRunner } from "../../src/agents/context-analyst/index.js";
import { loadEnv } from "../../src/env.js";
import {
	claimContextStage,
	claimRun,
	ensureRun,
	getRun,
	initContextStage,
	rotateRunForRetry,
} from "../../src/lifecycle.js";
import { executeRun } from "../../src/run.js";
import { caseFacts, degradedObservability, setupApp, successFixture, teardown } from "../helper.js";

process.env.LOG_LEVEL ??= "silent";
const env = { ...loadEnv(), agentsEnabled: true, contextEnabled: true };

describe("unexpected context error in a fenced attempt", () => {
	it("never fails the newer attempt's live context stage", async () => {
		const use = successFixture();
		const ctx = setupApp(use, { env: { contextEnabled: true } });
		try {
			const facts = caseFacts();
			const { run } = await ensureRun(ctx.db, env, {
				applicationId: facts.applicationId,
				requestedBy: randomUUID(),
				caseFacts: facts,
				aiResearchConsent: true,
			});
			const oldToken = run.runToken as string;
			let newStage: string | null = null;
			const zombieContext = {
				...stubContextRunner({ outputs: [{}] }),
				async runContext() {
					// Mid-stage, attempt 2 fences this attempt and reaches its
					// own context stage.
					const mine = (await getRun(ctx.db, run.id))?.contextStageToken as string;
					throwFor.add(mine);
					const t2 = (await rotateRunForRetry(ctx.db, env, run.id)) as string;
					expect(await claimRun(ctx.db, run.id, t2)).toBe(true);
					expect(await initContextStage(ctx.db, env, run.id, t2, "queued")).toBe(true);
					newStage = await claimContextStage(ctx.db, env, run.id, t2, {
						promptVersion: "v1",
						model: "m",
					});
					throw new ContextToolError("zombie stage error");
				},
			};
			await executeRun(
				{
					db: ctx.db,
					env,
					logger: createLogger("research-fenced-test"),
					runner: stubAgentRunner({ brief: use.brief, fetched: use.fetched }),
					judge: stubSupportJudge(),
					repair: stubLanguageRepair(),
					observability: degradedObservability,
					contextRunner: zombieContext,
					fetchContextConsent: async () => true,
				},
				run.id,
				oldToken,
			);
			expect(newStage).not.toBeNull();
			const live = await getRun(ctx.db, run.id);
			expect(live).toMatchObject({
				status: "running",
				contextStatus: "running",
				contextStageToken: newStage,
				contextErrorCode: null,
			});
		} finally {
			await teardown(ctx);
		}
	});
});
