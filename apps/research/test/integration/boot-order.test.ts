// Boot recovery ordering: queued-run recovery must run BEFORE the
// stale-run reaper, so a crash-left queued run starts instead of being
// failed first. Pure order test (lifecycle is mocked; no DB).
import { describe, expect, it, vi } from "vitest";

const mockCalls: string[] = [];

vi.mock("../../src/lifecycle.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/lifecycle.js")>();
	return {
		...actual,
		resumeQueuedRuns: async () => {
			mockCalls.push("resume");
			return [];
		},
		reapStaleRuns: async () => {
			mockCalls.push("reap");
			return [];
		},
	};
});

import { bootRecovery } from "../../src/auto-trigger.js";
import { stubAgentRunner } from "../../src/agent.js";
import { createLogger } from "@credit/service-kit";
import { stubLanguageRepair } from "../../src/repair.js";
import { stubSupportJudge } from "../../src/support.js";
import { degradedObservability, successFixture } from "../helper.js";

describe("bootRecovery order", () => {
	it("recovers queued runs before reaping stale runs", async () => {
		mockCalls.length = 0;
		const use = successFixture();
		const { recovered, reaped } = await bootRecovery({
			db: {} as never,
			env: {} as never,
			logger: createLogger("research-boot-test"),
			runner: stubAgentRunner({ brief: use.brief, fetched: use.fetched }),
			judge: stubSupportJudge(),
			repair: stubLanguageRepair(),
			observability: degradedObservability,
		});
		expect(mockCalls).toEqual(["resume", "reap"]);
		expect(recovered).toEqual([]);
		expect(reaped).toEqual([]);
	});
});
