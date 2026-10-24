// Blocking validator, pure functions (§6.4). Server assigns UUIDs, computes
// snapshot hashes, and discards the model's self-reported confidence.
import { createHash } from "node:crypto";
import { z } from "zod";

// --- Model output schema (§6.3) ---

export const modelBriefSchema = z
	.object({
		summary: z.string().min(1).max(2000),
		findings: z
			.array(
				z
					.object({
						claim: z.string().min(1).max(2000),
						category: z.enum(["adverse_media", "reputation", "registry", "market", "other"]),
						whyItMatters: z.string().min(1).max(1000),
						allegationStatus: z.enum(["alleged", "charged", "convicted", "settled", "unknown"]),
						entityMatch: z.object({
							identifierType: z.enum(["registration_number", "name_city", "name_only"]),
							value: z.string().min(1).max(500),
							confidence: z.enum(["low", "medium", "high"]),
						}),
						// The prompt requires every finding to cite its sources
						// by localId; validators judge only those links (plus
						// the fallback below when the model cites nothing).
						evidenceLocalIds: z.array(z.string().max(50)).max(20).default([]),
					})
					.strict(),
			)
			.max(20),
		evidence: z
			.array(
				z
					.object({
						localId: z.string().min(1).max(50),
						url: z.string().min(1).max(2000),
						title: z.string().max(500).nullish(),
						publisher: z.string().max(300).nullish(),
						publishedAt: z.string().max(30).nullish(),
						quote: z.string().min(1).max(5000),
					})
					.strict(),
			)
			.max(20),
		contradictions: z
			.array(
				z
					.object({
						description: z.string().min(1).max(1000),
						evidenceLocalIds: z.array(z.string().max(50)).max(20),
					})
					.strict(),
			)
			.max(20),
		unknowns: z.array(z.string().min(1).max(500)).max(20),
		questionsForOfficer: z.array(z.string().min(1).max(500)).max(20),
	})
	.strict();

export type ModelBrief = z.infer<typeof modelBriefSchema>;

// --- Forbidden terms / decision language (§6.3). Exact quotes are exempt;
// callers scan generated text only, never `quote` fields. ---

const FORBIDDEN_RE =
	/\b(recommend\w*|decisions?|approv\w*|declin\w*|risk\s*grades?|scores?|rates?|limits?|terms?)\b/i;
const IMPLICIT_VERDICT_RE = /\bnot bankable\b|\bhigh risk\b|\btoo risky\b|\bunbankable\b/i;

export function scanForbidden(text: string): string[] {
	const hits: string[] = [];
	const word = text.match(FORBIDDEN_RE);
	if (word) hits.push(word[1].toLowerCase());
	const verdict = text.match(IMPLICIT_VERDICT_RE);
	if (verdict) hits.push(verdict[0].toLowerCase());
	return hits;
}

// --- Evidence snapshot (§4 agent_evidence, §6.4.2) ---

export const MAX_SNAPSHOT_BYTES = 20 * 1024;
const WINDOW_BEFORE_BYTES = 4 * 1024;

export interface Snapshot {
	snapshotText: string;
	/** Canonical quote slice from the source; differs from the model quote only
	 * when hard-wrapped whitespace was normalized. */
	quote: string;
	quoteStart: number;
	quoteEnd: number;
	snapshotHash: string;
	rawContentSha256: string;
}

export function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Locate a quote in fetched text. Models routinely copy a hard-wrapped source
 * with spaces where the page has newlines; exact-only matching would drop a
 * valid citation. Try exact first, then a whitespace-normalized match and
 * return the canonical slice so persisted offsets remain exact.
 */
export function locateQuote(
	text: string,
	quote: string,
): { quote: string; quoteStart: number; quoteEnd: number } | null {
	const exact = text.indexOf(quote);
	if (exact >= 0) return { quote, quoteStart: exact, quoteEnd: exact + quote.length };
	const normalize = (value: string): { text: string; map: number[] } => {
		const chars: string[] = [];
		const map: number[] = [];
		let lastSpace = false;
		for (let i = 0; i < value.length; i++) {
			const ch = value[i] as string;
			if (/\s/.test(ch)) {
				if (!lastSpace && chars.length > 0) {
					chars.push(" ");
					map.push(i);
					lastSpace = true;
				}
			} else {
				chars.push(ch);
				map.push(i);
				lastSpace = false;
			}
		}
		if (chars[chars.length - 1] === " ") {
			chars.pop();
			map.pop();
		}
		return { text: chars.join(""), map };
	};
	const haystack = normalize(text);
	const needle = normalize(quote.trim());
	if (needle.text.length === 0) return null;
	const hit = haystack.text.indexOf(needle.text);
	if (hit < 0) return null;
	const start = haystack.map[hit];
	const end = haystack.map[hit + needle.text.length - 1];
	if (start === undefined || end === undefined) return null;
	const canonical = text.slice(start, end + 1);
	// Whitespace normalization is for hard wraps, not for stitching separate
	// bullets, table rows, or paragraphs into one quote.
	if (/\n\s*\n/.test(canonical)) return null;
	if (/\n\s*(?:[-*+|#]|\d+\.)\s/.test(canonical)) return null;
	return { quote: canonical, quoteStart: start, quoteEnd: end + 1 };
}

/** Deterministic window (≤20 KB) around the quote; offsets are string
 * indices into `snapshotText` so `slice(start, end) === quote` verifies. */
export function buildSnapshot(rawContent: string, quote: string): Snapshot {
	if (!quote) throw new Error("quote must not be empty");
	const located = locateQuote(rawContent, quote);
	if (!located) throw new Error("quote is not a substring of the fetched content");
	const canonical = located.quote;
	if (Buffer.byteLength(canonical, "utf8") > MAX_SNAPSHOT_BYTES) {
		throw new Error("quote exceeds the snapshot window");
	}
	const idx = located.quoteStart;
	const rawContentSha256 = sha256Hex(rawContent);
	if (Buffer.byteLength(rawContent, "utf8") <= MAX_SNAPSHOT_BYTES) {
		return {
			snapshotText: rawContent,
			quote: canonical,
			quoteStart: idx,
			quoteEnd: idx + canonical.length,
			snapshotHash: sha256Hex(rawContent),
			rawContentSha256,
		};
	}
	// Byte-accurate window: walk back ≤4 KB, forward to ≤20 KB total.
	let start = idx;
	while (
		start > 0 &&
		Buffer.byteLength(rawContent.slice(start - 1, idx), "utf8") < WINDOW_BEFORE_BYTES
	) {
		start -= 1;
	}
	// Clamp: a large quote plus the look-behind must still fit the window —
	// the bytes from the snapshot start through the end of the quote are
	// capped at 20 KB (multibyte-safe: measured, not counted).
	const quoteLen = idx + canonical.length;
	while (
		start < idx &&
		Buffer.byteLength(rawContent.slice(start, quoteLen), "utf8") > MAX_SNAPSHOT_BYTES
	) {
		start += 1;
	}
	let end = idx + canonical.length;
	while (
		end < rawContent.length &&
		Buffer.byteLength(rawContent.slice(start, end + 1), "utf8") <= MAX_SNAPSHOT_BYTES
	) {
		end += 1;
	}
	// Do not split a UTF-16 surrogate pair at the window boundary: a lone
	// surrogate becomes U+FFFD when stored. The quote itself is unaffected.
	if (start < idx && start < rawContent.length) {
		const code = rawContent.charCodeAt(start);
		if (code >= 0xdc00 && code <= 0xdfff) start += 1;
	}
	if (end > start && end < rawContent.length) {
		const code = rawContent.charCodeAt(end);
		if (code >= 0xdc00 && code <= 0xdfff) end -= 1;
	}
	const safeSnapshotText = rawContent.slice(start, end);
	return {
		snapshotText: safeSnapshotText,
		quote: canonical,
		quoteStart: idx - start,
		quoteEnd: idx - start + canonical.length,
		snapshotHash: sha256Hex(safeSnapshotText),
		rawContentSha256,
	};
}

export function verifyQuote(
	snapshotText: string,
	quote: string,
	quoteStart: number,
	quoteEnd: number,
): boolean {
	return (
		Number.isInteger(quoteStart) &&
		Number.isInteger(quoteEnd) &&
		quoteStart >= 0 &&
		quoteEnd <= snapshotText.length &&
		quoteStart < quoteEnd &&
		snapshotText.slice(quoteStart, quoteEnd) === quote
	);
}

// --- Dates (§6.4.3) ---

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Strict YYYY-MM-DD + real calendar date, else null. Never invented. */
export function normalizePublishedAt(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const m = DATE_RE.exec(value.trim());
	if (!m) return null;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
	const dt = new Date(Date.UTC(y, mo - 1, d));
	if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d)
		return null;
	return `${m[1]}-${m[2]}-${m[3]}`;
}

export function asOfDate(asOfIso: string): string {
	const dt = new Date(asOfIso);
	if (!Number.isFinite(dt.getTime())) throw new Error("invalid asOf timestamp");
	return dt.toISOString().slice(0, 10);
}

export type DateBasis = "publisher_metadata" | "tavily_estimate" | "unknown";

/**
 * Publication-date resolution (§6.4.3): the model's date is trusted only
 * when it is verified in the fetched page text; otherwise the Tavily
 * estimate wins; otherwise null + unknown. Never invented.
 */
export function resolvePublishedDate(opts: {
	modelDate: unknown;
	rawContent: string;
	tavilyDate: string | null;
}): { publishedAt: string | null; dateBasis: DateBasis } {
	const model = normalizePublishedAt(opts.modelDate);
	if (model && opts.rawContent.includes(model)) {
		return { publishedAt: model, dateBasis: "publisher_metadata" };
	}
	if (opts.tavilyDate && normalizePublishedAt(opts.tavilyDate)) {
		return { publishedAt: opts.tavilyDate, dateBasis: "tavily_estimate" };
	}
	return { publishedAt: null, dateBasis: "unknown" };
}

// --- Entity match (§6.4.6) ---

export interface CaseEntity {
	kind: "individual" | "sme";
	applicantName: string;
	companyName: string | null;
	registrationNumber: string | null;
	city: string | null;
}

export type IdentifierType = "registration_number" | "name_city" | "name_only";
export type Confidence = "low" | "medium" | "high";

export interface AssessedEntityMatch {
	identifierType: IdentifierType;
	value: string;
	confidence: Confidence;
	capped: boolean;
	reasons: string[];
}

const normReg = (v: string): string => v.replace(/[\s-]/g, "").toUpperCase();
const normName = (v: string): string =>
	v
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

/**
 * Deterministic entity assessment (§6.4.6/8): the model's self-reported
 * confidence is discarded — the verdict derives from the case facts plus
 * whether an official source was cited. `name_city` requires the normalized
 * case name and city to appear in the model's value.
 */
export function assessEntityMatch(
	entity: CaseEntity,
	model: { identifierType: IdentifierType; value: string; confidence: Confidence },
	opts: { officialSourceCited: boolean },
): AssessedEntityMatch {
	const reasons: string[] = [];
	const value = normName(model.value);
	const names = [
		normName(entity.applicantName),
		entity.companyName ? normName(entity.companyName) : "",
	].filter((n) => n !== "");
	const city = entity.city ? normName(entity.city) : "";
	let confidence: Confidence = "low";
	if (model.identifierType === "registration_number") {
		if (
			entity.registrationNumber &&
			normReg(model.value) !== "" &&
			normReg(model.value) === normReg(entity.registrationNumber)
		) {
			confidence = "high";
		} else {
			reasons.push("registration number does not match the case");
		}
	} else if (model.identifierType === "name_city") {
		const nameOk = names.some((n) => value.includes(n));
		const cityOk = city !== "" && value.includes(city);
		if (!entity.city) {
			reasons.push("name_city match without a case city");
		} else if (!nameOk || !cityOk) {
			reasons.push("name_city value must contain the case name and city");
		} else if (entity.kind === "individual" && !opts.officialSourceCited) {
			confidence = "medium";
			reasons.push("individual high confidence needs name+city plus an official source");
		} else {
			confidence = "high";
		}
	} else {
		reasons.push("name_only is never high confidence");
	}
	return {
		identifierType: model.identifierType,
		value: model.value,
		confidence,
		capped: reasons.length > 0,
		reasons,
	};
}

// --- Deterministic confidence (§6.4.7/8; model confidence is discarded) ---

export type FindingCategory = "adverse_media" | "reputation" | "registry" | "market" | "other";

export interface ConfidenceInput {
	category: FindingCategory;
	/** Count of independent reputable/official sources (review platforms excluded). */
	independentCount: number;
	hasOfficial: boolean;
	/** True when every cited source is a review platform. */
	reviewPlatformOnly: boolean;
	/** True when any cited news/review source is undated. */
	undatedNews: boolean;
	entityConfidence: Confidence;
}

export interface DecidedConfidence {
	confidence: Confidence;
	basis: Record<string, unknown>;
	limitations: string[];
}

/** High-impact negative (adverse_media) needs one official source or two
 * independent reputable sources; otherwise capped low + an unknowns entry. */
export function decideConfidence(input: ConfidenceInput): DecidedConfidence {
	const limitations: string[] = [];
	let confidence: Confidence =
		input.independentCount >= 2 || input.hasOfficial
			? "high"
			: input.independentCount === 1
				? "medium"
				: "low";
	const cap = (level: Confidence, reason: string): void => {
		const order: Confidence[] = ["low", "medium", "high"];
		if (order.indexOf(level) < order.indexOf(confidence)) {
			confidence = level;
			limitations.push(reason);
		}
	};
	if (input.reviewPlatformOnly) {
		cap("low", "review-platform sources are capped at low confidence");
	}
	if (input.category === "adverse_media" && !(input.hasOfficial || input.independentCount >= 2)) {
		cap(
			"low",
			"single-source adverse finding: needs one official source or two independent reputable sources",
		);
	}
	if (input.undatedNews) {
		cap("low", "undated news/review source: date could not be verified");
	}
	if (input.entityConfidence === "low") {
		cap("low", "weak entity match caps confidence");
	}
	return {
		confidence,
		basis: {
			category: input.category,
			independentCount: input.independentCount,
			hasOfficial: input.hasOfficial,
			reviewPlatformOnly: input.reviewPlatformOnly,
			undatedNews: input.undatedNews,
			entityConfidence: input.entityConfidence,
		},
		limitations,
	};
}

// --- Protected attributes (§6.4.9): denylist, no ML classifier in v1 ---

const PROTECTED_RE =
	/\b(hiv|aids|cancer|diabet|depressi|bipolar|schizophren|disab|pregnan|muslim|christian|catholic|protestant|jewish|hindu|sikh|buddhist|atheist|gay|lesbian|bisexual|transgender|homosexual|ethnic|race|racial|skin colou?r|national origin|caste)\w*/i;
const FRAUD_RECORD_RE = /\b(fraud|insolven|bankrupt|convict|money laundering|embezzl)/i;

export function scanProtected(text: string): string[] {
	const m = text.match(PROTECTED_RE);
	return m ? [m[0].toLowerCase()] : [];
}

/** Narrow exception: the term is directly part of a legitimate public
 * fraud/insolvency record from an official or registry source. */
export function piiExceptionApplies(claim: string, tiers: string[]): boolean {
	return FRAUD_RECORD_RE.test(claim) && tiers.some((t) => t === "official" || t === "registry");
}

// --- Validator scores (§6.4.10) ---

export interface ValidationScores {
	citation_valid: number;
	evidence_coverage: number;
	unsupported_claims: number;
	entity_match_confidence: number;
	pii_leak: number;
	support_pass_rate: number;
}
