import { describe, expect, it } from "vitest";
import {
	FINGERPRINT_VERSION,
	buildFingerprint,
	sanitizeSoftware,
} from "../../src/integrity/fingerprint.js";
import { parsePdfDate, readPdfProvenance } from "../../src/documents/ocr.js";

const file = {
	documentFileId: "11111111-1111-4111-8111-111111111111",
	applicationId: "22222222-2222-4222-8222-222222222222",
	sha256: "a".repeat(64),
	sizeBytes: 1024,
	mimeType: "application/pdf",
	pageCount: 2,
	ocrConfidence: 0.9,
};

describe("fingerprint provenance", () => {
	it("keeps only a known software token", () => {
		expect(sanitizeSoftware("Microsoft® Word for Microsoft 365")).toBe("Microsoft Word");
		expect(sanitizeSoftware("Adobe Acrobat Pro DC 24.1")).toBe("Adobe Acrobat");
		expect(sanitizeSoftware("Microsoft Word - Jane Doe - statement.docx")).toBe("Microsoft Word");
		expect(sanitizeSoftware("Jane Doe's MacBook Pro")).toBe("unknown");
		expect(sanitizeSoftware(undefined)).toBe("unknown");
	});

	it("detects incremental updates and date inversion", () => {
		const provenance = readPdfProvenance(
			{
				Producer: "Microsoft Word",
				CreationDate: "D:20260501120000+08'00'",
				ModDate: "D:20250101120000+08'00'",
			},
			Buffer.from("%PDF-1.4\n%%EOF\n1 0 obj\n/Prev 12\n%%EOF"),
		);
		const values = buildFingerprint(file, { kind: "bank_statement", provenance });
		expect(values.fingerprintVersion).toBe(FINGERPRINT_VERSION);
		expect(values.producer).toBe("Microsoft Word");
		expect(values.editSignal).toBe("detected");
		expect(values.editCodes).toContain("incremental_update");
		expect(values.editCodes).toContain("editor_producer");
		expect(values.editCodes).toContain("metadata_date_inversion");
		expect(values.metadataCreatedAt?.toISOString()).toBe("2026-05-01T04:00:00.000Z");
	});

	it("marks missing metadata unknown rather than inferring it", () => {
		const values = buildFingerprint(file, { kind: "id" });
		expect(values.producer).toBe("unknown");
		expect(values.creator).toBe("unknown");
		expect(values.metadataSource).toBe("unknown");
		expect(values.editSignal).toBe("unknown");
		expect(values.editCodes).toEqual(["metadata_unknown"]);
	});

	it("flags an image editor only for scan-expected kinds", () => {
		const provenance = readPdfProvenance({ Producer: "Adobe Photoshop 25.0" }, Buffer.from("%PDF"));
		const statement = buildFingerprint(file, { kind: "bank_statement", provenance });
		expect(statement.editCodes).toContain("recompression_editor");
		const memo = buildFingerprint(file, { kind: "other", provenance });
		expect(memo.editCodes).not.toContain("recompression_editor");
	});

	it("parses PDF dates without inventing invalid ones", () => {
		expect(parsePdfDate("D:20260501120000+08'00'")?.toISOString()).toBe("2026-05-01T04:00:00.000Z");
		expect(parsePdfDate("nonsense")).toBeUndefined();
		expect(parsePdfDate("D:20260231")).toBeUndefined();
		expect(parsePdfDate(undefined)).toBeUndefined();
	});
});
