// get_external_research_summary: Validated external brief claims (no HTTP).
import { z } from "zod";
import { defineAssistantTool } from "../tool-runtime.js";

const emptyParams = z.object({}).strict();

export const getExternalResearchSummary = defineAssistantTool({
	name: "get_external_research_summary",
	description: "Validated external brief claims, or null when external research is absent.",
	parameters: emptyParams,
	run: (rt) => rt.tools.getExternalResearchSummary(),
});
