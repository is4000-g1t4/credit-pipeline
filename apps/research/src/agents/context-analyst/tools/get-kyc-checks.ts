// get_kyc_checks: application KYC check results.
import {
	ContextToolError,
	emptyParams,
	type ContextToolSpec,
	type ToolContext,
} from "../tool-context.js";

export const getKycChecks = {
	name: "get_kyc_checks",
	description: "Application KYC check results.",
	parameters: emptyParams,
	async run(ctx: ToolContext): Promise<unknown> {
		const body = (await ctx.get(
			`/internal/applications/${ctx.deps.applicationId}/context/kyc-checks`,
		)) as { checks?: unknown };
		if (!body || !Array.isArray(body.checks)) {
			throw new ContextToolError("kyc-checks shape drift");
		}
		return body;
	},
} satisfies ContextToolSpec<void>;
