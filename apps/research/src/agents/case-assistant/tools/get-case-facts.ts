// get_case_facts: Allowlisted application facts (no HTTP).
import { z } from "zod";
import { defineAssistantTool } from "../tool-runtime.js";

const emptyParams = z.object({}).strict();

export const getCaseFacts = defineAssistantTool({
	name: "get_case_facts",
	description: "The application facts for this case.",
	parameters: emptyParams,
	run: (rt) => rt.tools.getCaseFacts(),
});
