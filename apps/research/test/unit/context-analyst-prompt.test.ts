// Prompt-integrity guard for the context-analyst agent. Hashes were
// recorded from the pre-move strings (src/context-agent.ts). Any edit to
// instructions.md or the user-prompt composition must bump
// CONTEXT_PROMPT_VERSION and update the hash here on purpose.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	buildContextUserPrompt,
	CONTEXT_PROMPT_VERSION,
	CONTEXT_SYSTEM,
	CONTEXT_TOOL_NAMES,
	CONTEXT_VALIDATOR_VERSION,
	definition,
} from "../../src/agents/context-analyst/index.js";
import { DEFAULT_CONTEXT_MODEL, researchServerSchema } from "../../src/env.js";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

const candidates = [
	{
		localId: "c1",
		type: "t",
		periodStart: "2026-01-01",
		periodEnd: "2026-06-30",
		metric: "m",
		observed: 1,
		expected: 2,
		confidence: "high" as const,
		status: "review" as const,
		policyVersion: "p1",
		accountScope: "all",
		evidenceIds: ["e1", "e2"],
	},
];
const input = {
	caseFacts: {
		reference: "R1",
		applicantName: "A</context_case_json>",
		amountCents: 100,
		asOf: "2026-10-30",
	},
	asOfDate: "2026-10-30",
};

describe("context-analyst prompts", () => {
	it("system prompt (instructions.md) is byte-identical to the pre-move string", () => {
		expect(sha(CONTEXT_SYSTEM)).toBe(
			"3953a84610b5e699f8b948682f9f28299b9d96efac8a6f8af98d213dca4f7c60",
		);
	});

	it("user prompt composition is unchanged for each preflight shape", () => {
		expect(sha(buildContextUserPrompt(input, candidates))).toBe(
			"67efdcc144cc2d07094611f4f209603bc6e61b6680c2c2dcb0a77dc322973203",
		);
		expect(sha(buildContextUserPrompt(input, candidates, { a: ["x"] }))).toBe(
			"c4d47c197dc218bba08eb60bb00e50845977535cc9e18641d4844afd4bd6e042",
		);
		expect(sha(buildContextUserPrompt(input, [], { a: 1 }))).toBe(
			"ff477962f1fc24bcb053edd0d85e94666253eec4775cdd232b00eba97df0dd9d",
		);
	});
});

describe("context-analyst manifest", () => {
	it("matches the directory, the Terra pin, the flag, and the recorded versions", () => {
		expect(definition.name).toBe("context-analyst");
		expect(definition.owner).toBe("research");
		expect(definition.model).toEqual({
			env: "CONTEXT_AGENT_MODEL",
			default: DEFAULT_CONTEXT_MODEL,
		});
		expect(DEFAULT_CONTEXT_MODEL).toBe("openai/gpt-6.1-terra");
		expect(definition.flags).toEqual(["CONTEXT_ANALYST_ENABLED"]);
		expect([CONTEXT_PROMPT_VERSION, CONTEXT_VALIDATOR_VERSION]).toEqual([
			"context-v5",
			"context-v4",
		]);
		expect(definition.versions).toEqual({
			prompt: CONTEXT_PROMPT_VERSION,
			validator: CONTEXT_VALIDATOR_VERSION,
		});
		expect(definition.tools).toEqual([...CONTEXT_TOOL_NAMES]);
		expect(Object.keys(researchServerSchema)).toContain(definition.model.env);
		for (const flag of definition.flags) expect(Object.keys(researchServerSchema)).toContain(flag);
	});
});
