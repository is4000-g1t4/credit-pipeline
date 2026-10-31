// get_customer_summary: Customer segment, tenure, KYC state.
import { z } from "zod";
import { defineAssistantTool } from "../tool-runtime.js";

const emptyParams = z.object({}).strict();

export const getCustomerSummary = defineAssistantTool({
	name: "get_customer_summary",
	description: "Customer segment, tenure, and KYC state.",
	parameters: emptyParams,
	run: (rt) => rt.tools.getCustomerSummary(),
});
