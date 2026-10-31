import { SOURCE_TYPES, type EvidenceBundle } from "@credit/core";
import { z } from "zod";
import {
	SOURCE_TYPE_LIST,
	clampLimit,
	sourceTypeByRef,
	sourceTypeJsonSchema,
	toolError,
	uniqueSourceTypes,
	type EvidenceJsonParams,
	type MemoToolOutcome,
} from "./shared.js";

export const name = "list_evidence" as const;

export const description =
	"List evidence refs with labels, source types, and short excerpts. Use this first to cover the bundle; get_evidence returns fuller text.";

export const listEvidenceParams = z
	.object({
		sourceType: z.enum(SOURCE_TYPES).optional(),
		limit: z.number().int().min(1).max(50).optional(),
	})
	.strict();

export const listEvidenceJsonParams: EvidenceJsonParams = {
	type: "object",
	properties: {
		sourceType: sourceTypeJsonSchema(),
		limit: { type: "integer", minimum: 1, maximum: 50 },
	},
	required: [],
	// `true` to satisfy the SDK's non-strict JSON-schema type; the runtime
	// still ignores unknown fields via `asRecord` in the tool dispatcher.
	additionalProperties: true,
};

export function runListEvidence(
	params: Record<string, unknown>,
	evidence: EvidenceBundle,
): MemoToolOutcome {
	const sourceType = params["sourceType"];
	if (
		sourceType !== undefined &&
		(typeof sourceType !== "string" || !SOURCE_TYPE_LIST.includes(sourceType))
	) {
		return toolError("unknown sourceType");
	}
	const limit = clampLimit(params["limit"], 50, 50);
	const filtered = evidence.items.filter(
		(item) => sourceType === undefined || item.sourceType === sourceType,
	);
	const items = filtered.slice(0, limit).map((item) => ({
		ref: item.ref,
		label: item.label,
		sourceType: item.sourceType,
		// The model can draft/cite short structured facts directly; call
		// get_evidence only when the excerpt is truncated.
		excerpt: item.content.slice(0, 300),
	}));
	const refs = items.map((item) => item.ref);
	return {
		payload: { total: filtered.length, items },
		resultCount: items.length,
		sourceTypes: uniqueSourceTypes(refs, sourceTypeByRef(evidence)),
		refs,
	};
}
