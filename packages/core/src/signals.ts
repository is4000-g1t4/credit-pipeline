// T18 signal vocabulary — single source of truth (SPEC-t17-t18 §3.3, D3a).
// Previously triplicated across policy case-context, research
// context-validator, and applications context/metrics; a drift would silently
// drop real signals at the policy boundary.

export const SIGNAL_TYPES = [
	"negative_balance",
	"revenue_concentration",
	"round_trip",
	"cash_deposit_share",
	"declared_vs_observed_cashflow",
	"returned_payment",
	"insufficient_data",
] as const;

export const SIGNAL_METRICS = [
	"negative_eod_days",
	"top_inflow_share",
	"round_trip_pairs",
	"cash_inflow_share",
	"monthly_fcf_variance",
	"returned_count",
	"usable_rows",
] as const;

export const DOCUMENT_FIELDS = [
	"company_name",
	"registration_number",
	"account_holder_name",
	"applicant_name",
	"other",
] as const;

export const SIGNAL_STATUSES = ["review", "needs_chase", "insufficient_data"] as const;

export const DOCUMENT_STATUSES = ["mismatch", "needs_chase"] as const;

export const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;

export type SignalType = (typeof SIGNAL_TYPES)[number];
export type SignalMetric = (typeof SIGNAL_METRICS)[number];
export type DocumentField = (typeof DOCUMENT_FIELDS)[number];
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];
