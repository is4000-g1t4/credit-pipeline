// get_case_facts: allowlisted application facts, from the closure (no HTTP).
import { emptyParams, type ContextToolSpec, type ToolContext } from "../tool-context.js";

export const getCaseFacts = {
	name: "get_case_facts",
	description: "The application facts for this case.",
	parameters: emptyParams,
	run(ctx: ToolContext): unknown {
		ctx.budget();
		const f = ctx.deps.caseFacts;
		// Allowlisted case facts only — consent never rides the prompt.
		return {
			reference: f["reference"] ?? null,
			type: f["type"] ?? null,
			product: f["product"] ?? null,
			amountCents: f["amountCents"] ?? null,
			termMonths: f["termMonths"] ?? null,
			applicantName: f["applicantName"] ?? null,
			companyName: f["companyName"] ?? null,
			registrationNumber: f["registrationNumber"] ?? null,
			industry: f["industry"] ?? null,
			yearsTrading: f["yearsTrading"] ?? null,
			city: f["city"] ?? null,
			status: f["status"] ?? null,
			submittedAt: f["submittedAt"] ?? null,
			asOf: f["asOf"] ?? null,
		};
	},
} satisfies ContextToolSpec<void>;
