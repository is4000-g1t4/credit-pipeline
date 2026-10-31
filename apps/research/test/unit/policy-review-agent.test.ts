// Manifest guard for the policy-review agent (client side). There is no
// prompt here: the policy service owns the model call, so the manifest has
// no tools and its version is the contract recorded on persisted stages.
import { describe, expect, it } from "vitest";
import { definition, POLICY_PROMPT_VERSION } from "../../src/agents/policy-review/index.js";
import { researchServerSchema } from "../../src/env.js";

describe("policy-review manifest", () => {
	it("matches the directory, the Terra pin, the flag, and the recorded version", () => {
		expect(definition.name).toBe("policy-review");
		expect(definition.owner).toBe("research");
		expect(definition.model).toEqual({
			env: "POLICY_AGENT_MODEL",
			default: "openai/gpt-6.1-terra",
		});
		expect(definition.flags).toEqual(["POLICY_ASSIST_ENABLED"]);
		expect(POLICY_PROMPT_VERSION).toBe("policy-v1");
		expect(definition.versions).toEqual({ prompt: POLICY_PROMPT_VERSION });
		expect(definition.tools).toEqual([]);
		expect(definition.execution).toBe("temporal");
		for (const flag of definition.flags) expect(Object.keys(researchServerSchema)).toContain(flag);
	});
});
