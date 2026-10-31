// search_policy: credit policy sections relevant to a question. The query is
// scrubbed of known case identity before it leaves; a failure is an explicit
// data gap on the officer-visible limitations, never a silent empty result.
import { z } from "zod";
import { defineAssistantTool } from "../tool-runtime.js";

const searchPolicyParams = z.object({ query: z.string().min(1).max(1000) }).strict();

export const searchPolicy = defineAssistantTool({
	name: "search_policy",
	description:
		"Search credit policy sections relevant to a question. Returns compact sections with quotes and drawer tokens.",
	parameters: searchPolicyParams,
	run: async (rt, args) => {
		const out = await rt.searchPolicy(args.query);
		if (out.unavailable) rt.limitations.push("Policy search unavailable.");
		return out;
	},
});
