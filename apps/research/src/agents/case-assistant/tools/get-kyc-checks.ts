// get_kyc_checks: KYC check results.
import { z } from "zod";
import { defineAssistantTool } from "../tool-runtime.js";

const emptyParams = z.object({}).strict();

export const getKycChecks = defineAssistantTool({
	name: "get_kyc_checks",
	description: "Application KYC check results.",
	parameters: emptyParams,
	run: (rt) => rt.tools.getKycChecks(),
});
