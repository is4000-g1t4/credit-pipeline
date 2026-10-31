// list_accounts: Owned accounts.
import { z } from "zod";
import { defineAssistantTool } from "../tool-runtime.js";

const emptyParams = z.object({}).strict();

export const listAccounts = defineAssistantTool({
	name: "list_accounts",
	description: "Owned account ids, types, currencies, status.",
	parameters: emptyParams,
	run: (rt) => rt.tools.listAccounts(),
});
