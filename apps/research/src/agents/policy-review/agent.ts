// Case policy review, client side. Research does not call a model here: it
// builds a PII-free case context from validated signals, signs a case token,
// and asks the policy service (which owns the policy-answerer agent and its
// model pin) to explain the case. The stage runner is policy-exec.ts; the
// HTTP client is policy-stage.ts. The reply is advisory text with policy
// citations — it never feeds a score, decision, or term.
import { defineAgent } from "@credit/agent-kit";

/** Prompt/contract version recorded on persisted policy stages. */
export const POLICY_PROMPT_VERSION = "policy-v1";

export const definition = defineAgent({
	name: "policy-review",
	owner: "research",
	description:
		"Client side of the automatic case policy review: PII-free context out, cited policy sections back.",
	// The model runs in the policy service (POLICY_AGENT_MODEL there); the
	// pin is declared here so the manifest names what the stage depends on.
	model: { env: "POLICY_AGENT_MODEL", default: "openai/gpt-6.1-terra" },
	flags: ["POLICY_ASSIST_ENABLED"],
	versions: { prompt: POLICY_PROMPT_VERSION },
	tools: [],
	execution: "temporal",
});
