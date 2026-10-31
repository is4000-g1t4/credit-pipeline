// get_loans: Existing loans and open EWS alerts.
import { z } from "zod";
import { defineAssistantTool } from "../tool-runtime.js";

const emptyParams = z.object({}).strict();

export const getLoans = defineAssistantTool({
	name: "get_loans",
	description: "Existing loans, installment/overdue counts, and open EWS alerts for the applicant.",
	parameters: emptyParams,
	run: (rt) => rt.tools.getLoans(),
});
