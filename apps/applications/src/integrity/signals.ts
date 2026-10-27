// E2 deterministic integrity signals (pure).
//
// Signals are audit-friendly metadata: code + severity + document id + a
// short non-PII summary. They never contain page text, names, or amounts.
// Only the service-side duplicate query sees cross-application counts.

import type {
	DeterministicSignal,
	IntegrityCrosscheckFinding,
	IntegrityDuplicateCounts,
	IntegritySeverity,
	IntegritySignalCode,
} from "./types.js";
import { NON_FLAGGING_SIGNAL_CODES } from "./types.js";

export interface SignalDocumentInput {
	documentFileId: string;
	textLayerRisk: boolean;
	ocrStatus: "ready" | "low_confidence" | "unsupported" | "failed" | "not_applicable";
	ocrConfidence: number | null;
	editSignal: "detected" | "not_detected" | "unknown";
	editCodes: string[];
}

export interface SignalInput {
	documents: SignalDocumentInput[];
	crosscheckFindings: IntegrityCrosscheckFinding[] | null;
	duplicateCounts: IntegrityDuplicateCounts;
	unconfirmedConsistencyCount: number;
	minOcrConfidence: number;
}

const SEVERITY_RANK: Record<IntegritySeverity, number> = { low: 1, medium: 2, high: 3 };

export function maxSeverity(signals: DeterministicSignal[]): IntegritySeverity | null {
	let best: IntegritySeverity | null = null;
	for (const signal of signals) {
		if (best === null || SEVERITY_RANK[signal.severity] > SEVERITY_RANK[best]) {
			best = signal.severity;
		}
	}
	return best;
}

export function shouldFlag(signals: DeterministicSignal[], threshold: IntegritySeverity): boolean {
	const flaggable = signals.filter((signal) => !NON_FLAGGING_SIGNAL_CODES.includes(signal.code));
	const best = maxSeverity(flaggable);
	return best !== null && SEVERITY_RANK[best] >= SEVERITY_RANK[threshold];
}

export function signalSourceRef(code: IntegritySignalCode, documentFileId?: string): string {
	return `context_signal:integrity:${code}${documentFileId ? `:${documentFileId}` : ""}`;
}

function signal(
	code: IntegritySignalCode,
	severity: IntegritySeverity,
	summary: string,
	documentFileId: string | null = null,
	count?: number,
): DeterministicSignal {
	return {
		code,
		severity,
		documentFileId,
		summary,
		sourceRef: signalSourceRef(code, documentFileId ?? undefined),
		...(count === undefined ? {} : { count }),
	};
}

export function buildIntegritySignals(input: SignalInput): DeterministicSignal[] {
	const signals: DeterministicSignal[] = [];
	const counts = input.duplicateCounts;

	if (counts.crossApplicant > 0) {
		signals.push(
			signal(
				"duplicate_hash_cross_application",
				"high",
				"identical file hash appears in a different applicant's application",
				null,
				counts.crossApplicant,
			),
		);
	}
	if (counts.sameApplicantOther > 0) {
		signals.push(
			signal(
				"duplicate_hash_same_applicant_other_case",
				"medium",
				"identical file hash appears in another case for the same applicant",
				null,
				counts.sameApplicantOther,
			),
		);
	}
	if (counts.sameApplication > 0) {
		signals.push(
			signal(
				"duplicate_hash_same_application",
				"medium",
				"identical file hash appears more than once in this case",
				null,
				counts.sameApplication,
			),
		);
	}

	for (const finding of input.crosscheckFindings ?? []) {
		if (finding.status !== "mismatch") continue;
		const severity: IntegritySeverity = finding.confidence === "high" ? "high" : "medium";
		signals.push(
			signal(
				"crosscheck_mismatch",
				severity,
				"deterministic cross-check found a field mismatch",
				finding.documentFileId,
			),
		);
		if (finding.reason.includes("confusable")) {
			signals.push(
				signal(
					"crosscheck_confusable",
					"medium",
					"registration number differs by a confusable character",
					finding.documentFileId,
				),
			);
		}
	}

	if (input.unconfirmedConsistencyCount > 0) {
		signals.push(
			signal(
				"consistency_candidate",
				"medium",
				"AI consistency candidates are awaiting deterministic confirmation",
				null,
				input.unconfirmedConsistencyCount,
			),
		);
	}

	for (const doc of input.documents) {
		if (doc.textLayerRisk) {
			signals.push(
				signal("text_layer_risk", "medium", "text layer risk detected", doc.documentFileId),
			);
		}
		if (doc.ocrStatus === "low_confidence") {
			signals.push(
				signal("ocr_low_confidence", "low", "OCR confidence is low", doc.documentFileId),
			);
		} else if (doc.ocrConfidence !== null && doc.ocrConfidence < input.minOcrConfidence) {
			signals.push(
				signal(
					"ocr_low_confidence",
					"low",
					"mean OCR confidence is below the configured threshold",
					doc.documentFileId,
				),
			);
		}
		if (doc.ocrStatus === "unsupported" || doc.ocrStatus === "failed") {
			signals.push(
				signal(
					"ocr_unsupported",
					"medium",
					"document text could not be extracted",
					doc.documentFileId,
				),
			);
		}
		for (const code of doc.editCodes) {
			if (code === "incremental_update") {
				signals.push(
					signal(
						"incremental_update",
						"medium",
						"PDF contains incremental updates",
						doc.documentFileId,
					),
				);
			} else if (code === "editor_producer") {
				signals.push(
					signal("editor_producer", "medium", "PDF producer is an editor", doc.documentFileId),
				);
			} else if (code === "recompression_editor") {
				signals.push(
					signal(
						"recompression_editor",
						"medium",
						"scan-expected document came from an image editor",
						doc.documentFileId,
					),
				);
			} else if (code === "metadata_date_inversion") {
				signals.push(
					signal(
						"metadata_date_inversion",
						"medium",
						"PDF modified date precedes its created date",
						doc.documentFileId,
					),
				);
			}
		}
		if (doc.editSignal === "unknown") {
			signals.push(
				signal("metadata_unknown", "low", "provenance metadata is unavailable", doc.documentFileId),
			);
		}
	}

	return signals;
}
