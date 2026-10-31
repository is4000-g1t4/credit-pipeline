// Per-run runtime handed to every case-assistant tool (agent-private). The
// tool files in ./tools stay thin: they describe the tool to the model and
// read through this runtime; budgeting, tracing and JSON encoding live in
// agent.ts so they apply to every tool the same way.
import type { z } from "zod";
import type { ContextTools } from "../context-analyst/index.js";

export interface PolicySearchOutcome {
	sections: unknown[];
	/** Set when the policy service was unreachable or refused. */
	unavailable?: string;
}

export interface AssistantToolRuntime {
	/** Case-scoped read-only screens (shared with the context analyst). */
	tools: ContextTools;
	/** assistant-context, fetched once per run; throws when unavailable. */
	loadAssistantContext(): Promise<Record<string, unknown>>;
	/** Scrubbed policy search; records cited-section candidates. */
	searchPolicy(query: string): Promise<PolicySearchOutcome>;
	/** Officer-visible data gaps collected during the run. */
	limitations: string[];
}

export interface AssistantToolSpec<S extends z.ZodObject> {
	name: string;
	description: string;
	parameters: S;
	/** The read itself; the runner JSON-encodes the result for the model. */
	run(rt: AssistantToolRuntime, args: z.infer<S>): unknown;
}

/** Identity helper: pins each spec's `run` argument type to its schema. */
export function defineAssistantTool<S extends z.ZodObject>(
	spec: AssistantToolSpec<S>,
): AssistantToolSpec<S> {
	return spec;
}
