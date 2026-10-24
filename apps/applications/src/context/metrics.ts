import type {
	ConfidenceLevel,
	SignalStatus as CoreSignalStatus,
	SignalType as CoreSignalType,
} from "@credit/core";

// T18 deterministic candidate signals, v1 (SPEC-t17-t18 §3.3, D3a).
//
// Pure: no DB, no I/O, no clock — the internal route injects the clamped
// window, the owned-account rows, and the declared financials. Candidates
// carry type/period/metric/observed/expected, a baseline confidence/status,
// policy version, account scope, and evidence IDs only: no free text,
// descriptions, counterparties, or PII. The D3b LLM agent may select,
// combine, and lower confidence, but never invents types or numbers.
export const CONTEXT_METRICS_POLICY_VERSION = "context-metrics-v1";

/** Hard row cap for one metrics call (routes additionally cap accounts). */
export const CONTEXT_METRICS_ROW_CAP = 10_000;

/** Evidence ID cap per candidate: bounded tool output for the D3b agent. */
export const CONTEXT_SIGNAL_EVIDENCE_CAP = 20;

/** T18 vocabulary lives in @credit/core; these aliases stay for importers. */
export type SignalType = CoreSignalType;
export type SignalConfidence = ConfidenceLevel;
export type SignalStatus = CoreSignalStatus;

export interface ContextThresholds {
	historyMonths: number;
	negativeBalanceDays: number;
	revenueConcentrationPct: number;
	cashDepositSharePct: number;
	fcfVariancePct: number;
}

export interface MetricTx {
	id: string;
	accountId: string;
	postedAt: Date;
	amountCents: number;
	balanceAfterCents: number;
	counterparty: string | null;
	category: string;
	returned: boolean;
}

export interface CandidateSignal {
	type: SignalType;
	periodStart: string;
	periodEnd: string;
	metric: string;
	observed: number | null;
	expected: number | null;
	confidence: SignalConfidence;
	status: SignalStatus;
	policyVersion: string;
	accountScope: string;
	evidence: Array<{ kind: "transaction" | "account"; id: string }>;
}

export interface SignalInput {
	transactions: MetricTx[];
	window: { from: Date; to: Date };
	/** Declared monthly FCF in cents (SME `business.monthlyFcfCents`); null skips the FCF signal. */
	declaredMonthlyFcfCents: number | null;
	/** Owned account IDs in scope (1 → that id, otherwise `all`). */
	scopeAccountIds: string[];
	thresholds: ContextThresholds;
}

const DAY_MS = 86_400_000;

function isoDay(d: Date): string {
	return d.toISOString().slice(0, 10);
}

function round4(n: number): number {
	return Math.round(n * 10_000) / 10_000;
}

function base(
	input: SignalInput,
	scope: string,
): Pick<CandidateSignal, "periodStart" | "periodEnd" | "policyVersion" | "accountScope"> {
	return {
		periodStart: isoDay(input.window.from),
		periodEnd: isoDay(input.window.to),
		policyVersion: CONTEXT_METRICS_POLICY_VERSION,
		accountScope: scope,
	};
}

function txEvidence(ids: string[]): CandidateSignal["evidence"] {
	return ids
		.slice(0, CONTEXT_SIGNAL_EVIDENCE_CAP)
		.map((id) => ({ kind: "transaction" as const, id }));
}

/** End-of-day rows: the last transaction per account per UTC day. */
function endOfDayRows(txs: MetricTx[]): MetricTx[] {
	const last = new Map<string, MetricTx>();
	for (const tx of txs) {
		last.set(`${tx.accountId}|${isoDay(tx.postedAt)}`, tx);
	}
	return [...last.values()];
}

function negativeBalance(input: SignalInput, scope: string): CandidateSignal | null {
	const days = endOfDayRows(input.transactions).filter((tx) => tx.balanceAfterCents < 0);
	if (days.length < input.thresholds.negativeBalanceDays) return null;
	return {
		...base(input, scope),
		type: "negative_balance",
		metric: "negative_eod_days",
		observed: days.length,
		expected: 0,
		confidence: "high",
		status: "review",
		evidence: txEvidence(days.map((d) => d.id)),
	};
}

function revenueConcentration(input: SignalInput, scope: string): CandidateSignal | null {
	const inflows = input.transactions.filter((tx) => tx.amountCents > 0);
	if (inflows.length === 0) return null;
	// The ≥3-month rule is data-driven: distinct inflow calendar months.
	const months = new Set(inflows.map((tx) => tx.postedAt.toISOString().slice(0, 7)));
	if (months.size < 3) return null;
	const total = inflows.reduce((a, tx) => a + tx.amountCents, 0);
	if (total <= 0) return null;
	const byCounterparty = new Map<string, { sum: number; ids: string[] }>();
	for (const tx of inflows) {
		const key = (tx.counterparty ?? "").trim().toLowerCase();
		if (key === "") continue;
		const group = byCounterparty.get(key) ?? { sum: 0, ids: [] };
		group.sum += tx.amountCents;
		group.ids.push(tx.id);
		byCounterparty.set(key, group);
	}
	let top: { sum: number; ids: string[] } | null = null;
	for (const group of byCounterparty.values()) {
		if (!top || group.sum > top.sum) top = group;
	}
	if (!top) return null;
	const share = top.sum / total;
	if (share < input.thresholds.revenueConcentrationPct / 100) return null;
	return {
		...base(input, scope),
		type: "revenue_concentration",
		metric: "top_inflow_share",
		observed: round4(share),
		expected: input.thresholds.revenueConcentrationPct / 100,
		confidence: "medium",
		status: "review",
		evidence: txEvidence(top.ids),
	};
}

function roundTrip(input: SignalInput, scope: string): CandidateSignal | null {
	// Same |amount| in and out within 3 days, at least twice. Greedy oldest-
	// first pairing per account+amount; matched rows pair at most once.
	const pairs: string[] = [];
	const byKey = new Map<string, MetricTx[]>();
	for (const tx of input.transactions) {
		if (tx.amountCents === 0) continue;
		const key = `${tx.accountId}|${Math.abs(tx.amountCents)}`;
		const list = byKey.get(key) ?? [];
		list.push(tx);
		byKey.set(key, list);
	}
	for (const list of byKey.values()) {
		const ordered = [...list].sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime());
		const used = new Set<string>();
		for (let i = 0; i < ordered.length; i++) {
			const first = ordered[i] as MetricTx;
			if (used.has(first.id)) continue;
			for (let j = i + 1; j < ordered.length; j++) {
				const second = ordered[j] as MetricTx;
				if (used.has(second.id)) continue;
				if (Math.sign(first.amountCents) === Math.sign(second.amountCents)) continue;
				if (second.postedAt.getTime() - first.postedAt.getTime() > 3 * DAY_MS) break;
				used.add(first.id);
				used.add(second.id);
				pairs.push(first.id, second.id);
				break;
			}
		}
	}
	if (pairs.length / 2 < 2) return null;
	return {
		...base(input, scope),
		type: "round_trip",
		metric: "round_trip_pairs",
		observed: pairs.length / 2,
		expected: 0,
		confidence: "medium",
		status: "review",
		evidence: txEvidence(pairs),
	};
}

function cashDepositShare(input: SignalInput, scope: string): CandidateSignal | null {
	const inflows = input.transactions.filter((tx) => tx.amountCents > 0);
	const total = inflows.reduce((a, tx) => a + tx.amountCents, 0);
	if (total <= 0) return null;
	const cash = inflows.filter((tx) => tx.category === "cash");
	const cashSum = cash.reduce((a, tx) => a + tx.amountCents, 0);
	const share = cashSum / total;
	if (share < input.thresholds.cashDepositSharePct / 100) return null;
	return {
		...base(input, scope),
		type: "cash_deposit_share",
		metric: "cash_inflow_share",
		observed: round4(share),
		expected: input.thresholds.cashDepositSharePct / 100,
		confidence: "medium",
		status: "review",
		evidence: txEvidence(cash.map((tx) => tx.id)),
	};
}

function declaredVsObserved(input: SignalInput, scope: string): CandidateSignal | null {
	const declared = input.declaredMonthlyFcfCents;
	if (declared === null) return null;
	const spanDays = (input.window.to.getTime() - input.window.from.getTime()) / DAY_MS;
	const months = Math.max(spanDays / 30, 1);
	const net = input.transactions.reduce((a, tx) => a + tx.amountCents, 0);
	const observed = Math.round(net / months);
	// Variance is derived from the window's transactions: cite them (capped)
	// so the D3b evidence bar (`insufficient_data` aside, every signal cites
	// tool-observed evidence) is satisfiable for this candidate.
	const evidence = txEvidence(input.transactions.map((tx) => tx.id));
	if (declared === 0) {
		if (observed === 0) return null;
		return {
			...base(input, scope),
			type: "declared_vs_observed_cashflow",
			metric: "monthly_fcf_variance",
			observed,
			expected: 0,
			confidence: "low",
			status: "review",
			evidence,
		};
	}
	const variance = Math.abs(declared - observed) / Math.abs(declared);
	if (variance < input.thresholds.fcfVariancePct / 100) return null;
	return {
		...base(input, scope),
		type: "declared_vs_observed_cashflow",
		metric: "monthly_fcf_variance",
		observed,
		expected: declared,
		confidence: "low",
		status: "review",
		evidence,
	};
}

function returnedPayment(input: SignalInput, scope: string): CandidateSignal | null {
	const hits = input.transactions.filter((tx) => tx.returned || tx.category === "returned_payment");
	if (hits.length === 0) return null;
	return {
		...base(input, scope),
		type: "returned_payment",
		metric: "returned_count",
		observed: hits.length,
		expected: 0,
		confidence: "high",
		status: "review",
		evidence: txEvidence(hits.map((tx) => tx.id)),
	};
}

/** Deterministic v1 candidates in fixed type order. Empty input yields a
 * single `insufficient_data` candidate — never a fabricated anomaly. */
export function computeCandidateSignals(input: SignalInput): CandidateSignal[] {
	const scope = input.scopeAccountIds.length === 1 ? (input.scopeAccountIds[0] as string) : "all";
	const inWindow = input.transactions.filter(
		(tx) =>
			tx.postedAt.getTime() >= input.window.from.getTime() &&
			tx.postedAt.getTime() <= input.window.to.getTime(),
	);
	if (inWindow.length === 0) {
		return [
			{
				...base(input, scope),
				type: "insufficient_data",
				metric: "usable_rows",
				observed: 0,
				expected: 1,
				confidence: "low",
				status: "insufficient_data",
				evidence: [],
			},
		];
	}
	const scoped = { ...input, transactions: inWindow };
	const out: Array<CandidateSignal | null> = [
		negativeBalance(scoped, scope),
		revenueConcentration(scoped, scope),
		roundTrip(scoped, scope),
		cashDepositShare(scoped, scope),
		declaredVsObserved(scoped, scope),
		returnedPayment(scoped, scope),
	];
	return out.filter((s): s is CandidateSignal => s !== null);
}

/** Observation window ending at the application's as-of (submittedAt):
 * calendar-month subtraction, deterministic for a fixed as-of. */
export function contextWindow(asOf: Date, historyMonths: number): { from: Date; to: Date } {
	const from = new Date(
		Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - historyMonths, asOf.getUTCDate()),
	);
	return { from, to: new Date(asOf.getTime()) };
}
