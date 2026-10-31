// get_external_research_summary: the validated external brief claims,
// from the closure (no HTTP). Structured validated claims only — never raw
// web text.
import { emptyParams, type ContextToolSpec, type ToolContext } from "../tool-context.js";

export const getExternalResearchSummary = {
	name: "get_external_research_summary",
	description: "Validated external brief claims, or null when external failed.",
	parameters: emptyParams,
	run(ctx: ToolContext): unknown {
		ctx.budget();
		return ctx.deps.externalSummary ?? null;
	},
} satisfies ContextToolSpec<void>;
