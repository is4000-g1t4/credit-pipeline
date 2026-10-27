// Single source of truth for reason-code → human text (SPEC FR-4.6).
// Policy code always renders reasons through this map — never inline strings.

export type PolicyReasonCode =
	| "AMOUNT_OUT_OF_RANGE"
	| "TERM_OUT_OF_RANGE"
	| "DTI_TOO_HIGH"
	| "SCORE_TOO_LOW"
	| "REVENUE_TOO_LOW"
	| "TRADING_HISTORY_TOO_SHORT"
	| "DSCR_TOO_LOW"
	| "AMOUNT_ABOVE_AUTO_LIMIT"
	| "SCORE_IN_REFER_BAND"
	| "DTI_IN_REFER_BAND"
	| "DSCR_IN_REFER_BAND"
	| "SHORT_EMPLOYMENT"
	| "TRADING_HISTORY_IN_REFER_BAND"
	| "SECTOR_REVIEW";

export type CheckReasonCode = "IDENTITY_FAILED" | "SANCTIONS_HIT";

export const OFFICER_REASON_CODES = [
	"OFFICER_JUDGEMENT",
	"INSUFFICIENT_EVIDENCE",
	"POLICY_EXCEPTION",
] as const;

export type OfficerReasonCode = (typeof OFFICER_REASON_CODES)[number];

export type ReasonCode = PolicyReasonCode | CheckReasonCode | OfficerReasonCode;

export interface PolicyReason {
	code: ReasonCode;
	text: string;
}

export const REASON_TEXT: Record<ReasonCode, string> = {
	AMOUNT_OUT_OF_RANGE: "Requested amount is outside the product bounds.",
	TERM_OUT_OF_RANGE: "Requested term is outside 12–60 months.",
	DTI_TOO_HIGH: "Debt-to-income ratio exceeds 50%.",
	SCORE_TOO_LOW: "Credit score below the minimum of 580.",
	REVENUE_TOO_LOW: "Annual revenue below the $50,000 minimum.",
	TRADING_HISTORY_TOO_SHORT: "Trading history under 1 year.",
	DSCR_TOO_LOW: "Debt-service coverage ratio below 1.0.",
	AMOUNT_ABOVE_AUTO_LIMIT: "Amount above the automatic-approval limit.",
	SCORE_IN_REFER_BAND: "Score in the manual-review band (580–699).",
	DTI_IN_REFER_BAND: "Debt-to-income ratio in the manual-review band (35–50%).",
	DSCR_IN_REFER_BAND: "Debt-service coverage ratio in the manual-review band (1.0–1.5).",
	SHORT_EMPLOYMENT: "Employment history under 1 year.",
	TRADING_HISTORY_IN_REFER_BAND: "Trading history between 1 and 2 years.",
	SECTOR_REVIEW: "Sector carries elevated risk; included for officer awareness.",
	IDENTITY_FAILED: "Identity verification failed.",
	SANCTIONS_HIT: "Sanctions screening returned a match.",
	OFFICER_JUDGEMENT: "Declined on officer judgement.",
	INSUFFICIENT_EVIDENCE: "Insufficient evidence to approve.",
	POLICY_EXCEPTION: "Declined as a policy exception.",
};

export function reasonText(code: string): string {
	return (REASON_TEXT as Record<string, string>)[code] ?? code;
}

export function makeReason(code: ReasonCode): PolicyReason {
	return { code, text: REASON_TEXT[code] };
}
