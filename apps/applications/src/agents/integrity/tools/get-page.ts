import { z } from "zod";
import { codePointLength } from "@credit/core";
import type {
	IntegrityDocumentSnapshot,
	IntegrityPage,
	IntegritySource,
} from "../../../integrity/types.js";
import { EMPTY, MAX_PAGE_TEXT, type ToolOutcome } from "./shared.js";

export const name = "get_page" as const;

export const description = "Return one case document page (capped at 8,000 characters).";

export const getPageParams = z
	.object({
		documentFileId: z.uuid(),
		pageNumber: z.number().int().min(1).max(100),
	})
	.strict();

function documentMap(source: IntegritySource): Map<string, IntegrityDocumentSnapshot> {
	return new Map(source.documents.map((doc) => [doc.documentFileId, doc]));
}

function pageRef(documentFileId: string, page: IntegrityPage): string | null {
	const length = codePointLength(page.text);
	if (length === 0) return null;
	return `document:${documentFileId}:p${page.pageNumber}:0-${length}`;
}

export function runGetPage(source: IntegritySource, args: unknown): ToolOutcome {
	const parsed = getPageParams.safeParse(args);
	if (!parsed.success) return { ...EMPTY, payload: { error: "invalid arguments" } };
	const doc = documentMap(source).get(parsed.data.documentFileId);
	if (!doc) return { ...EMPTY, payload: { error: "document not available in this case" } };
	const page = doc.pages.find((item) => item.pageNumber === parsed.data.pageNumber);
	if (!page) return { ...EMPTY, payload: { error: "page not available" } };
	const text = page.text.slice(0, MAX_PAGE_TEXT);
	const ref = pageRef(doc.documentFileId, page);
	return {
		payload: {
			documentFileId: doc.documentFileId,
			pageNumber: page.pageNumber,
			text,
			confidence: page.confidence,
			source: page.source,
			truncated: text.length < page.text.length,
		},
		resultCount: 1,
		sourceTypes: ["document"],
		refs: ref ? [ref] : [],
	};
}
