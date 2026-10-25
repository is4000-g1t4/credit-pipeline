// ocr unit: fake adapter, image-dimension preparsing, text-layer risk, and
// real pdfjs-dist extraction against a hand-built minimal PDF (no binary
// fixture, no network OCR runtime).
import { describe, expect, it } from "vitest";
import {
	createFakeOcr,
	createImageOcrAdapter,
	createPdfOcrAdapter,
	detectTextLayerRisk,
	isWhiteFill,
	OcrFailed,
	pageHasWhiteText,
	parseImageDimensions,
	type OcrLimits,
	type TextItem,
} from "../../src/documents/ocr.js";

const LIMITS: OcrLimits = {
	maxPages: 20,
	maxPageTextBytes: 262_144,
	maxTotalTextBytes: 2_097_152,
	maxPixels: 16_000_000,
	minConfidence: 0.7,
	timeoutMs: 15_000,
};

function pdfEscape(text: string): string {
	return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Minimal valid PDF: one Helvetica page per entry in `pages`. */
function buildPdf(pages: string[]): Buffer {
	const bodies: string[] = [];
	bodies[1] = "<< /Type /Catalog /Pages 2 0 R >>";
	const kids: string[] = [];
	let next = 3;
	const fontNum = 100;
	for (const text of pages) {
		const pageNum = next++;
		const contentNum = next++;
		kids.push(`${pageNum} 0 R`);
		const stream = `BT /F1 12 Tf 72 720 Td (${pdfEscape(text)}) Tj ET`;
		bodies[pageNum] =
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNum} 0 R /Resources << /Font << /F1 ${fontNum} 0 R >> >> >>`;
		bodies[contentNum] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
	}
	bodies[2] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
	bodies[fontNum] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
	const maxObj = Math.max(fontNum, ...Object.keys(bodies).map(Number));
	const header = "%PDF-1.4\n";
	const chunks: Buffer[] = [Buffer.from(header)];
	const offsets: number[] = [];
	let pos = header.length;
	for (let n = 1; n <= maxObj; n++) {
		const body = bodies[n];
		if (body === undefined) continue;
		offsets[n] = pos;
		const chunk = Buffer.from(`${n} 0 obj\n${body}\nendobj\n`);
		chunks.push(chunk);
		pos += chunk.length;
	}
	const xrefPos = pos;
	let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
	for (let n = 1; n <= maxObj; n++) {
		xref += `${offsets[n] === undefined ? 0 : String(offsets[n]).padStart(10, "0")} 00000 ${offsets[n] === undefined ? "f" : "n"} \n`;
	}
	chunks.push(
		Buffer.from(
			`${xref}trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`,
		),
	);
	return Buffer.concat(chunks);
}

function item(over: Partial<TextItem> = {}): TextItem {
	return {
		str: "x",
		width: 10,
		height: 12,
		transform: [12, 0, 0, 12, 72, 720],
		...over,
	};
}

describe("ocr adapter fakes", () => {
	it("returns clones and counts calls", async () => {
		const fake = createFakeOcr();
		const a = await fake.extractPdf(Buffer.from("%PDF-"), LIMITS);
		expect(a.pages[0].text).toBe("fake extracted text");
		expect(fake.calls).toBe(1);
		a.pages[0].text = "mutated";
		const b = await fake.extractImage(Buffer.from("x"), "png", LIMITS);
		expect(b.pages[0].text).toBe("fake extracted text");
		await expect(fake.extractPdf(Buffer.from("x"), LIMITS)).resolves.toBeDefined();
		await expect(
			createFakeOcr("failed").extractPdf(Buffer.from("x"), LIMITS),
		).rejects.toBeInstanceOf(OcrFailed);
	});
});

describe("image dimension preparsing", () => {
	it("reads PNG IHDR before any decode", () => {
		const png = Buffer.alloc(24);
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
		png.writeUInt32BE(13, 8);
		png.write("IHDR", 12);
		png.writeUInt32BE(800, 16);
		png.writeUInt32BE(600, 20);
		expect(parseImageDimensions(png, "png")).toEqual({ width: 800, height: 600 });
		expect(parseImageDimensions(Buffer.alloc(10), "png")).toBeNull();
	});

	it("reads JPEG SOF markers", () => {
		const jpeg = Buffer.from([
			0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
			0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x01,
			0x01, 0x11, 0x00,
		]);
		expect(parseImageDimensions(jpeg, "jpeg")).toEqual({ width: 640, height: 480 });
		expect(parseImageDimensions(Buffer.from([0xff, 0xd8]), "jpeg")).toBeNull();
	});

	it("rejects oversized images without decoding and fails fast without assets", async () => {
		const big = Buffer.alloc(24);
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(big, 0);
		big.writeUInt32BE(13, 8);
		big.write("IHDR", 12);
		big.writeUInt32BE(5000, 16);
		big.writeUInt32BE(5000, 20);
		const adapter = createImageOcrAdapter({ dataDir: undefined, timeoutMs: 2000 });
		await expect(adapter.extractImage(big, "png", LIMITS)).rejects.toThrow("IMAGE_TOO_LARGE");
		await expect(
			adapter.extractImage(Buffer.from("89504e47", "hex"), "png", LIMITS),
		).rejects.toThrow("IMAGE_DIMENSIONS_UNKNOWN");
		const small = Buffer.alloc(24);
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(small, 0);
		small.writeUInt32BE(13, 8);
		small.write("IHDR", 12);
		small.writeUInt32BE(100, 16);
		small.writeUInt32BE(100, 20);
		const t0 = Date.now();
		await expect(adapter.extractImage(small, "png", LIMITS)).rejects.toThrow("OCR_DATA_MISSING");
		expect(Date.now() - t0).toBeLessThan(2000);
		await expect(
			createImageOcrAdapter({ dataDir: "/nonexistent-ocr-dir", timeoutMs: 2000 }).extractImage(
				small,
				"png",
				LIMITS,
			),
		).rejects.toThrow("OCR_DATA_MISSING");
	});
});

describe("text-layer risk", () => {
	it("passes ordinary text and repeated headers at distinct spots", () => {
		const items = [
			item({ str: "Header", transform: [12, 0, 0, 12, 72, 750] }),
			item({ str: "Body text here", transform: [12, 0, 0, 12, 72, 700] }),
			item({ str: "Footer", transform: [12, 0, 0, 12, 72, 40] }),
		];
		expect(detectTextLayerRisk(items, 612, 792)).toBe(false);
	});

	it("flags zero/negative-size items", () => {
		expect(detectTextLayerRisk([item({ width: 0 })], 612, 792)).toBe(true);
		expect(detectTextLayerRisk([item({ height: -1 })], 612, 792)).toBe(true);
		expect(detectTextLayerRisk([item({ transform: [0, 0, 0, 12, 72, 720] })], 612, 792)).toBe(true);
	});

	it("flags same-spot overlaps with different text, not double-drawn text", () => {
		const at: { transform: TextItem["transform"] } = { transform: [12, 0, 0, 12, 72, 720] };
		expect(
			detectTextLayerRisk([item({ str: "Real", ...at }), item({ str: "Hidden", ...at })], 612, 792),
		).toBe(true);
		expect(
			detectTextLayerRisk([item({ str: "Bold", ...at }), item({ str: "Bold", ...at })], 612, 792),
		).toBe(false);
	});

	it("flags out-of-page items", () => {
		expect(detectTextLayerRisk([item({ transform: [12, 0, 0, 12, 900, 720] })], 612, 792)).toBe(
			true,
		);
	});

	it("detects white text via the operator list", async () => {
		expect(isWhiteFill([1, 1, 1])).toBe(true);
		expect(isWhiteFill([0.2, 0.2, 0.2])).toBe(false);
		const ops = { setFillRGBColor: 1, setFillGray: 2, showText: 3 };
		const page = (fills: number[][]) => ({
			getOperatorList: async () => ({
				fnArray: fills.flatMap(() => [1, 3]),
				argsArray: fills.flatMap((fill) => [fill, []]),
			}),
		});
		await expect(pageHasWhiteText(page([[1, 1, 1]]), ops)).resolves.toBe(true);
		await expect(pageHasWhiteText(page([[0, 0, 0]]), ops)).resolves.toBe(false);
	});
});

describe("pdf text extraction (pdfjs-dist)", () => {
	const pdf = createPdfOcrAdapter();

	it("extracts text-layer pages with confidence 1.0", async () => {
		const bytes = buildPdf(["Hello World"]);
		const result = await pdf.extractPdf(bytes, LIMITS);
		expect(result.status).toBe("ready");
		expect(result.pages).toHaveLength(1);
		expect(result.pages[0].text).toContain("Hello World");
		expect(result.pages[0].source).toBe("pdf_text");
		expect(result.pages[0].confidence).toBe(1.0);
		expect(result.textLayerRisk).toBe(false);
	}, 20_000);

	it("reads multiple pages and honors the page cap", async () => {
		const bytes = buildPdf(["Page One", "Page Two", "Page Three"]);
		const full = await pdf.extractPdf(bytes, LIMITS);
		expect(full.status).toBe("ready");
		expect(full.pages.map((p) => p.text.trim())).toEqual(["Page One", "Page Two", "Page Three"]);
		const capped = await pdf.extractPdf(bytes, { ...LIMITS, maxPages: 2 });
		expect(capped.pages).toHaveLength(2);
	});

	it("maps scanned PDFs (no text) to unsupported with no pages", async () => {
		const bytes = buildPdf([""]);
		const result = await pdf.extractPdf(bytes, LIMITS);
		expect(result.status).toBe("unsupported");
		expect(result.pages).toEqual([]);
	});

	it("fails corrupt PDFs as failed, not a hang", async () => {
		await expect(
			pdf.extractPdf(Buffer.from("%PDF-1.4 garbage (((("), { ...LIMITS, timeoutMs: 10_000 }),
		).rejects.toBeInstanceOf(OcrFailed);
	});
});
