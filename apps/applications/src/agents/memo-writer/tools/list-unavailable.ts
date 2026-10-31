import type { EvidenceBundle } from "@credit/core";
import { z } from "zod";
import type { MemoToolOutcome } from "./shared.js";

export const name = "list_unavailable" as const;

export const description = "List typed missing/unavailable sources to record as open items.";

export const listUnavailableParams = z.object({}).strict();

export function runListUnavailable(
	_params: Record<string, unknown>,
	evidence: EvidenceBundle,
): MemoToolOutcome {
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
