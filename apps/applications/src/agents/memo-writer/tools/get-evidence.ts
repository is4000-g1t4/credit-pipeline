import type { EvidenceBundle } from "@credit/core";
import { z } from "zod";
import { toolError, type MemoToolOutcome } from "./shared.js";

export const name = "get_evidence" as const;

export const description =
	"Return one evidence item by exact ref. Content is capped at 4,000 characters.";

export const getEvidenceParams = z.object({ ref: z.string() }).strict();

export function runGetEvidence(
	params: Record<string, unknown>,
	evidence: EvidenceBundle,
): MemoToolOutcome {
	if (typeof params["ref"] !== "string" || params["ref"].length === 0) {
		return toolError("ref is required");
	}
	const byRef = new Map(evidence.items.map((item) => [item.ref, item]));
	const item = byRef.get(params["ref"]);
	if (!item) return toolError("unknown evidence ref");
	return {
		payload: {
			ref: item.ref,
			sourceType: item.sourceType,
			label: item.label,
			content: item.content.slice(0, 4_000),
			metadata: item.metadata,
		},
		resultCount: 1,
		sourceTypes: [item.sourceType],
		refs: [item.ref],
	};
}
