// T01 text extraction (SPEC-t01-t02 §6.4): PDF text layer via pdfjs-dist,
// PNG/JPEG OCR via tesseract.js with local vendored assets only
// (DOCUMENT_OCR_DATA_DIR — no runtime CDN). Caps: 20 pages, 256 KB/page,
// 2 MB total, 16 MP images (dimensions parsed from IHDR/SOF *before*
// decode). PDF text pages carry confidence 1.0. Scanned PDFs (no text)
// are `unsupported` with no pages; extraction errors are `failed` with no
// pages. `kind=id` never reaches here (`not_applicable`, service-level).
//
// pdfjs textContent exposes no fill color, so white-text detection is out
// of scope; risk covers what the text layer does expose: zero/negative
// size items, same-coordinate overlaps, and out-of-page items. Ordinary
// repeated headers/footers (different coordinates) are not risk.
import { promises as fs } from "node:fs";
import * as path from "node:path";

export type OcrStatus = "ready" | "low_confidence" | "unsupported" | "failed" | "not_applicable";
export type TextSource = "pdf_text" | "ocr";

export interface ExtractedPage {
	text: string;
	source: TextSource;
	confidence: number;
	/** Actual 1-based source page (PDF blank pages may be omitted). */
	pageNumber?: number;
}

/** PDF provenance (EN-04). Raw strings are sanitized by the fingerprint layer;
 * this module only reads them. Never reads Author/Title/Subject/Keywords. */
export interface PdfProvenance {
	producer?: string;
	creator?: string;
	createdAt?: Date;
	modifiedAt?: Date;
	incrementalUpdate?: boolean;
}

export interface ExtractionResult {
	status: Exclude<OcrStatus, "not_applicable">;
	pages: ExtractedPage[];
	textLayerRisk: boolean;
	/** Actual source page count when known (may exceed extracted pages). */
	pageCount?: number;
	provenance?: PdfProvenance;
}

/** PDF info dates are `D:YYYYMMDDHHmmSS(+HH'mm')`; tolerate bare dates and
 * reject impossible values rather than inventing one. */
export function parsePdfDate(raw: unknown): Date | undefined {
	if (typeof raw !== "string") return undefined;
	const text = raw.trim();
	const match =
		/^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([+-])?(\d{2})?'?(\d{2})?'?/.exec(text);
	if (!match) return undefined;
	const [, y, mo = "01", d = "01", h = "00", mi = "00", s = "00", sign, oh, om] = match;
	const parts = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)] as const;
	const base = new Date(Date.UTC(...parts));
	if (
		base.getUTCFullYear() !== parts[0] ||
		base.getUTCMonth() !== parts[1] ||
		base.getUTCDate() !== parts[2] ||
		base.getUTCHours() !== parts[3] ||
		base.getUTCMinutes() !== parts[4] ||
		base.getUTCSeconds() !== parts[5]
	) {
		return undefined;
	}
	const offsetMinutes =
		sign === undefined ? 0 : (sign === "+" ? 1 : -1) * (Number(oh ?? "0") * 60 + Number(om ?? "0"));
	return new Date(base.getTime() - offsetMinutes * 60_000);
}

export function readPdfProvenance(
	info: Record<string, unknown> | null | undefined,
	bytes: Buffer,
): PdfProvenance {
	const text = (value: unknown): string | undefined =>
		typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 500) : undefined;
	const eofCount = bytes.toString("latin1").split("%%EOF").length - 1;
	const hasPrev = /\/Prev\s+\d+/.test(bytes.toString("latin1"));
	return {
		producer: text(info?.Producer),
		creator: text(info?.Creator),
		createdAt: parsePdfDate(info?.CreationDate),
		modifiedAt: parsePdfDate(info?.ModDate),
		incrementalUpdate: eofCount > 1 || hasPrev,
	};
}

export interface OcrLimits {
	maxPages: number;
	maxPageTextBytes: number;
	maxTotalTextBytes: number;
	maxPixels: number;
	minConfidence: number;
	timeoutMs: number;
}

export interface OcrAdapter {
	extractPdf(bytes: Buffer, limits: OcrLimits): Promise<ExtractionResult>;
	extractImage(
		bytes: Buffer,
		imageType: "png" | "jpeg",
		limits: OcrLimits,
	): Promise<ExtractionResult>;
	/** Metadata-only PDF read (`kind=id` skips text extraction). */
	extractMetadata?(
		bytes: Buffer,
		limits: OcrLimits,
	): Promise<{ provenance: PdfProvenance; pageCount?: number }>;
}

export class OcrFailed extends Error {
	constructor(message = "OCR_FAILED") {
		super(message);
		this.name = "OcrFailed";
	}
}

/** Test fake: canned result (or forced failure), call counter included. */
export function createFakeOcr(
	result: ExtractionResult | "failed" = {
		status: "ready",
		pages: [{ text: "fake extracted text", source: "ocr", confidence: 0.95 }],
		textLayerRisk: false,
	},
): OcrAdapter & { calls: number } {
	const fake = {
		calls: 0,
		async extractPdf(_bytes: Buffer, _limits: OcrLimits): Promise<ExtractionResult> {
			fake.calls++;
			if (result === "failed") throw new OcrFailed();
			return structuredClone(result);
		},
		async extractImage(
			_bytes: Buffer,
			_imageType: "png" | "jpeg",
			_limits: OcrLimits,
		): Promise<ExtractionResult> {
			fake.calls++;
			if (result === "failed") throw new OcrFailed();
			return structuredClone(result);
		},
	};
	return fake;
}

// --- Image dimension pre-parse (before any decode) ---

export function parseImageDimensions(
	bytes: Buffer,
	imageType: "png" | "jpeg",
): { width: number; height: number } | null {
	try {
		if (imageType === "png") {
			// 8-byte signature, then IHDR chunk: width/height BE u32 at 16/20.
			if (bytes.length < 24) return null;
			if (bytes.readUInt32BE(12) !== 0x49484452) return null; // "IHDR"
			return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
		}
		if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
		let off = 2;
		while (off + 4 < bytes.length) {
			if (bytes[off] !== 0xff) return null;
			const marker = bytes[off + 1];
			const len = bytes.readUInt16BE(off + 2);
			if (len < 2) return null;
			// SOF0–SOF15 except DHT/DAC/DAC-adjacent (C4/C8/CC): frame header.
			if (
				marker >= 0xc0 &&
				marker <= 0xcf &&
				marker !== 0xc4 &&
				marker !== 0xc8 &&
				marker !== 0xcc
			) {
				if (off + 9 > bytes.length) return null;
				return { height: bytes.readUInt16BE(off + 5), width: bytes.readUInt16BE(off + 7) };
			}
			off += 2 + len;
		}
		return null;
	} catch {
		return null;
	}
}

// --- Text-layer risk (pure; unit-tested with synthetic items) ---

export interface TextItem {
	str: string;
	width: number;
	height: number;
	/** pdfjs transform [a,b,c,d,e,f]; (e,f) is the text position. */
	transform: [number, number, number, number, number, number];
}

/** Suspicious-only: zero/negative-size, zero-scale, same-spot overlaps,
 * out-of-page items. Repeated headers/footers at distinct spots pass. */
export function detectTextLayerRisk(
	items: TextItem[],
	pageWidth: number,
	pageHeight: number,
): boolean {
	const seen = new Map<string, string>();
	for (const item of items) {
		if (item.width <= 0 || item.height <= 0) return true;
		const [a, b, , d, e, f] = item.transform;
		if (Math.hypot(a, b) === 0 || Math.abs(d) === 0) return true;
		if (e < 0 || f < 0 || e > pageWidth || f > pageHeight) return true;
		if (item.str !== "") {
			const spot = `${Math.round(e)}:${Math.round(f)}`;
			const prior = seen.get(spot);
			if (prior !== undefined && prior !== item.str) return true;
			seen.set(spot, item.str);
		}
	}
	return false;
}

/** White (or near-white) fill is suspicious: visible-text extraction still
 * cites it, but a human cannot necessarily see it in the original. */
export function isWhiteFill(rgb: readonly number[]): boolean {
	return rgb.length >= 3 && rgb[0] >= 0.97 && rgb[1] >= 0.97 && rgb[2] >= 0.97;
}

/** Scan the page operator list for showText under a white fill. Best-effort:
 * pdfjs does not expose fill color on individual text items. */
export async function pageHasWhiteText(
	page: {
		getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
	},
	ops: {
		setFillRGBColor: number;
		setFillGray: number;
		showText: number;
	},
): Promise<boolean> {
	try {
		const list = await page.getOperatorList();
		let fill: number[] = [0, 0, 0];
		for (let i = 0; i < list.fnArray.length; i++) {
			const fn = list.fnArray[i];
			const args = list.argsArray[i] ?? [];
			if (fn === ops.setFillRGBColor) {
				fill = [Number(args[0] ?? 0), Number(args[1] ?? 0), Number(args[2] ?? 0)];
			} else if (fn === ops.setFillGray) {
				const gray = Number(args[0] ?? 0);
				fill = [gray, gray, gray];
			} else if (fn === ops.showText && isWhiteFill(fill)) {
				return true;
			}
		}
	} catch {
		// Operator list unavailable: fall back to the other risk checks.
	}
	return false;
}

// --- Production adapters (dynamic imports: fakes never load these) ---

function truncateUtf8(text: string, maxBytes: number): string {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= maxBytes) return text;
	// Cut on a char boundary — never split a code point.
	let end = maxBytes;
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
	return buf.subarray(0, end).toString("utf8");
}

async function withTimeout<T>(
	ms: number,
	fn: () => Promise<T>,
	onTimeout?: () => void,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	try {
		return await Promise.race([
			fn(),
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => {
					try {
						onTimeout?.();
					} catch {
						// Timeout cleanup is best-effort.
					}
					reject(new OcrFailed("OCR_TIMEOUT"));
				}, ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export function createPdfOcrAdapter(): Pick<OcrAdapter, "extractPdf" | "extractMetadata"> {
	return {
		async extractPdf(bytes: Buffer, limits: OcrLimits): Promise<ExtractionResult> {
			try {
				return await withTimeout(limits.timeoutMs, async () => {
					const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
					const loadingTask = pdfjs.getDocument({
						data: new Uint8Array(bytes),
					});
					const doc = await loadingTask.promise;
					try {
						const metadata = await doc.getMetadata().catch(() => null);
						const provenance = readPdfProvenance(
							(metadata?.info ?? null) as Record<string, unknown> | null,
							bytes,
						);
						const count = Math.min(doc.numPages, limits.maxPages);
						const pages: ExtractedPage[] = [];
						let total = 0;
						let risk = false;
						for (let n = 1; n <= count; n++) {
							const page = await doc.getPage(n);
							const viewport = page.getViewport({ scale: 1 });
							const content = await page.getTextContent();
							const items = content.items.filter(
								(it): it is typeof it & { str: string; transform: number[] } =>
									typeof (it as { str?: unknown }).str === "string",
							);
							risk =
								risk ||
								(await pageHasWhiteText(page, pdfjs.OPS)) ||
								detectTextLayerRisk(
									items.map((it) => ({
										str: it.str,
										width: (it as { width?: number }).width ?? 0,
										height: (it as { height?: number }).height ?? 0,
										transform: (Array.isArray(it.transform) && it.transform.length === 6
											? it.transform
											: [1, 0, 0, 1, 0, 0]) as TextItem["transform"],
									})),
									viewport.width,
									viewport.height,
								);
							const raw = items.map((it) => it.str).join("");
							if (raw !== "") {
								const text = truncateUtf8(raw, limits.maxPageTextBytes);
								if (total + Buffer.byteLength(text, "utf8") > limits.maxTotalTextBytes) break;
								total += Buffer.byteLength(text, "utf8");
								pages.push({
									text,
									source: "pdf_text",
									confidence: 1.0,
									pageNumber: n,
								});
							}
							await page.cleanup();
						}
						if (pages.length === 0) {
							return {
								status: "unsupported",
								pages: [],
								textLayerRisk: risk,
								pageCount: doc.numPages,
								provenance,
							};
						}
						return {
							status: risk ? "low_confidence" : "ready",
							pages,
							textLayerRisk: risk,
							pageCount: doc.numPages,
							provenance,
						};
					} finally {
						await loadingTask.destroy().catch(() => {});
					}
				});
			} catch (err) {
				if (err instanceof OcrFailed) throw err;
				throw new OcrFailed(err instanceof Error ? err.message : "pdf extraction failed");
			}
		},
		async extractMetadata(
			bytes: Buffer,
			limits: OcrLimits,
		): Promise<{ provenance: PdfProvenance; pageCount?: number }> {
			try {
				return await withTimeout(limits.timeoutMs, async () => {
					const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
					const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes) });
					const doc = await loadingTask.promise;
					try {
						const metadata = await doc.getMetadata().catch(() => null);
						return {
							provenance: readPdfProvenance(
								(metadata?.info ?? null) as Record<string, unknown> | null,
								bytes,
							),
							pageCount: doc.numPages,
						};
					} finally {
						await loadingTask.destroy().catch(() => {});
					}
				});
			} catch (err) {
				if (err instanceof OcrFailed) throw err;
				throw new OcrFailed(err instanceof Error ? err.message : "pdf metadata failed");
			}
		},
	};
}

export interface ImageOcrOptions {
	dataDir: string | undefined;
	timeoutMs: number;
}

export function createImageOcrAdapter(opts: ImageOcrOptions): Pick<OcrAdapter, "extractImage"> {
	return {
		async extractImage(
			bytes: Buffer,
			imageType: "png" | "jpeg",
			limits: OcrLimits,
		): Promise<ExtractionResult> {
			const dims = parseImageDimensions(bytes, imageType);
			if (!dims) throw new OcrFailed("IMAGE_DIMENSIONS_UNKNOWN");
			if (dims.width * dims.height > limits.maxPixels) {
				throw new OcrFailed("IMAGE_TOO_LARGE");
			}
			// No vendored assets → never hang, never hit network.
			if (!opts.dataDir) throw new OcrFailed("OCR_DATA_MISSING");
			try {
				for (const name of ["eng.traineddata", "eng.traineddata.gz"]) {
					try {
						await fs.access(path.join(opts.dataDir, name));
						break;
					} catch {
						if (name.endsWith(".gz")) throw new OcrFailed("OCR_DATA_MISSING");
					}
				}
			} catch (err) {
				if (err instanceof OcrFailed) throw err;
				throw new OcrFailed("OCR_DATA_MISSING");
			}
			// Holder (not a bare `let`) so timeout/finally cleanup never
			// trips narrowing on the CJS namespace type.
			const holder: { worker: { terminate: () => Promise<unknown> } | null } = { worker: null };
			try {
				return await withTimeout(
					opts.timeoutMs,
					async () => {
						const tesseract = await import("tesseract.js");
						const created = (await tesseract.createWorker("eng", undefined, {
							langPath: opts.dataDir,
							cachePath: opts.dataDir,
							cacheMethod: "none",
						})) as unknown as {
							recognize: (
								image: Uint8Array,
							) => Promise<{ data: { text: string; confidence: number } }>;
							terminate: () => Promise<unknown>;
						};
						holder.worker = created;
						const result = await created.recognize(bytes);
						const text = truncateUtf8(result.data.text.trim(), limits.maxTotalTextBytes);
						if (text === "")
							return {
								status: "unsupported",
								pages: [],
								textLayerRisk: false,
								pageCount: 1,
							};
						const confidence = Math.min(1, Math.max(0, (result.data.confidence ?? 0) / 100));
						return {
							status: confidence < limits.minConfidence ? "low_confidence" : "ready",
							pages: [{ text, source: "ocr", confidence, pageNumber: 1 }],
							textLayerRisk: false,
							pageCount: 1,
						};
					},
					() => holder.worker?.terminate().catch(() => {}),
				);
			} catch (err) {
				if (err instanceof OcrFailed) throw err;
				throw new OcrFailed(err instanceof Error ? err.message : "image OCR failed");
			} finally {
				await holder.worker?.terminate().catch(() => {});
			}
		},
	};
}

export interface OcrFactoryOptions extends ImageOcrOptions {}

export function createOcrAdapter(_opts: OcrFactoryOptions): OcrAdapter {
	const pdf = createPdfOcrAdapter();
	const image = createImageOcrAdapter(_opts);
	return { extractPdf: pdf.extractPdf, extractImage: image.extractImage };
}
