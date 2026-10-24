// T18 vocabulary stability: the shared tuples must not drift — policy,
// research, and applications all derive from them.
import { describe, expect, it } from "vitest";
import {
	CONFIDENCE_LEVELS,
	DOCUMENT_FIELDS,
	DOCUMENT_STATUSES,
	SIGNAL_METRICS,
	SIGNAL_STATUSES,
	SIGNAL_TYPES,
} from "../src/index.js";

describe("signal vocabulary", () => {
	it("tuples are stable", () => {
		expect([...SIGNAL_TYPES]).toEqual([
			"negative_balance",
			"revenue_concentration",
			"round_trip",
			"cash_deposit_share",
			"declared_vs_observed_cashflow",
			"returned_payment",
			"insufficient_data",
		]);
		expect([...SIGNAL_METRICS]).toEqual([
			"negative_eod_days",
			"top_inflow_share",
			"round_trip_pairs",
			"cash_inflow_share",
			"monthly_fcf_variance",
			"returned_count",
			"usable_rows",
		]);
		expect([...DOCUMENT_FIELDS]).toEqual([
			"company_name",
			"registration_number",
			"account_holder_name",
			"applicant_name",
			"other",
		]);
		expect([...SIGNAL_STATUSES]).toEqual(["review", "needs_chase", "insufficient_data"]);
		expect([...DOCUMENT_STATUSES]).toEqual(["mismatch", "needs_chase"]);
		expect([...CONFIDENCE_LEVELS]).toEqual(["low", "medium", "high"]);
	});
});
