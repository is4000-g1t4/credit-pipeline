// list_accounts: owned account ids, types, currencies, status.
import {
	ContextToolError,
	emptyParams,
	type ContextToolSpec,
	type ToolContext,
} from "../tool-context.js";

export const listAccounts = {
	name: "list_accounts",
	description: "Owned account ids, types, currencies, status.",
	parameters: emptyParams,
	async run(ctx: ToolContext): Promise<unknown> {
		const body = (await ctx.get(
			`/internal/applications/${ctx.deps.applicationId}/context/accounts`,
		)) as {
			accounts?: Array<{ id?: unknown }>;
		};
		if (!body || !Array.isArray(body.accounts)) {
			throw new ContextToolError("accounts shape drift");
		}
		for (const a of body.accounts) {
			if (typeof a.id === "string") ctx.seen(a.id, "account");
		}
		return { accounts: body.accounts };
	},
} satisfies ContextToolSpec<void>;
