import { z } from "zod";
import type { IntegritySource } from "../../../integrity/types.js";
import { EMPTY, MAX_PAGE_TEXT, customerPageRef, type ToolOutcome } from "./shared.js";

export const name = "get_customer_page" as const;

export const description = "Return one same-customer document page (capped at 8,000 characters).";

export const getCustomerPageParams = z
	.object({
		customerDocumentId: z.uuid(),
		pageNumber: z.number().int().min(1).max(100),
	})
	.strict();

export function runGetCustomerPage(source: IntegritySource, args: unknown): ToolOutcome {
	if (!source.includeCustomerEvidence) {
		return { ...EMPTY, payload: { error: "customer evidence is not available for this run" } };
	}
	const parsed = getCustomerPageParams.safeParse(args);
	if (!parsed.success) return { ...EMPTY, payload: { error: "invalid arguments" } };
	const doc = source.customerDocuments.find(
		(item) => item.customerDocumentId === parsed.data.customerDocumentId,
	);
	if (!doc || !doc.readable) {
		return { ...EMPTY, payload: { error: "customer document not available" } };
	}
	const page = doc.pages.find((item) => item.pageNumber === parsed.data.pageNumber);
	if (!page) return { ...EMPTY, payload: { error: "page not available" } };
	const text = page.text.slice(0, MAX_PAGE_TEXT);
	return {
		payload: {
			customerDocumentId: doc.customerDocumentId,
			pageNumber: page.pageNumber,
			text,
			confidence: page.confidence,
			source: page.source,
			truncated: text.length < page.text.length,
		},
		resultCount: 1,
		sourceTypes: ["context_signal"],
		refs: [customerPageRef(doc.customerDocumentId, page.pageNumber)],
	};
}
