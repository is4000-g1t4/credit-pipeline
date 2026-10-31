import { z } from "zod";
import type { IntegritySource } from "../../../integrity/types.js";
import { EMPTY, type ToolOutcome } from "./shared.js";

export const name = "list_customer_evidence" as const;

export const description =
	"List same-customer profile fields and customer document metadata (no page text).";

export const listCustomerEvidenceParams = z.object({}).strict();

export function runListCustomerEvidence(source: IntegritySource): ToolOutcome {
	if (!source.includeCustomerEvidence) {
		return { ...EMPTY, payload: { error: "customer evidence is not available for this run" } };
	}
	const items = source.customerDocuments.map((doc) => ({
		customerDocumentId: doc.customerDocumentId,
		kind: doc.kind,
		pageCount: doc.pageCount,
		ocrStatus: doc.ocrStatus,
		sha256Prefix: doc.sha256Prefix,
		documentDate: doc.documentDate,
		periodEnd: doc.periodEnd,
		readable: doc.readable,
	}));
	return {
		payload: {
			documents: items,
			profile: source.caseFacts.filter((fact) => fact.field.startsWith("customer")),
		},
		resultCount: items.length,
		sourceTypes: ["context_signal"],
		refs: [],
	};
}
