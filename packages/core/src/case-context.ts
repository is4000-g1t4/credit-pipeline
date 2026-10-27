import { z } from "zod";
import {
	DOCUMENT_FIELDS,
	DOCUMENT_STATUSES,
	SIGNAL_METRICS,
	SIGNAL_TYPES,
	type SignalMetric,
	type SignalType,
} from "./signals.js";

/** T18 signal vocabulary. The tuples live in @credit/core (single source of
 * truth, shared with research context-validator and applications metrics);
 * the POLICY_* names stay for existing importers. */
export const POLICY_SIGNAL_TYPES = SIGNAL_TYPES;

export const POLICY_SIGNAL_METRICS = SIGNAL_METRICS;

export const POLICY_DOCUMENT_FIELDS = DOCUMENT_FIELDS;

export const POLICY_DOCUMENT_STATUSES = DOCUMENT_STATUSES;

export type PolicySignalType = SignalType;
export type PolicySignalMetric = SignalMetric;

const signalType = z.enum(POLICY_SIGNAL_TYPES);
const signalMetric = z.enum(POLICY_SIGNAL_METRICS);
const confidence = z.enum(["low", "medium", "high"]);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");
const accountScope = z.string().regex(/^(aggregate|account_[1-9][0-9]?)$/, "invalid account scope");

const signalSchema = z
	.object({
		ref: z.string().min(1).max(300),
		type: signalType,
		metric: signalMetric,
		periodStart: date,
		periodEnd: date,
		accountScope,
		status: z.enum(["review", "needs_chase", "insufficient_data"]),
		confidence,
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.periodStart > value.periodEnd) {
			ctx.addIssue({ code: "custom", message: "periodStart must be <= periodEnd" });
		}
		const expected = signalRef(value);
		if (value.ref !== expected) {
			ctx.addIssue({ code: "custom", message: "signal ref does not match its tuple" });
		}
		if (!isMetricPairAllowed(value.type, value.metric)) {
			ctx.addIssue({ code: "custom", message: "metric does not belong to the signal type" });
		}
	});

const documentFindingSchema = z
	.object({
		field: z.enum(POLICY_DOCUMENT_FIELDS),
		status: z.enum(POLICY_DOCUMENT_STATUSES),
		confidence,
		index: z.number().int().min(0).max(99),
	})
	.strict();

export const policyCaseContextSchema = z
	.object({
		applicationId: z.uuid(),
		runId: z.uuid(),
		authorisingActorId: z.uuid(),
		authorisingActorRole: z.enum(["officer", "service"]),
		asOf: date,
		type: z.enum(["individual", "sme"]),
		product: z.enum(["personal_loan", "sme_term_loan"]),
		amountBand: z.enum(["lt_10k", "10k_50k", "50k_250k", "gte_250k"]),
		termBand: z.enum(["lt_12m", "12_36m", "36_60m", "gte_60m"]),
		signals: z.array(signalSchema).max(50),
		documentFindings: z.array(documentFindingSchema).max(50),
	})
	.strict();

export type PolicyCaseContext = z.infer<typeof policyCaseContextSchema>;
export type PolicyCaseSignal = PolicyCaseContext["signals"][number];

export function signalRef(input: {
	type: string;
	metric: string;
	periodStart: string;
	periodEnd: string;
	accountScope: string;
}): string {
	return `signal:${input.type}:${input.metric}:${input.periodStart}:${input.periodEnd}:${input.accountScope}`;
}

export function documentRef(input: { field: string; index: number }): string {
	return `document:${input.field}:${input.index}`;
}

export function isMetricPairAllowed(type: PolicySignalType, metric: PolicySignalMetric): boolean {
	const allowed: Record<PolicySignalType, PolicySignalMetric> = {
		negative_balance: "negative_eod_days",
		revenue_concentration: "top_inflow_share",
		round_trip: "round_trip_pairs",
		cash_deposit_share: "cash_inflow_share",
		declared_vs_observed_cashflow: "monthly_fcf_variance",
		returned_payment: "returned_count",
		insufficient_data: "usable_rows",
	};
	return allowed[type] === metric;
}
