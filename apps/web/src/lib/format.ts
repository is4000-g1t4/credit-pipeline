// Shared display sanitizers + one error-code map. All document-derived
// text renders as React text nodes; bidi/zero-width controls are stripped
// in display so pasted content cannot reorder UI.
import { ApiError, apiErrorMessage } from "./api/client";

/** Strip bidi/zero-width controls so pasted document text cannot reorder UI. */
const STRIP_CHARS = String.fromCharCode(
	0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060,
	0x2061, 0x2062, 0x2063, 0x2064, 0x2065, 0x2066, 0x2067, 0x2068, 0x2069, 0x206a, 0x206b,
	0x206c, 0x206d, 0x206e, 0x206f, 0xfeff,
);
// (Ranges 200B–200F, 202A–202E, 2060–206F plus FEFF, written without
// backslash-u escapes so the pattern survives every transport.)
const STRIP_RE = new RegExp(`[${STRIP_CHARS}]`, "g");
export function clean(value: string): string {
	return value.replace(STRIP_RE, "");
}

export function shortId(id: string): string {
	return id.length > 8 ? id.slice(0, 8) : id;
}

/** Machine code → officer/applicant copy. Unknown codes render the raw
 * server message. Status fallbacks stay generic across panels. */
const CODE_MESSAGES: Record<string, string> = {
	CONSENT_REQUIRED: "Document processing consent is required before documents can be used.",
	FILE_TOO_LARGE: "That file is too large — the limit is 10 MB.",
	UNSUPPORTED_TYPE: "Unsupported file type — upload a PDF, PNG, or JPEG.",
	MALWARE_DETECTED: "That file failed the malware scan and was rejected.",
	DOCUMENTS_NOT_READY: "No ready documents to check yet — upload a supported file first.",
	NO_TEXT: "ID documents carry no page text — they always need a manual check.",
	OCR_NOT_RETRYABLE: "Only failed or unsupported extractions can be retried.",
	ORIGINAL_NOT_OPENED: "Open the original document before drafting a chase.",
	LOCK_TIMEOUT: "The case is busy — retry in a moment.",
	OCR_BUSY: "Text extraction is saturated — retry shortly.",
	ENCRYPTION_UNAVAILABLE: "The document service is temporarily unavailable — retry shortly.",
	UPLOAD_TIMEOUT: "The document service is temporarily unavailable — retry shortly.",
	INTEGRITY_AGENT_UNAVAILABLE: "The integrity agent is temporarily unavailable — retry shortly.",
	CANDIDATE_STALE: "The source changed since analysis — refresh the panel before confirming.",
	CANDIDATE_NOT_ACTIVE: "That candidate was already decided — refresh the panel.",
	NOT_CONFIRMED_MISMATCH: "Only a confirmed mismatch can be escalated.",
	DOCUMENT_NOT_AVAILABLE: "A cited document is not available in this case.",
	APPLICATION_REQUIRED: "Enter the application id for the case being reviewed.",
	STALE_CITATION: "A cited value changed - rerun the cross-check.",
};

export function friendlyMessage(err: unknown): string {
	if (err instanceof ApiError) {
		const mapped = CODE_MESSAGES[err.code];
		if (mapped !== undefined) return mapped;
		switch (err.status) {
			case 404:
				return "That item is not available.";
			case 409:
				return "That review changed — refresh and retry.";
			case 413:
				return "That file is too large — the limit is 10 MB.";
			case 415:
				return "Unsupported file type — upload a PDF, PNG, or JPEG.";
			case 422:
				return "That file was rejected — try a different file.";
			case 429:
				return "The service is busy — retry in a moment.";
			case 503:
				return "The service is temporarily unavailable — retry shortly.";
			default:
				break;
		}
	}
	return apiErrorMessage(err);
}
