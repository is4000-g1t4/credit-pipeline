// Shared quote locator: exact first, hard-wrap-tolerant fallback, boundary
// rejection, and the minLength gate (policy 20, research 0).
import { describe, expect, it } from "vitest";
import { locateQuote } from "../src/index.js";

describe("locateQuote", () => {
	it("returns exact matches with offsets", () => {
		expect(locateQuote("alpha beta gamma", "beta gamma")).toEqual({
			quote: "beta gamma",
			quoteStart: 6,
			quoteEnd: 16,
		});
	});

	it("returns exact matches even below minLength", () => {
		expect(locateQuote("abcdef", "cde", { minLength: 20 })).toEqual({
			quote: "cde",
			quoteStart: 2,
			quoteEnd: 5,
		});
	});

	it("normalizes hard-wrapped whitespace and returns the canonical slice", () => {
		const text = "Intro.\nAcme Ltd filed its annual return on 15 April 2025.\nActive.";
		const found = locateQuote(text, "Acme Ltd filed its annual return on 15 April 2025.");
		expect(found?.quote).toBe("Acme Ltd filed its annual return on 15 April 2025.");
		expect(text.slice(found!.quoteStart, found!.quoteEnd)).toBe(found!.quote);
		const wrapped = locateQuote(text, "Acme Ltd filed its annual return on\n15 April 2025.");
		expect(wrapped?.quote).toBe("Acme Ltd filed its annual return on 15 April 2025.");
	});

	it("rejects quotes stitching separate list items", () => {
		expect(
			locateQuote("Rules:\n- item one\n- item two\n- item three", "item one - item two", {
				minLength: 0,
			}),
		).toBeNull();
	});

	it("rejects quotes stitching separate paragraphs", () => {
		expect(locateQuote("para one\n\npara two", "one para two", { minLength: 0 })).toBeNull();
	});

	it("rejects normalized matches below minLength, allows them at 0", () => {
		const text = "say hello\nworld today";
		const quote = "o world";
		expect(text.indexOf(quote)).toBe(-1);
		expect(locateQuote(text, quote)).not.toBeNull();
		expect(locateQuote(text, quote, { minLength: 0 })).not.toBeNull();
		expect(locateQuote(text, quote, { minLength: 20 })).toBeNull();
	});

	it("returns null for an absent quote", () => {
		expect(locateQuote("some content here", "absent quote", { minLength: 0 })).toBeNull();
	});
});
