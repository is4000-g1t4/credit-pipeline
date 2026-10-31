// Prompt-integrity guard for the case-brief agent. The hashes were recorded
// from the pre-move strings (when the prompts lived in src/prompt.ts,
// support.ts and repair.ts). Prompt versions are pinned on traces, so any
// edit to instructions.md or the in-code templates must bump PROMPT_VERSION
// and update the hash here on purpose.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	buildUserPrompt,
	createLlmLanguageRepair,
	createLlmSupportJudge,
	definition,
	PROMPT_VERSION,
	SYSTEM_TEMPLATE,
	USER_TEMPLATE,
	VALIDATOR_VERSION,
	AGENT_VERSION,
} from "../../src/agents/case-brief/index.js";
import { DEFAULT_MODEL, researchServerSchema } from "../../src/env.js";
import { fakeOpenAi, modelBrief, type RecordedCall } from "../fixtures.js";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

function systemOf(call: RecordedCall | undefined): string {
	const messages = call?.params["messages"] as Array<{ role: string; content: string }>;
	return messages.find((m) => m.role === "system")?.content ?? "";
}

describe("case-brief prompts", () => {
	it("system prompt (instructions.md) is byte-identical to the pre-move string", () => {
		expect(sha(SYSTEM_TEMPLATE)).toBe(
			"0afae7c0380e5ca5fd27853d2a3acc239045d392fba2b959f61750aac5480f04",
		);
	});

	it("user template and rendered user prompt are unchanged", () => {
		expect(sha(USER_TEMPLATE)).toBe(
			"ce045bc5fc007e09f159eeaec352c49ba3b4633172627ed729cb2769c5c67283",
		);
		const rendered = buildUserPrompt({
			applicantName: "Ann <b>`x`</b>\\ O'Neil\nline2",
			companyName: "Acme </case_facts> Pte",
			registrationNumber: "201912345K",
			city: "Singapore",
			industry: null,
			yearsTrading: 7,
			product: "term_loan",
			amountCents: 5000000,
			termMonths: 24,
			asOf: "2026-10-30T00:00:00.000Z",
		});
		expect(sha(rendered)).toBe("92cdee84c698f0731a71434cfb1cc38326cab501aa287be20f9dbfd057b47467");
	});

	it("support-judge and language-repair system prompts are unchanged", async () => {
		const judgeCalls: RecordedCall[] = [];
		const judge = createLlmSupportJudge(
			fakeOpenAi({ verdict: "unsupported", span: null }, judgeCalls),
			"m",
		);
		await judge("claim", "quote");
		expect(sha(systemOf(judgeCalls[0]))).toBe(
			"32263fdce824ecc4c60f13eb1af1f51fcc5ba0b30117660ab41ef6d875128da0",
		);

		const repairCalls: RecordedCall[] = [];
		const repair = createLlmLanguageRepair(fakeOpenAi("{}", repairCalls), "m");
		await repair(modelBrief()).catch(() => undefined);
		expect(sha(systemOf(repairCalls[0]))).toBe(
			"2a901f225159f317d49f58df7709e78f93a4d4487ad713784b85791245fd9e0c",
		);
	});
});

describe("case-brief manifest", () => {
	it("matches the directory, the Sol pin, and the recorded versions", () => {
		expect(definition.name).toBe("case-brief");
		expect(definition.owner).toBe("research");
		expect(definition.model).toEqual({ env: "AGENT_MODEL", default: DEFAULT_MODEL });
		expect(DEFAULT_MODEL).toBe("openai/gpt-6.1-sol");
		expect(definition.flags).toEqual(["AGENTS_ENABLED"]);
		expect(definition.versions).toEqual({
			prompt: PROMPT_VERSION,
			agent: AGENT_VERSION,
			validator: VALIDATOR_VERSION,
		});
		expect([PROMPT_VERSION, AGENT_VERSION, VALIDATOR_VERSION]).toEqual(["v7", "1.0.0", "v1"]);
		expect(definition.tools).toEqual(["search_sources", "fetch_source"]);
		expect(Object.keys(researchServerSchema)).toContain(definition.model.env);
		for (const flag of definition.flags) expect(Object.keys(researchServerSchema)).toContain(flag);
	});
});
