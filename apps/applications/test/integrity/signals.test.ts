import { describe, expect, it } from "vitest";
import {
	buildIntegritySignals,
	maxSeverity,
	shouldFlag,
	signalSourceRef,
} from "../../src/integrity/signals.js";
import type { DeterministicSignal } from "../../src/integrity/types.js";

const doc = {
	documentFileId: "11111111-1111-4111-8111-111111111111",
	textLayerRisk: false,
	ocrStatus: "ready" as const,
	ocrConfidence: 0.95,
	editSignal: "not_detected" as const,
	editCodes: [] as string[],
};

function base(overrides: Partial<Parameters<typeof buildIntegritySignals>[0]> = {}) {
	return buildIntegritySignals({
		documents: [doc],
		crosscheckFindings: [],
		duplicateCounts: { sameApplication: 0, sameApplicantOther: 0, crossApplicant: 0 },
		unconfirmedConsistencyCount: 0,
		minOcrConfidence: 0.7,
		...overrides,
	});
}

describe("deterministic integrity signals", () => {
	it("marks a cross-applicant duplicate high and a same-applicant copy medium", () => {
		const cross = base({
			duplicateCounts: { sameApplication: 0, sameApplicantOther: 0, crossApplicant: 2 },
		});
		expect(
			cross.find((signal) => signal.code === "duplicate_hash_cross_application")?.severity,
		).toBe("high");
		const same = base({
			duplicateCounts: { sameApplication: 0, sameApplicantOther: 1, crossApplicant: 0 },
		});
		expect(
			same.find((signal) => signal.code === "duplicate_hash_same_applicant_other_case")?.severity,
		).toBe("medium");
		expect(same.some((signal) => signal.code === "duplicate_hash_cross_application")).toBe(false);
	});

	it("derives crosscheck severity from finding confidence", () => {
		const high = base({
			crosscheckFindings: [
				{
					id: "finding",
					field: "company_name",
					status: "mismatch",
					confidence: "high",
					expected: "A",
					observed: "B",
					documentFileId: doc.documentFileId,
					pageNumber: 1,
					quote: "B",
					quoteStart: 0,
					quoteEnd: 1,
					quoteHash: "hash",
					reason: "value_mismatch",
				},
			],
		});
		expect(high.find((signal) => signal.code === "crosscheck_mismatch")?.severity).toBe("high");
	});

	it("never flags on metadata_unknown or an unconfirmed consistency candidate", () => {
		const signals = buildIntegritySignals({
			documents: [{ ...doc, editSignal: "unknown", editCodes: [] }],
			crosscheckFindings: [],
			duplicateCounts: { sameApplication: 0, sameApplicantOther: 0, crossApplicant: 0 },
			unconfirmedConsistencyCount: 2,
			minOcrConfidence: 0.7,
		});
		expect(signals.map((signal) => signal.code)).toEqual(
			expect.arrayContaining(["metadata_unknown", "consistency_candidate"]),
		);
		expect(shouldFlag(signals, "low")).toBe(false);
		expect(maxSeverity(signals)).toBe("medium");
	});

	it("flags when the configured threshold is crossed", () => {
		const signals = base({
			documents: [{ ...doc, textLayerRisk: true }],
		});
		expect(shouldFlag(signals, "medium")).toBe(true);
		expect(shouldFlag(signals, "high")).toBe(false);
	});

	it("builds a parseable context_signal ref per document", () => {
		const signals = base({ documents: [{ ...doc, ocrStatus: "unsupported" }] });
		expect(signals[0]?.sourceRef).toBe(signalSourceRef("ocr_unsupported", doc.documentFileId));
	});

	it("ignores non-signal noise", () => {
		const signals: DeterministicSignal[] = [
			{
				code: "metadata_unknown",
				severity: "low",
				documentFileId: null,
				summary: "unknown",
				sourceRef: "context_signal:integrity:metadata_unknown",
			},
		];
		expect(shouldFlag(signals, "low")).toBe(false);
	});
});
