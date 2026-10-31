// get_credit_history: prior applications and decisions for the same applicant.
import {
	ContextToolError,
	emptyParams,
	type ContextToolSpec,
	type ToolContext,
} from "../tool-context.js";

export const getCreditHistory = {
	name: "get_credit_history",
	description: "Prior applications and decisions for the same applicant, before this case.",
	parameters: emptyParams,
	async run(ctx: ToolContext): Promise<unknown> {
		const body = (await ctx.get(
			`/internal/applications/${ctx.deps.applicationId}/context/credit-history`,
		)) as { priorApplications?: unknown };
		if (!body || !Array.isArray(body.priorApplications)) {
			throw new ContextToolError("credit-history shape drift");
		}
		return body;
	},
} satisfies ContextToolSpec<void>;
