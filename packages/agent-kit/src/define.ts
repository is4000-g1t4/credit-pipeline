// eve-style agent manifest: every `agents/<name>/agent.ts` exports one
// `defineAgent({...})` describing what the agent is, which model pin and
// flags gate it, and which prompt/agent/validator versions it records on
// traces. Runtime behaviour stays in the agent's own runner; this is the
// single place to read an agent's identity.

export type AgentOwner = "research" | "applications" | "policy";

export interface AgentDefinition {
	/** Stable kebab-case id; matches the directory name. */
	name: string;
	owner: AgentOwner;
	/** One-line purpose. Advisory only: no agent decides, scores, prices, or books. */
	description: string;
	model: {
		/** Env var that selects the model (validated by the service env). */
		env: string;
		/** Pinned default (Terra/Sol per AGENTS.md). */
		default: string;
	};
	/** Feature flags that must all be on (defaults off). */
	flags: readonly string[];
	/** Versions recorded on traces and eval results. */
	versions: {
		prompt: string;
		agent?: string;
		validator?: string;
	};
	/** Tool names the model may call (empty for single-shot drafters). */
	tools: readonly string[];
	/** How it runs: durable Temporal run, or inline in the HTTP request. */
	execution: "temporal" | "request";
}

export function defineAgent<const T extends AgentDefinition>(definition: T): Readonly<T> {
	if (!/^[a-z][a-z0-9-]*$/.test(definition.name)) {
		throw new Error(`agent name must be kebab-case: ${definition.name}`);
	}
	return Object.freeze(definition);
}
