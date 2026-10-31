// get_document_findings: Document finding metadata, never document text.
import { z } from "zod";
import { defineAssistantTool } from "../tool-runtime.js";

const emptyParams = z.object({}).strict();

export const getDocumentFindings = defineAssistantTool({
	name: "get_document_findings",
	description: "Document finding metadata with expected/observed values (no document text).",
	parameters: emptyParams,
	run: (rt) => rt.tools.getDocumentFindings(),
});
