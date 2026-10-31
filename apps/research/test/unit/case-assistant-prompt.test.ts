// Prompt-integrity guard for the case-assistant agent. The hash was
// recorded from the pre-move string (src/case-assistant.ts). Any edit to
// instructions.md must bump CASE_ASSISTANT_PROMPT_VERSION and update the
// hash here on purpose.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	CASE_ASSISTANT_AGENT_VERSION,
	CASE_ASSISTANT_PROMPT_VERSION,
	CASE_ASSISTANT_SYSTEM,
	definition,
} from "../../src/agents/case-assistant/index.js";
import { researchServerSchema } from "../../src/env.js";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

describe("case-assistant prompt", () => {
	it("system prompt (instructions.md) is byte-identical to the pre-move string", () => {
		expect(sha(CASE_ASSISTANT_SYSTEM)).toBe(
			"f54e29e35ac02071485d01a4668c163e6be9f39993bfffe850bef10c66417b04",
		);
	});
});

describe("case-assistant manifest", () => {
	it("matches the directory, the Terra pin, the flag, and the recorded versions", () => {
		expect(definition.name).toBe("case-assistant");
		expect(definition.owner).toBe("research");
		expect(definition.model).toEqual({
			env: "CASE_ASSISTANT_MODEL",
			default: "openai/gpt-6.1-terra",
		});
		expect(definition.flags).toEqual(["CASE_ASSISTANT_ENABLED"]);
		expect([CASE_ASSISTANT_PROMPT_VERSION, CASE_ASSISTANT_AGENT_VERSION]).toEqual([
			"case-assistant-v3",
			"case-assistant-v1",
		]);
		expect(definition.versions).toEqual({
			prompt: CASE_ASSISTANT_PROMPT_VERSION,
			agent: CASE_ASSISTANT_AGENT_VERSION,
		});
		expect(definition.execution).toBe("request");
		expect(definition.tools).toEqual([
			"get_case_facts",
			"get_case_assessment",
			"get_documents",
			"get_customer_summary",
			"list_accounts",
			"get_transactions",
			"get_cashflow_metrics",
			"get_application_financials",
			"get_document_findings",
			"get_credit_history",
			"get_external_reports",
			"get_kyc_checks",
			"get_loans",
			"get_external_research_summary",
			"search_policy",
		]);
		expect(Object.keys(researchServerSchema)).toContain(definition.model.env);
		for (const flag of definition.flags) expect(Object.keys(researchServerSchema)).toContain(flag);
	});
});
