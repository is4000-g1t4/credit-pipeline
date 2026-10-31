// get_credit_history: Prior applications for the same applicant.
import { z } from "zod";
import { defineAssistantTool } from "../tool-runtime.js";

const emptyParams = z.object({}).strict();

export const getCreditHistory = defineAssistantTool({
	name: "get_credit_history",
	description: "Prior applications and decisions for the same applicant, before this case.",
	parameters: emptyParams,
	run: (rt) => rt.tools.getCreditHistory(),
});
