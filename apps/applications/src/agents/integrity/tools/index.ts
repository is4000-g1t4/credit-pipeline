// US-INT-1/2/3 allowlisted tools over the immutable IntegritySource.
//
// Pure: no DB, no network, no logging. Ids are resolved from the snapshot
// map, never from the model. Every payload is capped; text never reaches a
// trace. One tool per file; this module is the allowlist dispatcher.
import type { IntegritySource } from "../../../integrity/types.js";
import * as getCustomerPage from "./get-customer-page.js";
import * as getDuplicateContext from "./get-duplicate-context.js";
import * as getPage from "./get-page.js";
import * as listCustomerEvidence from "./list-customer-evidence.js";
import * as listDocuments from "./list-documents.js";
import * as listSignals from "./list-signals.js";
import * as searchPages from "./search-pages.js";
import { EMPTY, type ToolOutcome } from "./shared.js";

export const INTEGRITY_TOOL_NAMES = [
	"list_documents",
	"search_pages",
	"get_page",
	"list_customer_evidence",
	"get_customer_page",
	"list_signals",
	"get_duplicate_context",
] as const;

export type IntegrityToolName = (typeof INTEGRITY_TOOL_NAMES)[number];

const ANALYSIS_TOOLS: ReadonlySet<IntegrityToolName> = new Set([
	"list_documents",
	"search_pages",
	"get_page",
	"list_signals",
]);

export { listDocumentsParams } from "./list-documents.js";
export { searchPagesParams } from "./search-pages.js";
export { getPageParams } from "./get-page.js";
export { listCustomerEvidenceParams } from "./list-customer-evidence.js";
export { getCustomerPageParams } from "./get-customer-page.js";
export { listSignalsParams } from "./list-signals.js";
export { getDuplicateContextParams } from "./get-duplicate-context.js";
export { makeToolCall, toolNameForTrace, type ToolOutcome } from "./shared.js";

/** Model-facing definition (description + zod parameters) for one tool. */
export function integrityToolConfig(name: IntegrityToolName): {
	parameters: unknown;
	description: string;
} {
	switch (name) {
		case "list_documents":
			return {
				parameters: listDocuments.listDocumentsParams,
				description: listDocuments.description,
			};
		case "search_pages":
			return { parameters: searchPages.searchPagesParams, description: searchPages.description };
		case "get_page":
			return { parameters: getPage.getPageParams, description: getPage.description };
		case "list_customer_evidence":
			return {
				parameters: listCustomerEvidence.listCustomerEvidenceParams,
				description: listCustomerEvidence.description,
			};
		case "get_customer_page":
			return {
				parameters: getCustomerPage.getCustomerPageParams,
				description: getCustomerPage.description,
			};
		case "list_signals":
			return { parameters: listSignals.listSignalsParams, description: listSignals.description };
		case "get_duplicate_context":
			return {
				parameters: getDuplicateContext.getDuplicateContextParams,
				description: getDuplicateContext.description,
			};
	}
}

/** Pure tool dispatcher. Unknown tools and bad args return an error payload,
 * never throw; the runner still counts the call against the budget. */
export function runIntegrityTool(
	name: string,
	args: unknown,
	source: IntegritySource,
	mode: "analysis" | "triage",
): ToolOutcome {
	if (!INTEGRITY_TOOL_NAMES.includes(name as IntegrityToolName)) {
		return { ...EMPTY, payload: { error: "unknown tool" } };
	}
	const tool = name as IntegrityToolName;
	if (mode === "analysis" && !ANALYSIS_TOOLS.has(tool)) {
		return { ...EMPTY, payload: { error: "tool is not allowlisted for this run" } };
	}
	switch (tool) {
		case "list_documents":
			return listDocuments.runListDocuments(source);
		case "search_pages":
			return searchPages.runSearchPages(source, args);
		case "get_page":
			return getPage.runGetPage(source, args);
		case "list_customer_evidence":
			return listCustomerEvidence.runListCustomerEvidence(source);
		case "get_customer_page":
			return getCustomerPage.runGetCustomerPage(source, args);
		case "list_signals":
			return listSignals.runListSignals(source);
		case "get_duplicate_context":
			return getDuplicateContext.runGetDuplicateContext(source);
	}
}
