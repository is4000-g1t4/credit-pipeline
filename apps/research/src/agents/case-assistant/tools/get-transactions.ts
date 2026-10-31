// get_transactions: one bounded page for one owned account (descriptions and
// counterparties are already stripped by the shared context toolkit).
import { z } from "zod";
import { defineAssistantTool } from "../tool-runtime.js";

const transactionsParams = z
	.object({ accountId: z.string().min(1).max(100), cursor: z.string().max(2000) })
	.strict();

export const getTransactions = defineAssistantTool({
	name: "get_transactions",
	description: 'Bounded transaction page for one owned account. Pass cursor="" for the first page.',
	parameters: transactionsParams,
	run: (rt, args) => rt.tools.getTransactions(args),
});
