import { z } from "zod";
import type { IntegritySource } from "../../../integrity/types.js";
import type { ToolOutcome } from "./shared.js";

export const name = "list_documents" as const;

export const description =
	"List the case documents with id, kind, page count, OCR status, and dates.";

export const listDocumentsParams = z.object({}).strict();

export function runListDocuments(source: IntegritySource): ToolOutcome {
	const items = source.documents.map((doc) => ({
		documentFileId: doc.documentFileId,
		kind: doc.kind,
		pageCount: doc.pageCount,
		ocrStatus: doc.ocrStatus,
		hasText: doc.pages.length > 0,
		documentDate: doc.documentDate,
		periodEnd: doc.periodEnd,
	}));
	return {
		payload: { documents: items, unavailable: source.unavailable.slice(0, 20) },
		resultCount: items.length,
		sourceTypes: ["document"],
		refs: [],
	};
}
