// Metadata-only tool trace entries for the case assistant: counts and source
// types, never arguments, results, or text.
import type { CaseAssistantToolTrace } from "./types.js";

/** Array-valued snapshots: count rows, not the wrapper object. */
const RESULT_ARRAY_KEYS: Record<string, string> = {
	list_accounts: "accounts",
	get_transactions: "items",
	get_cashflow_metrics: "signals",
	get_document_findings: "findings",
	get_credit_history: "priorApplications",
	get_external_reports: "reports",
	get_kyc_checks: "checks",
	get_loans: "loans",
	search_policy: "sections",
};

/** Metadata-only trace entry: counts, never args/results/text. */
export function toolTraceEntry(name: string, result: unknown): CaseAssistantToolTrace {
	let resultCount: number;
	if (Array.isArray(result)) {
		resultCount = result.length;
	} else if (result === null || result === undefined) {
		resultCount = 0;
	} else {
		const key = RESULT_ARRAY_KEYS[name];
		const nested =
			key && typeof result === "object" ? (result as Record<string, unknown>)[key] : null;
		resultCount = Array.isArray(nested) ? nested.length : 1;
	}
	return { name, resultCount, sourceTypes: sourceTypesFor(name) };
}

export function sourceTypesFor(name: string): string[] {
	switch (name) {
		case "search_policy":
			return ["policy"];
		case "get_case_facts":
		case "get_case_assessment":
			return ["case"];
		case "get_customer_summary":
			return ["customer"];
		case "list_accounts":
			return ["accounts"];
		case "get_transactions":
			return ["transactions"];
		case "get_cashflow_metrics":
			return ["cashflow"];
		case "get_application_financials":
			return ["financials"];
		case "get_document_findings":
		case "get_documents":
			return ["documents"];
		case "get_credit_history":
			return ["credit history"];
		case "get_external_reports":
			return ["bureau/bank"];
		case "get_kyc_checks":
			return ["kyc"];
		case "get_loans":
			return ["loans"];
		case "get_external_research_summary":
			return ["research"];
		default:
			return ["case"];
	}
}
