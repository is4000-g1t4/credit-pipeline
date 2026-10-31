// get_external_reports: allowlisted bureau and bank report summaries.
import {
	ContextToolError,
	emptyParams,
	type ContextToolSpec,
	type ToolContext,
} from "../tool-context.js";

export const getExternalReports = {
	name: "get_external_reports",
	description: "Allowlisted bureau and bank report summaries for this application.",
	parameters: emptyParams,
	async run(ctx: ToolContext): Promise<unknown> {
		const body = (await ctx.get(
			`/internal/applications/${ctx.deps.applicationId}/context/external-reports`,
		)) as { reports?: unknown };
		if (!body || !Array.isArray(body.reports)) {
			throw new ContextToolError("external-reports shape drift");
		}
		return body;
	},
} satisfies ContextToolSpec<void>;
