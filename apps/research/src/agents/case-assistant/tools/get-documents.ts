// get_documents: document metadata from the once-per-run assistant-context
// read. Never document text.
import { z } from "zod";
import { defineAssistantTool } from "../tool-runtime.js";

const emptyParams = z.object({}).strict();

export const getDocuments = defineAssistantTool({
	name: "get_documents",
	description: "Case document metadata (ids, types, status). Never document text.",
	parameters: emptyParams,
	run: async (rt) => {
		const body = await rt.loadAssistantContext();
		return body["documents"] ?? [];
	},
});
