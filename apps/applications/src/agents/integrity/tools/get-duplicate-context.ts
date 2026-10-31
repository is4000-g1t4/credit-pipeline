import { z } from "zod";
import type { IntegritySource } from "../../../integrity/types.js";
import { MAX_REFS_PER_CALL, type ToolOutcome } from "./shared.js";

export const name = "get_duplicate_context" as const;

export const description =
	"Return duplicate-hash counts and matching document ids without other-application references.";

export const getDuplicateContextParams = z.object({}).strict();

export function runGetDuplicateContext(source: IntegritySource): ToolOutcome {
	const matches = source.duplicateMatches.slice(0, MAX_REFS_PER_CALL).map((match) => ({
		matchingDocumentFileId: match.matchingDocumentFileId,
		kind: match.kind,
		relation: match.relation,
		ref: `context_signal:duplicate_document:${match.matchingDocumentFileId}`,
	}));
	return {
		payload: {
			counts: source.duplicateCounts,
			matches,
			note: "Counts only; no other-application identifiers or applicant data.",
		},
		resultCount: matches.length + 1,
		sourceTypes: ["context_signal"],
		refs: matches.slice(0, MAX_REFS_PER_CALL).map((match) => match.ref),
	};
}
