import { z } from "zod";
import { codePointLength, escapeRegExp, utf16IndexToCodePoint } from "@credit/core";
import type { IntegritySource } from "../../../integrity/types.js";
import {
	EMPTY,
	MAX_EXCERPT,
	MAX_REFS_PER_CALL,
	customerPageRef,
	type ToolOutcome,
} from "./shared.js";

export const name = "search_pages" as const;

export const description =
	"Case-insensitive search over case and same-customer page text. Returns bounded excerpts and code-point offsets. Pass limit 1-10; use 5 unless you need more.";

export const searchPagesParams = z
	.object({
		query: z.string().min(1).max(100),
		// Strict OpenAI-compatible providers require every property in
		// `required`; keep this mandatory and let the model pass 5 by default.
		limit: z.number().int().min(1).max(10),
	})
	.strict();

interface PageHit {
	documentFileId?: string;
	customerDocumentId?: string;
	pageNumber: number;
	offsetStart: number;
	offsetEnd: number;
	excerpt: string;
}

function searchText(
	text: string,
	query: string,
): Array<{ offsetStart: number; offsetEnd: number; excerpt: string }> {
	const re = new RegExp(escapeRegExp(query), "gi");
	const hits: Array<{ offsetStart: number; offsetEnd: number; excerpt: string }> = [];
	for (const match of text.matchAll(re)) {
		if (match.index === undefined) continue;
		const utf16Start = match.index;
		const utf16End = utf16Start + match[0].length;
		const offsetStart = utf16IndexToCodePoint(text, utf16Start);
		const offsetEnd = utf16IndexToCodePoint(text, utf16End);
		const charStart = Math.max(0, offsetStart - 80);
		const charEnd = Math.min(codePointLength(text), offsetEnd + 80);
		hits.push({
			offsetStart,
			offsetEnd,
			excerpt: [...text].slice(charStart, charEnd).join("").slice(0, MAX_EXCERPT),
		});
		if (hits.length >= 20) break;
	}
	return hits;
}

export function runSearchPages(source: IntegritySource, args: unknown): ToolOutcome {
	const parsed = searchPagesParams.safeParse(args);
	if (!parsed.success) return { ...EMPTY, payload: { error: "invalid arguments" } };
	const limit = parsed.data.limit ?? 5;
	const hits: PageHit[] = [];
	for (const doc of source.documents) {
		for (const page of doc.pages) {
			for (const hit of searchText(page.text, parsed.data.query)) {
				hits.push({
					documentFileId: doc.documentFileId,
					pageNumber: page.pageNumber,
					...hit,
				});
				if (hits.length >= limit) break;
			}
			if (hits.length >= limit) break;
		}
		if (hits.length >= limit) break;
	}
	if (source.includeCustomerEvidence) {
		for (const doc of source.customerDocuments) {
			if (!doc.readable) continue;
			for (const page of doc.pages) {
				for (const hit of searchText(page.text, parsed.data.query)) {
					hits.push({
						customerDocumentId: doc.customerDocumentId,
						pageNumber: page.pageNumber,
						...hit,
					});
					if (hits.length >= limit) break;
				}
				if (hits.length >= limit) break;
			}
			if (hits.length >= limit) break;
		}
	}
	const refs = hits
		.map((hit) =>
			hit.documentFileId
				? `document:${hit.documentFileId}:p${hit.pageNumber}:${hit.offsetStart}-${hit.offsetEnd}`
				: customerPageRef(hit.customerDocumentId!, hit.pageNumber),
		)
		.slice(0, MAX_REFS_PER_CALL);
	return {
		payload: {
			hits,
			note: "Excerpts are bounded; call get_page for a fuller page. Offsets are Unicode code points.",
		},
		resultCount: hits.length,
		sourceTypes: hits.some((hit) => hit.customerDocumentId)
			? ["document", "context_signal"]
			: ["document"],
		refs,
	};
}
