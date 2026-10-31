// get_customer_summary: segment, tenure, KYC state.
import {
	ContextToolError,
	emptyParams,
	type ContextToolSpec,
	type ToolContext,
} from "../tool-context.js";

export const getCustomerSummary = {
	name: "get_customer_summary",
	description: "Customer segment, tenure, and KYC state.",
	parameters: emptyParams,
	async run(ctx: ToolContext): Promise<unknown> {
		const body = (await ctx.get(
			`/internal/applications/${ctx.deps.applicationId}/context/profile`,
		)) as {
			customer?: unknown;
			city?: unknown;
			asOf?: unknown;
		};
		if (!body || typeof body !== "object" || !body.customer) {
			throw new ContextToolError("customer summary shape drift");
		}
		return { customer: body.customer, city: body.city ?? null, asOf: body.asOf ?? null };
	},
} satisfies ContextToolSpec<void>;
