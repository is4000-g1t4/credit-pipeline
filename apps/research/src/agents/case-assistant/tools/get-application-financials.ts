// get_application_financials: Declared financial block.
import { z } from "zod";
import { defineAssistantTool } from "../tool-runtime.js";

const emptyParams = z.object({}).strict();

export const getApplicationFinancials = defineAssistantTool({
	name: "get_application_financials",
	description: "Declared application financial block, purpose, and request details.",
	parameters: emptyParams,
	run: (rt) => rt.tools.getApplicationFinancials(),
});
