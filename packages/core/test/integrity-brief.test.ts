import { describe, expect, it } from "vitest";
import {
	hashQuote,
	sourceRefKey,
	type EvidenceBundle,
	type EvidenceItem,
	type SourceRef,
} from "../src/evidence.js";
import {
	validateGeneratedText,
	type DocumentIntegrityBriefContent,
} from "../src/generated-text.js";

const appId = "55555555-5555-4555-8555-555555555555";
const documentId = "11111111-1111-4111-8111-111111111111";
const signalRef = "integrity:crosscheck_mismatch";
const documentQuote = "Account Holder: ACME PTE LTD";
const signalText = "deterministic cross-check found a field mismatch";

const documentRef = {
	type: "document",
	documentFileId: documentId,
	pageNumber: 1,
	offsetStart: 0,
	offsetEnd: documentQuote.length,
} as SourceRef;
const signalSourceRef = { type: "context_signal", signalRef } as SourceRef;

function item(ref: SourceRef, content: string): EvidenceItem {
	return {
		ref: sourceRefKey(ref),
		sourceType: ref.type,
		label: ref.type,
		content,
		access: { retentionUntil: null, legalHold: false },
		metadata: {},
	};
}

function bundle(): EvidenceBundle {
	return {
		applicationId: appId,
		asOf: "2026-06-30T00:00:00.000Z",
		assembledAt: "2026-06-30T00:00:00.000Z",
		items: [item(documentRef, documentQuote), item(signalSourceRef, signalText)],
		unavailable: [],
	};
}

function validBrief(): DocumentIntegrityBriefContent {
	return {
		title: "Document integrity triage",
		summary: {
			text: "The account holder name differs from the case record.",
			citations: [{ ref: sourceRefKey(documentRef), quote: "Account Holder: ACME PTE LTD" }],
		},
		candidateContradictions: [
			{
				text: "The deterministic cross-check found a field mismatch.",
				citations: [{ ref: sourceRefKey(signalSourceRef), quote: signalText }],
			},
		],
		missingEvidence: [],
		alternativeExplanations: [],
		questionsForReviewer: ["Could the reviewer confirm the account holder name?"],
		suggestedPriority: "medium",
	};
}

function validate(content: unknown, forbiddenValues: string[] = []) {
	return validateGeneratedText({
		artifactType: "document_integrity_brief",
		content,
		evidence: bundle(),
		forbiddenValues,
	});
}

describe("document integrity brief validator", () => {
	it("accepts a cited brief with descriptive limit/rate language", () => {
		const brief = validBrief();
		brief.summary.text = "The statement discusses a credit limit and an interest rate.";
		const result = validate(brief);
		expect(result.ok).toBe(true);
	});

	it("rejects an uncited summary as a schema error", () => {
		const brief = validBrief() as unknown as Record<string, unknown>;
		(brief.summary as { citations: unknown[] }).citations = [];
		const result = validate(brief);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.issues[0]?.code).toBe("SCHEMA_INVALID");
	});

	it("rejects a quote that is not an exact source excerpt", () => {
		const brief = validBrief();
		brief.summary.citations[0]!.quote = "Account Holder: OTHER PTE LTD";
		const result = validate(brief);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.issues.map((issue) => issue.code)).toContain("CITATION_QUOTE_MISMATCH");
		}
	});

	it("rejects definitive fraud/tampering statements", () => {
		const brief = validBrief();
		brief.summary.text = "This is confirmed fraud.";
		const result = validate(brief);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.issues.map((issue) => issue.code)).toContain("DEFINITIVE_FRAUD_LANGUAGE");
		}
	});

	it("allows a fraud/tampering question but rejects a non-interrogative one", () => {
		const brief = validBrief();
		brief.questionsForReviewer = ["Could this be tampering?"];
		expect(validate(brief).ok).toBe(true);
		brief.questionsForReviewer = ["The document is tampered."];
		const result = validate(brief);
		expect(result.ok).toBe(false);
	});

	it("rejects another application reference or a forbidden customer value", () => {
		const brief = validBrief();
		brief.summary.text = "See APP-2026-ABCDEF for the other application.";
		const result = validate(brief);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.issues.map((issue) => issue.code)).toContain("CROSS_CUSTOMER_REFERENCE");
		}
		const brief2 = validBrief();
		brief2.summary.text = "The other applicant is Jane Doe.";
		const result2 = validate(brief2, ["Jane Doe"]);
		expect(result2.ok).toBe(false);
	});

	it("rejects recommendation language in the brief", () => {
		const brief = validBrief();
		brief.summary.text = "We recommend declining this case.";
		const result = validate(brief);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.issues.map((issue) => issue.code)).toContain("DECISION_LANGUAGE");
		}
	});
});
