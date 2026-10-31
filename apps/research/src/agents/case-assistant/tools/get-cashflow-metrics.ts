// get_cashflow_metrics: Deterministic cashflow candidate signals (unscoped).
import { z } from "zod";
import { defineAssistantTool } from "../tool-runtime.js";

const emptyParams = z.object({}).strict();

export const getCashflowMetrics = defineAssistantTool({
	name: "get_cashflow_metrics",
	description: "Deterministic cashflow candidate signals with baselines and evidence ids.",
	parameters: emptyParams,
	run: (rt) => rt.tools.getCashflowMetrics({}),
});
