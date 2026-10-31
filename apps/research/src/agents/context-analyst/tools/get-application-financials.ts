// get_application_financials: declared financial block, purpose, and request details.
import {
	ContextToolError,
	emptyParams,
	type ContextToolSpec,
	type ToolContext,
} from "../tool-context.js";

export const getApplicationFinancials = {
	name: "get_application_financials",
	description: "Declared application financial block, purpose, and request details.",
	parameters: emptyParams,
	async run(ctx: ToolContext): Promise<unknown> {
		const body = (await ctx.get(
			`/internal/applications/${ctx.deps.applicationId}/context/financials`,
		)) as Record<string, unknown>;
		if (!body || typeof body !== "object") throw new ContextToolError("financials shape drift");
		return body;
	},
} satisfies ContextToolSpec<void>;
