// Pure evidence tools for the agentic memo writer (SPEC agentic-memo).
// No DB, no network, no cross-case reads: the tools project the passed
// `EvidenceBundle` only. One tool per file; this module is the allowlist
// dispatcher shared by the SDK runner and the scripted test doubles so
// fakes stay faithful to production tool behavior.
import type { EvidenceBundle } from "@credit/core";
import { runGetEvidence } from "./get-evidence.js";
import { runListEvidence } from "./list-evidence.js";
import { runListUnavailable } from "./list-unavailable.js";
import { runSearchEvidence } from "./search-evidence.js";
import { asRecord, toolError, type MemoToolOutcome } from "./shared.js";

export const MEMO_TOOL_NAMES = [
	"list_evidence",
	"search_evidence",
	"get_evidence",
	"list_unavailable",
] as const;

export type MemoToolName = (typeof MEMO_TOOL_NAMES)[number];

export { description as getEvidenceDescription, getEvidenceParams } from "./get-evidence.js";
export {
	description as listEvidenceDescription,
	listEvidenceJsonParams,
	listEvidenceParams,
} from "./list-evidence.js";
export {
	description as listUnavailableDescription,
	listUnavailableParams,
} from "./list-unavailable.js";
export {
	description as searchEvidenceDescription,
	searchEvidenceJsonParams,
	searchEvidenceParams,
} from "./search-evidence.js";
export type { MemoToolOutcome } from "./shared.js";

/** Run one allowlisted evidence tool. Unknown names and bad args are tool
 * errors in the payload (never throws), so the model can recover. */
export function runMemoEvidenceTool(
	name: string,
	args: unknown,
	evidence: EvidenceBundle,
): MemoToolOutcome {
	const params = asRecord(args);
	switch (name) {
		case "list_evidence":
			return runListEvidence(params, evidence);
		case "search_evidence":
			return runSearchEvidence(params, evidence);
		case "get_evidence":
			return runGetEvidence(params, evidence);
		case "list_unavailable":
			return runListUnavailable(params, evidence);
		default:
			return toolError(`unknown tool: ${name.slice(0, 80)}`);
	}
}
