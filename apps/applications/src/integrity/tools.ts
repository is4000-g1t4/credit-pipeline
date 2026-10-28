// US-INT-1/2/3 allowlisted tools over the immutable IntegritySource.
//
// Pure: no DB, no network, no logging. Ids are resolved from the snapshot map,
// never from the model. Every payload is capped; text never reaches a trace.

import { z } from "zod";
import { codePointLength, escapeRegExp, utf16IndexToCodePoint } from "@credit/core";
import type {
	IntegrityDocumentSnapshot,
	IntegrityPage,
	IntegritySource,
	IntegrityToolCall,
} from "./types.js";

export const INTEGRITY_TOOL_NAMES = [
	"list_documents",
	"search_pages",
	"get_page",
	"list_customer_evidence",
	"get_customer_page",
	"list_signals",
	"get_duplicate_context",
] as const;

export type IntegrityToolName = (typeof INTEGRITY_TOOL_NAMES)[number];

const ANALYSIS_TOOLS: ReadonlySet<IntegrityToolName> = new Set([
	"list_documents",
	"search_pages",
	"get_page",
	"list_signals",
]);

export const listDocumentsParams = z.object({}).strict();
export const searchPagesParams = z
	.object({
		query: z.string().min(1).max(100),
		// Strict OpenAI-compatible providers require every property in
		// `required`; keep this mandatory and let the model pass 5 by default.
		limit: z.number().int().min(1).max(10),
	})
	.strict();
export const getPageParams = z
	.object({
		documentFileId: z.uuid(),
		pageNumber: z.number().int().min(1).max(100),
	})
	.strict();
export const listCustomerEvidenceParams = z.object({}).strict();
export const getCustomerPageParams = z
	.object({
		customerDocumentId: z.uuid(),
		pageNumber: z.number().int().min(1).max(100),
	})
	.strict();
export const listSignalsParams = z.object({}).strict();
export const getDuplicateContextParams = z.object({}).strict();

export interface ToolOutcome {
	payload: unknown;
	resultCount: number;
	sourceTypes: string[];
	refs: string[];
}

const EMPTY: ToolOutcome = { payload: null, resultCount: 0, sourceTypes: [], refs: [] };
const MAX_EXCERPT = 300;
const MAX_PAGE_TEXT = 8_000;
const MAX_REFS_PER_CALL = 20;

function documentMap(source: IntegritySource): Map<string, IntegrityDocumentSnapshot> {
	return new Map(source.documents.map((doc) => [doc.documentFileId, doc]));
}

function pageRef(documentFileId: string, page: IntegrityPage): string | null {
	const length = codePointLength(page.text);
	if (length === 0) return null;
	return `document:${documentFileId}:p${page.pageNumber}:0-${length}`;
}

function customerPageRef(customerDocumentId: string, pageNumber: number): string {
	return `context_signal:customer_document:${customerDocumentId}:p${pageNumber}`;
}

function listDocuments(source: IntegritySource): ToolOutcome {
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

function searchPages(source: IntegritySource, args: unknown): ToolOutcome {
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

function getPage(source: IntegritySource, args: unknown): ToolOutcome {
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

function listCustomerEvidence(source: IntegritySource): ToolOutcome {
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

function getCustomerPage(source: IntegritySource, args: unknown): ToolOutcome {
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

function listSignals(source: IntegritySource): ToolOutcome {
	return {
		payload: {
			signals: source.signals.map((signal) => ({
				code: signal.code,
				severity: signal.severity,
				documentFileId: signal.documentFileId,
				summary: signal.summary,
				count: signal.count,
				sourceRef: signal.sourceRef,
			})),
			unavailable: source.unavailable.slice(0, 20),
		},
		resultCount: source.signals.length,
		sourceTypes: ["context_signal"],
		refs: source.signals.slice(0, MAX_REFS_PER_CALL).map((signal) => signal.sourceRef),
	};
}

function getDuplicateContext(source: IntegritySource): ToolOutcome {
	const matches = source.duplicateMatches.slice(0, MAX_REFS_PER_CALL).map((match) => ({
		matchingDocumentFileId: match.matchingDocumentFileId,
		kind: match.kind,
		relation: match.relation,
		ref: `context_signal:duplicate_document:${match.matchingDocumentFileId}`,
	}));
	return {
		payload: {
			counts: source.duplicateCounts,
			matches,
			note: "Counts only; no other-application identifiers or applicant data.",
		},
		resultCount: matches.length + 1,
		sourceTypes: ["context_signal"],
		refs: matches.slice(0, MAX_REFS_PER_CALL).map((match) => match.ref),
	};
}

/** Pure tool dispatcher. Unknown tools and bad args return an error payload,
 * never throw; the runner still counts the call against the budget. */
export function runIntegrityTool(
	name: string,
	args: unknown,
	source: IntegritySource,
	mode: "analysis" | "triage",
): ToolOutcome {
	if (!INTEGRITY_TOOL_NAMES.includes(name as IntegrityToolName)) {
		return { ...EMPTY, payload: { error: "unknown tool" } };
	}
	const tool = name as IntegrityToolName;
	if (mode === "analysis" && !ANALYSIS_TOOLS.has(tool)) {
		return { ...EMPTY, payload: { error: "tool is not allowlisted for this run" } };
	}
	switch (tool) {
		case "list_documents":
			return listDocuments(source);
		case "search_pages":
			return searchPages(source, args);
		case "get_page":
			return getPage(source, args);
		case "list_customer_evidence":
			return listCustomerEvidence(source);
		case "get_customer_page":
			return getCustomerPage(source, args);
		case "list_signals":
			return listSignals(source);
		case "get_duplicate_context":
			return getDuplicateContext(source);
	}
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
