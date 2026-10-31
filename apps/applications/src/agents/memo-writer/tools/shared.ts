// Helpers shared by the memo evidence tools. Pure: no DB, no network.
import { SOURCE_TYPES, type EvidenceBundle } from "@credit/core";

export const SOURCE_TYPE_LIST = [...SOURCE_TYPES] as string[];

export function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function clampLimit(value: unknown, def: number, max: number): number {
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

export function uniqueSourceTypes(refs: string[], items: Map<string, string>): string[] {
	const types = new Set<string>();
	for (const ref of refs) {
		const type = items.get(ref);
		if (type) types.add(type);
	}
	return [...types].sort();
}

export function toolError(message: string): MemoToolOutcome {
	return {
		payload: { error: message },
		resultCount: 0,
		sourceTypes: [],
		refs: [],
	};
}

export function sourceTypeByRef(evidence: EvidenceBundle): Map<string, string> {
	return new Map(evidence.items.map((i) => [i.ref, i.sourceType]));
}

// Plain-JSON equivalents of the list/search params for the `@openai/agents`
// SDK. The SDK forces `strict: true` on zod-declared functions, and OpenAI
// strict mode rejects schemas whose optional properties are absent from
// `required` (400 invalid_function_parameters), so the zod forms can never
// be sent. These declare the same shape with `strict: false`; runtime
// validation still lives in each tool's `run` (bad args are tool errors in
// the payload, never throws), so wire behavior is unchanged.
export interface EvidenceJsonParams {
	type: "object";
	properties: Record<string, Record<string, unknown>>;
	required: string[];
	additionalProperties: true;
}

export function sourceTypeJsonSchema(): Record<string, unknown> {
	return { type: "string", enum: [...SOURCE_TYPES] };
}
