import { describe, expect, it } from "vitest";
import {
	confirmConsistency,
	normalizeCandidateValue,
	parseAmountValue,
	parseDateValue,
	verifyQuote,
} from "../../src/agents/integrity/index.js";
import type { IntegrityConsistencyProposal } from "../../src/integrity/types.js";

const page =
	"BANK STATEMENT\nAccount Holder: ACME PTE LTD\nStatement Period: 1 May 2026 to 31 May 2026\nTotal Amount: SGD 12,000.00\n";

describe("integrity validators", () => {
	it("locates quotes by code point, including surrogate pairs", () => {
		const text = "😀 opening\nAccount Holder: ACME";
		const hit = verifyQuote(text, "Account Holder: ACME");
		expect(hit).not.toBeNull();
		expect([...text].slice(hit!.offsetStart, hit!.offsetEnd).join("")).toBe("Account Holder: ACME");
		// The emoji counts as one code point, not two UTF-16 units.
		expect(hit!.offsetStart).toBe("😀 opening\n".length - 1);
		expect(verifyQuote(text, "missing")).toBeNull();
	});

	it("parses dates and amounts without guessing", () => {
		expect(parseDateValue("1 May 2026")?.toISOString().slice(0, 10)).toBe("2026-05-01");
		expect(parseDateValue("2026-05-01")?.toISOString().slice(0, 10)).toBe("2026-05-01");
		expect(parseDateValue("May 1, 2026")?.toISOString().slice(0, 10)).toBe("2026-05-01");
		expect(parseDateValue("not a date")).toBeNull();
		expect(parseAmountValue("SGD 12,000.00")).toBe(12000);
		expect(normalizeCandidateValue("material_amount", "SGD 12,000.00")).toBe("SGD12000.00");
	});

	it("rejects impossible calendar dates", () => {
		expect(parseDateValue("2026-02-31")).toBeNull();
		expect(parseDateValue("31/02/2026")).toBeNull();
		expect(parseDateValue("31 Feb 2026")).toBeNull();
		expect(parseDateValue("29 Feb 2024")?.toISOString().slice(0, 10)).toBe("2024-02-29");
	});

	it("confirms names only with the deterministic comparator", () => {
		const proposal: IntegrityConsistencyProposal = {
			field: "company_name",
			proposedKind: "mismatch",
			left: {
				documentFileId: "11111111-1111-4111-8111-111111111111",
				pageNumber: 1,
				value: "ACME PTE LTD",
				label: "account holder",
				quote: "Account Holder: ACME PTE LTD",
			},
			right: {
				documentFileId: "22222222-2222-4222-8222-222222222222",
				pageNumber: 1,
				value: "ACME PRIVATE LIMITED",
				label: "account holder",
				quote: "Account Holder: ACME PRIVATE LIMITED",
			},
		};
		const result = confirmConsistency({
			proposal,
			leftPageText: page,
			rightPageText: "Account Holder: ACME PRIVATE LIMITED\n",
		});
		// Differ only by corporate suffix: the deterministic crosscheck treats
		// that as needs_chase, not a confirmed match or mismatch.
		expect(result.status).toBe("candidate");
		expect(result.kind).toBeNull();
		expect(result.reason).toBe("name_suffix");
	});

	it("confirms an amount mismatch only with the same label and currency", () => {
		const proposal: IntegrityConsistencyProposal = {
			field: "material_amount",
			proposedKind: "mismatch",
			left: {
				documentFileId: "11111111-1111-4111-8111-111111111111",
				pageNumber: 1,
				value: "SGD 12,000.00",
				label: "total amount",
				currency: "SGD",
				quote: "Total Amount: SGD 12,000.00",
			},
			right: {
				documentFileId: "22222222-2222-4222-8222-222222222222",
				pageNumber: 1,
				value: "SGD 13,000.00",
				label: "total amount",
				currency: "SGD",
				quote: "Total Amount: SGD 13,000.00",
			},
		};
		const result = confirmConsistency({
			proposal,
			leftPageText: page,
			rightPageText: "Total Amount: SGD 13,000.00\n",
		});
		expect(result.status).toBe("confirmed");
		expect(result.kind).toBe("mismatch");
		expect(result.explanation).toContain("Total Amount: SGD 12,000.00");
		expect(result.explanationVerified).toBe(true);
	});

	it("leaves a cross-currency amount as needs-chase, never confirmed", () => {
		const proposal: IntegrityConsistencyProposal = {
			field: "material_amount",
			proposedKind: "mismatch",
			left: {
				documentFileId: "11111111-1111-4111-8111-111111111111",
				pageNumber: 1,
				value: "SGD 12,000.00",
				label: "total amount",
				currency: "SGD",
				quote: "Total Amount: SGD 12,000.00",
			},
			right: {
				documentFileId: "22222222-2222-4222-8222-222222222222",
				pageNumber: 1,
				value: "USD 12,000.00",
				label: "total amount",
				currency: "USD",
				quote: "Total Amount: USD 12,000.00",
			},
		};
		const result = confirmConsistency({
			proposal,
			leftPageText: page,
			rightPageText: "Total Amount: USD 12,000.00\n",
		});
		expect(result.status).toBe("candidate");
		expect(result.kind).toBeNull();
		expect(result.explanation).toBeNull();
	});

	it("rejects a quote that does not exist on the cited page", () => {
		const proposal: IntegrityConsistencyProposal = {
			field: "company_name",
			proposedKind: "mismatch",
			left: {
				documentFileId: "11111111-1111-4111-8111-111111111111",
				pageNumber: 1,
				value: "ACME",
				label: "account holder",
				quote: "Not on the page",
			},
			right: {
				documentFileId: "22222222-2222-4222-8222-222222222222",
				pageNumber: 1,
				value: "ACME",
				label: "account holder",
				quote: "Account Holder: ACME",
			},
		};
		const result = confirmConsistency({
			proposal,
			leftPageText: page,
			rightPageText: "Account Holder: ACME",
		});
		expect(result.status).toBe("rejected");
	});
});
