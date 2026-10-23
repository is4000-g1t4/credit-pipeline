import type { PolicyCaseSignal } from "./case-context.js";

export const SIGNAL_FAMILY: Record<PolicyCaseSignal["type"], string[]> = {
	negative_balance: ["affordability"],
	revenue_concentration: ["underwriting", "affordability"],
	round_trip: ["underwriting", "documentation"],
	cash_deposit_share: ["affordability"],
	declared_vs_observed_cashflow: ["affordability"],
	returned_payment: ["servicing", "affordability"],
	insufficient_data: ["documentation"],
};

export const DOCUMENT_FAMILY = "documentation";

export function policyFamiliesForSignal(signal: Pick<PolicyCaseSignal, "type">): string[] {
	return SIGNAL_FAMILY[signal.type] ?? ["documentation"];
}

/** Deterministic case→retrieval query. The structured context is the only
 * input; no applicant names or account identifiers reach the embedder. */
export function caseRetrievalText(input: {
	type: "individual" | "sme";
	product: "personal_loan" | "sme_term_loan";
	amountBand: string;
	termBand: string;
	signals: Array<Pick<PolicyCaseSignal, "type" | "metric" | "status" | "confidence">>;
	documentFindings: Array<{ field: string; status: string; confidence: string }>;
}): string {
	const signals = input.signals
		.map((signal) => `${signal.type} ${signal.metric} (${signal.status}, ${signal.confidence})`)
		.join("; ");
	const findings = input.documentFindings
		.map((finding) => `${finding.field} ${finding.status} (${finding.confidence})`)
		.join("; ");
	return [
		`Credit policy for ${input.type} ${input.product}`,
		`amount ${input.amountBand}`,
		`term ${input.termBand}`,
		signals ? `signals: ${signals}` : "",
		findings ? `document findings: ${findings}` : "",
	]
		.filter(Boolean)
		.join(". ");
}
