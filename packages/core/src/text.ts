// Shared quote locator (policy citations, research snapshots). Models copy a
// hard-wrapped source with spaces where the page has newlines, so exact-only
// matching would drop a valid citation. Try the exact match first, then a
// whitespace-normalized match and return the canonical substring (with its
// original offsets) so stored citations remain exact.

export interface LocatedQuote {
	quote: string;
	quoteStart: number;
	quoteEnd: number;
}

// --- Code-point offsets (quotes index raw stored text by Unicode code
// point, never UTF-16 — surrogate pairs count as one) ---

/** Slice `text` by Unicode code-point indices (String.prototype tolerant). */
export function codePointSlice(text: string, start: number, end: number): string {
	return [...text].slice(start, end).join("");
}

export function codePointLength(text: string): number {
	return [...text].length;
}

/** UTF-16 index (e.g. RegExp `match.index`) → code-point index. */
export function utf16IndexToCodePoint(text: string, utf16Index: number): number {
	return Array.from(text.slice(0, utf16Index)).length;
}

export function locateQuote(
	text: string,
	quote: string,
	opts?: { minLength?: number },
): LocatedQuote | null {
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
	if (needle.text.length < (opts?.minLength ?? 0)) return null;
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
