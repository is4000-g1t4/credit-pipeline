// get_external_reports: Allowlisted bureau and bank report summaries.
import { z } from "zod";
import { defineAssistantTool } from "../tool-runtime.js";

const emptyParams = z.object({}).strict();

export const getExternalReports = defineAssistantTool({
	name: "get_external_reports",
	description: "Allowlisted bureau and bank report summaries for this application.",
	parameters: emptyParams,
	run: (rt) => rt.tools.getExternalReports(),
});
