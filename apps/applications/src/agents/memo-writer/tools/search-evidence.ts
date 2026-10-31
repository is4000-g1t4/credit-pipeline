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

export const name = "search_evidence" as const;

export const description =
	"Case-insensitive token search over evidence labels, content, and metadata. Returns short excerpts, not full content.";

export const searchEvidenceParams = z
	.object({
		query: z.string(),
		sourceType: z.enum(SOURCE_TYPES).optional(),
		limit: z.number().int().min(1).max(20).optional(),
	})
	.strict();

export const searchEvidenceJsonParams: EvidenceJsonParams = {
	type: "object",
	properties: {
		query: { type: "string" },
		sourceType: sourceTypeJsonSchema(),
		limit: { type: "integer", minimum: 1, maximum: 20 },
	},
	required: ["query"],
	// `true` to satisfy the SDK's non-strict JSON-schema type; the runtime
	// still ignores unknown fields via `asRecord` in the tool dispatcher.
	additionalProperties: true,
};

export function runSearchEvidence(
	params: Record<string, unknown>,
	evidence: EvidenceBundle,
): MemoToolOutcome {
	const query = params["query"];
	if (typeof query !== "string" || query.trim().length === 0) {
		return toolError("query is required");
	}
	const sourceType = params["sourceType"];
	if (
		sourceType !== undefined &&
		(typeof sourceType !== "string" || !SOURCE_TYPE_LIST.includes(sourceType))
	) {
		return toolError("unknown sourceType");
	}
	const limit = clampLimit(params["limit"], 10, 20);
	const tokens = query
		.toLowerCase()
		.split(/\s+/)
		.filter((token) => token.length > 0);
	if (tokens.length === 0) return toolError("query is required");
	const matched = evidence.items.filter((item) => {
		if (sourceType !== undefined && item.sourceType !== sourceType) return false;
		const haystack = `${item.label} ${item.content} ${JSON.stringify(item.metadata)}`.toLowerCase();
		return tokens.every((token) => haystack.includes(token));
	});
	const items = matched.slice(0, limit).map((item) => ({
		ref: item.ref,
		label: item.label,
		sourceType: item.sourceType,
		// ponytail: 500-char excerpt; full text needs get_evidence.
		excerpt: item.content.slice(0, 500),
	}));
	const refs = items.map((item) => item.ref);
	return {
		payload: { total: matched.length, items },
		resultCount: items.length,
		sourceTypes: uniqueSourceTypes(refs, sourceTypeByRef(evidence)),
		refs,
	};
}
