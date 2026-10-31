// Helpers shared by the integrity tools. Pure: no DB, no network, no logging.
import type { IntegrityToolCall } from "../../../integrity/types.js";

export interface ToolOutcome {
	payload: unknown;
	resultCount: number;
	sourceTypes: string[];
	refs: string[];
}

export const EMPTY: ToolOutcome = { payload: null, resultCount: 0, sourceTypes: [], refs: [] };
export const MAX_EXCERPT = 300;
export const MAX_PAGE_TEXT = 8_000;
export const MAX_REFS_PER_CALL = 20;

export function customerPageRef(customerDocumentId: string, pageNumber: number): string {
	return `context_signal:customer_document:${customerDocumentId}:p${pageNumber}`;
}

export function toolNameForTrace(name: string): string {
	return name.slice(0, 80);
}

export function makeToolCall(step: number, name: string, outcome: ToolOutcome): IntegrityToolCall {
	return {
		step,
		name: toolNameForTrace(name),
		resultCount: outcome.resultCount,
		sourceTypes: outcome.sourceTypes,
		refs: outcome.refs.slice(0, MAX_REFS_PER_CALL),
	};
}
