// EN-04 fingerprint/provenance builder (pure).
//
// Reads only PDF info Producer/Creator plus raw edit markers. Author, Title,
// Subject, Keywords, filenames, and page text are never copied. Unknown
// metadata stays `unknown`; it is never inferred.

import type { DocumentKind } from "../documents/pipeline.js";
import type { PdfProvenance } from "../documents/ocr.js";

export const FINGERPRINT_VERSION = "document-fingerprint-v1";

export type IntegrityEditSignal = "detected" | "not_detected" | "unknown";
export type MetadataSource = "pdf" | "image" | "unknown";

export interface FingerprintFileInput {
	documentFileId: string;
	applicationId: string;
	sha256: string;
	sizeBytes: number;
	mimeType: string;
	pageCount: number;
	ocrConfidence: number | null;
}

export interface FingerprintExtractionInput {
	kind: DocumentKind;
	provenance?: PdfProvenance;
}

export interface FingerprintValues {
	documentFileId: string;
	applicationId: string;
	fingerprintVersion: string;
	sha256: string;
	sizeBytes: number;
	mimeType: string;
	pageCount: number;
	ocrConfidence: number | null;
	producer: string;
	creator: string;
	metadataCreatedAt: Date | null;
	metadataModifiedAt: Date | null;
	metadataSource: MetadataSource;
	editSignal: IntegrityEditSignal;
	editCodes: string[];
}

interface SoftwareRule {
	pattern: RegExp;
	token: string;
	editor: boolean;
	imageEditor: boolean;
}

// Deliberately small: a PDF creator string is only retained when it matches a
// known product. Anything else (a filename, a person, a path, a registration
// number) collapses to `unknown` instead of being stored or shown.
const SOFTWARE: SoftwareRule[] = [
	{
		pattern: /adobe\s+acrobat|acrobat\s+distiller|adobe\s+pdf\s+library/i,
		token: "Adobe Acrobat",
		editor: true,
		imageEditor: false,
	},
	{ pattern: /microsoft.{0,12}word/i, token: "Microsoft Word", editor: true, imageEditor: false },
	{ pattern: /microsoft.{0,12}excel/i, token: "Microsoft Excel", editor: true, imageEditor: false },
	{ pattern: /libreoffice/i, token: "LibreOffice", editor: true, imageEditor: false },
	{
		pattern: /google\s+(?:chrome|docs)/i,
		token: "Google Chrome",
		editor: false,
		imageEditor: false,
	},
	{ pattern: /pdf-lib/i, token: "pdf-lib", editor: true, imageEditor: false },
	{ pattern: /reportlab/i, token: "ReportLab", editor: true, imageEditor: false },
	{ pattern: /wkhtmltopdf/i, token: "wkhtmltopdf", editor: true, imageEditor: false },
	{ pattern: /pdftex|latex|xetex/i, token: "LaTeX", editor: true, imageEditor: false },
	{ pattern: /sejda/i, token: "Sejda", editor: true, imageEditor: false },
	{ pattern: /smallpdf/i, token: "Smallpdf", editor: true, imageEditor: false },
	{ pattern: /ilovepdf/i, token: "iLovePDF", editor: true, imageEditor: false },
	{ pattern: /photoshop/i, token: "Adobe Photoshop", editor: true, imageEditor: true },
	{ pattern: /\bgimp\b/i, token: "GIMP", editor: true, imageEditor: true },
	{ pattern: /canva/i, token: "Canva", editor: true, imageEditor: true },
	{ pattern: /foxit/i, token: "Foxit", editor: true, imageEditor: false },
	{ pattern: /nitro\s+pdf/i, token: "Nitro PDF", editor: true, imageEditor: false },
];

export function sanitizeSoftware(raw: string | undefined): string {
	if (!raw) return "unknown";
	const match = SOFTWARE.find((rule) => rule.pattern.test(raw));
	return match?.token ?? "unknown";
}

function softwareRule(raw: string | undefined): SoftwareRule | undefined {
	if (!raw) return undefined;
	return SOFTWARE.find((rule) => rule.pattern.test(raw));
}

const SCAN_EXPECTED_KINDS: ReadonlySet<DocumentKind> = new Set([
	"bank_statement",
	"business_registration",
	"id",
]);

/** Pure builder. `editCodes` are signals, not proof: an Office-produced PDF is
 * common and only becomes a flag when severity crosses the configured bar. */
export function buildFingerprint(
	file: FingerprintFileInput,
	extraction: FingerprintExtractionInput,
): FingerprintValues {
	const provenance = extraction.provenance;
	const producer = sanitizeSoftware(provenance?.producer);
	const creator = sanitizeSoftware(provenance?.creator);
	const editCodes: string[] = [];
	const sourceRule = softwareRule(provenance?.producer) ?? softwareRule(provenance?.creator);
	const hasMetadata =
		provenance !== undefined &&
		(producer !== "unknown" ||
			creator !== "unknown" ||
			provenance.createdAt !== undefined ||
			provenance.modifiedAt !== undefined ||
			provenance.incrementalUpdate === true);

	if (provenance?.incrementalUpdate === true) editCodes.push("incremental_update");
	if (sourceRule?.editor === true) editCodes.push("editor_producer");
	if (sourceRule?.imageEditor === true && SCAN_EXPECTED_KINDS.has(extraction.kind)) {
		editCodes.push("recompression_editor");
	}
	if (
		provenance?.createdAt !== undefined &&
		provenance.modifiedAt !== undefined &&
		provenance.modifiedAt.getTime() < provenance.createdAt.getTime()
	) {
		editCodes.push("metadata_date_inversion");
	}

	const metadataSource: MetadataSource = hasMetadata ? "pdf" : "unknown";
	let editSignal: IntegrityEditSignal;
	if (metadataSource === "unknown") editSignal = "unknown";
	else editSignal = editCodes.length > 0 ? "detected" : "not_detected";
	if (editSignal === "unknown") editCodes.push("metadata_unknown");

	return {
		documentFileId: file.documentFileId,
		applicationId: file.applicationId,
		fingerprintVersion: FINGERPRINT_VERSION,
		sha256: file.sha256,
		sizeBytes: file.sizeBytes,
		mimeType: file.mimeType,
		pageCount: file.pageCount,
		ocrConfidence: file.ocrConfidence,
		producer,
		creator,
		metadataCreatedAt: provenance?.createdAt ?? null,
		metadataModifiedAt: provenance?.modifiedAt ?? null,
		metadataSource,
		editSignal,
		editCodes,
	};
}
