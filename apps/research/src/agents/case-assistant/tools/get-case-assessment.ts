// get_case_assessment: score, policy evaluation, decision, status, dates from
// the once-per-run assistant-context read. Documents come from the sibling
// get_documents tool, never from here.
import { z } from "zod";
import { defineAssistantTool } from "../tool-runtime.js";

const emptyParams = z.object({}).strict();

export const getCaseAssessment = defineAssistantTool({
	name: "get_case_assessment",
	description: "Case assessment: score, policy evaluation, decision, status, and dates.",
	parameters: emptyParams,
	run: async (rt) => {
		const body = await rt.loadAssistantContext();
		return {
			score: body["score"] ?? null,
			policyEvaluation: body["policyEvaluation"] ?? null,
			decision: body["decision"] ?? null,
			status: body["status"] ?? null,
			submittedAt: body["submittedAt"] ?? null,
			decidedAt: body["decidedAt"] ?? null,
		};
	},
});
