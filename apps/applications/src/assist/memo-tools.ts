// Pure evidence tools for the agentic memo writer (SPEC agentic-memo).
// No DB, no network, no cross-case reads: the tools project the passed
// `EvidenceBundle` only. Shared by the SDK runner and the scripted test
// doubles so fakes stay faithful to production tool behavior.
import { SOURCE_TYPES, type EvidenceBundle } from "@credit/core";
import { z } from "zod";

export const MEMO_TOOL_NAMES = [
	"list_evidence",
	"search_evidence",
	"get_evidence",
	"list_unavailable",
] as const;

export type MemoToolName = (typeof MEMO_TOOL_NAMES)[number];

export const listEvidenceParams = z
	.object({
		sourceType: z.enum(SOURCE_TYPES).optional(),
		limit: z.number().int().min(1).max(50).optional(),
	})
	.strict();

export const searchEvidenceParams = z
	.object({
		query: z.string(),
		sourceType: z.enum(SOURCE_TYPES).optional(),
		limit: z.number().int().min(1).max(20).optional(),
	})
	.strict();

export const getEvidenceParams = z.object({ ref: z.string() }).strict();

export const listUnavailableParams = z.object({}).strict();

const SOURCE_TYPE_LIST = [...SOURCE_TYPES] as string[];

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function clampLimit(value: unknown, def: number, max: number): number {
	return typeof value === "number" && Number.isInteger(value)
		? Math.min(Math.max(value, 1), max)
		: def;
}

export interface MemoToolOutcome {
	payload: unknown;
	resultCount: number;
	sourceTypes: string[];
	refs: string[];
}

function uniqueSourceTypes(refs: string[], items: Map<string, string>): string[] {
	const types = new Set<string>();
	for (const ref of refs) {
		const type = items.get(ref);
		if (type) types.add(type);
	}
	return [...types].sort();
}

function toolError(message: string): MemoToolOutcome {
	return {
		payload: { error: message },
		resultCount: 0,
		sourceTypes: [],
		refs: [],
	};
}

/** Run one allowlisted evidence tool. Unknown names and bad args are tool
 * errors in the payload (never throws), so the model can recover. */
export function runMemoEvidenceTool(
	name: string,
	args: unknown,
	evidence: EvidenceBundle,
): MemoToolOutcome {
	const params = asRecord(args);
	const byRef = new Map(evidence.items.map((item) => [item.ref, item]));
	const error = toolError;
	switch (name) {
		case "list_evidence": {
			const sourceType = params["sourceType"];
			if (
				sourceType !== undefined &&
				(typeof sourceType !== "string" || !SOURCE_TYPE_LIST.includes(sourceType))
			) {
				return error("unknown sourceType");
			}
			const limit = clampLimit(params["limit"], 20, 50);
			const filtered = evidence.items.filter(
				(item) => sourceType === undefined || item.sourceType === sourceType,
			);
			const items = filtered.slice(0, limit).map((item) => ({
				ref: item.ref,
				label: item.label,
				sourceType: item.sourceType,
			}));
			const refs = items.map((item) => item.ref);
			return {
				payload: { total: filtered.length, items },
				resultCount: items.length,
				sourceTypes: uniqueSourceTypes(
					refs,
					new Map(evidence.items.map((i) => [i.ref, i.sourceType])),
				),
				refs,
			};
		}
		case "search_evidence": {
			const query = params["query"];
			if (typeof query !== "string" || query.trim().length === 0) {
				return error("query is required");
			}
			const sourceType = params["sourceType"];
			if (
				sourceType !== undefined &&
				(typeof sourceType !== "string" || !SOURCE_TYPE_LIST.includes(sourceType))
			) {
				return error("unknown sourceType");
			}
			const limit = clampLimit(params["limit"], 10, 20);
			const tokens = query
				.toLowerCase()
				.split(/\s+/)
				.filter((token) => token.length > 0);
			if (tokens.length === 0) return error("query is required");
			const matched = evidence.items.filter((item) => {
				if (sourceType !== undefined && item.sourceType !== sourceType) return false;
				const haystack =
					`${item.label} ${item.content} ${JSON.stringify(item.metadata)}`.toLowerCase();
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
				sourceTypes: uniqueSourceTypes(
					refs,
					new Map(evidence.items.map((i) => [i.ref, i.sourceType])),
				),
				refs,
			};
		}
		case "get_evidence": {
			if (typeof params["ref"] !== "string" || params["ref"].length === 0) {
				return error("ref is required");
			}
			const item = byRef.get(params["ref"]);
			if (!item) return error("unknown evidence ref");
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
		case "list_unavailable": {
			const items = evidence.unavailable.map((item) => ({
				ref: item.ref,
				sourceType: item.sourceType,
				code: item.code,
				...(item.detail ? { detail: item.detail } : {}),
			}));
			const refs = items.map((item) => item.ref);
			return {
				payload: { total: items.length, items },
				resultCount: items.length,
				sourceTypes: [...new Set(items.map((item) => item.sourceType))].sort(),
				refs,
			};
		}
		default:
			return error(`unknown tool: ${name.slice(0, 80)}`);
	}
}
