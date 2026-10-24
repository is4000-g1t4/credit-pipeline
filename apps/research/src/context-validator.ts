// T18 context validator (SPEC-t17-t18 §3.4, D3b): pure, no I/O. The model
// selects among deterministic candidate snapshots — it never invents types
// or numbers. Each signal must match a snapshot on the full tuple
// (type, period, metric, observed, expected, accountScope); confidence may
// only be lowered, status/policyVersion must match, evidence ids must be
// tool-observed, and every model claim/explanation is data, never persisted:
// the persisted claims, summary, and signal explanations are composed
// server-side from the validated candidates (fixed neutral templates), so a
// contradictory or alleging narrative can never reach the officer. Model text
// still faces every check (forbidden, protected, decision, URL, numeric,
// contradiction, allegation); failures are recorded in `dropped` and the
// narrative is ignored.
import { z } from "zod";
import { SIGNAL_TYPES } from "@credit/core";
import { isUuid } from "./ids.js";
import { scanForbidden, scanProtected } from "./validator.js";
import type { CandidateSnapshot } from "./context-tools.js";

export const CONTEXT_VALIDATOR_VERSION = "context-v4";
export const CONTEXT_PROMPT_VERSION = "context-v5";

const signalTypeSchema = z.enum(SIGNAL_TYPES);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const URL_RE = /https?:\/\/|www\.[a-z0-9]/i;

/** Imperative/instruction smuggling in persisted model prose: an applicant
 * note or tool echo telling the reader to ignore, disregard, obey, or
 * comply. Matched against NFKC-normalized text with zero-width chars
 * stripped, so `ign\u200bore` and fullwidth homoglyphs still hit.
 * Conservative on purpose — ordinary factual gaps ("no document findings
 * were returned") carry none of these verbs and pass; bare "override"
 * without an instruction target ("no documented override") passes too. */
const INSTRUCTION_RE =
	/\b(ignore|disregard|obey|comply(?: with)?)\b.{0,60}\b(instructions?|prompts?|orders?|commands?|findings?|previous|above|system|verification)\b|previous instructions|system\s*:|you must\b|do not follow|\bprompt\s*injection\b|\boverride\b.{0,40}\b(instructions?|prompts?|findings?|verification|system|controls?|checks?)\b/i;

/** Zero-width/format chars interleaved to split keywords. Stripped after
 * NFKC (which folds fullwidth homoglyphs to ASCII) before matching. */
const ZW_RE = /[\u200B\u200C\u200D\uFEFF\u2060\u180E]/g;

function normalizeForScan(text: string): string {
	return text.normalize("NFKC").replace(ZW_RE, "");
}

export const contextModelOutputSchema = z
	.object({
		claims: z
			.array(
				z
					.object({
						text: z.string().min(1).max(1000),
						signalRefs: z.array(z.number().int().min(0)).max(20),
					})
					.strict(),
			)
			.max(20)
			.default([]),
		signals: z
			.array(
				z
					.object({
						type: signalTypeSchema,
						periodStart: z.string().min(1).max(30),
						periodEnd: z.string().min(1).max(30),
						metric: z.string().min(1).max(200),
						observed: z.number().nullable(),
						expected: z.number().nullable(),
						evidence: z
							.array(
								z
									.object({
										kind: z.enum(["transaction", "account", "metric", "finding"]),
										id: z.string().min(1).max(200),
										page: z.number().int().min(1).optional(),
									})
									.strict(),
							)
							.max(20),
						confidence: z.enum(["low", "medium", "high"]),
						status: z.enum(["review", "needs_chase", "insufficient_data"]),
						policyVersion: z.string().min(1).max(100),
						// Scope rides the candidate tuple: the model must echo
						// the candidate's scope verbatim (never invent one).
						accountScope: z.string().min(1).max(200),
						explanation: z.string().max(1000).default(""),
					})
					.strict(),
			)
			.max(20),
		dataGaps: z.array(z.string().min(1).max(500)).max(20).default([]),
		limitations: z.array(z.string().min(1).max(500)).max(20).default([]),
	})
	.strict();

export type ContextModelOutput = z.infer<typeof contextModelOutputSchema>;

export interface ValidatedContextSignal {
	index: number;
	candidateLocalId: string;
	type: string;
	periodStart: string;
	periodEnd: string;
	metric: string;
	observed: number | null;
	expected: number | null;
	evidence: Array<{ kind: string; id: string; page?: number }>;
	confidence: "low" | "medium" | "high";
	status: "review" | "needs_chase" | "insufficient_data";
	policyVersion: string;
	accountScope: string;
	explanation: string;
}

export interface ValidatedContextClaim {
	text: string;
	signalRefs: number[];
}

export interface ContextValidationResult {
	ok: boolean;
	signals: ValidatedContextSignal[];
	claims: ValidatedContextClaim[];
	dataGaps: string[];
	limitations: string[];
	summary: string;
	dropped: Array<{
		kind: "signal" | "claim" | "dataGap" | "limitation";
		index: number;
		reason: string;
	}>;
	/** Repair feedback for the single bounded repair pass. */
	issues: string[];
}

export interface ContextValidationInput {
	output: unknown;
	snapshots: CandidateSnapshot[];
	seenEvidence: Map<string, Set<string>>;
	/** YYYY-MM-DD observation end (the case as-of). */
	asOfDate: string;
	historyMonths: number;
}

// Claim text must share vocabulary with the cited candidate — an id alone
// is not support. Keywords per type plus the metric's own tokens; injection
// narratives ("ignore instructions", "approve this") match none and drop.
const TYPE_KEYWORDS: Record<string, string[]> = {
	negative_balance: ["negative", "balance", "overdraft", "below zero", "shortfall", "eod"],
	revenue_concentration: [
		"concentrat",
		"counterparty",
		"inflow",
		"revenue",
		"dependence",
		"single customer",
		"share",
	],
	round_trip: [
		"round",
		"circular",
		"in and out",
		"in/out",
		"paired",
		"back-and-forth",
		"pass-through",
		"passthrough",
	],
	cash_deposit_share: ["cash", "deposit"],
	declared_vs_observed_cashflow: [
		"declar",
		"observ",
		"variance",
		"cashflow",
		"cash flow",
		"fcf",
		"forecast",
	],
	returned_payment: [
		"return",
		"nsf",
		"bounc",
		"dishonour",
		"dishonor",
		"insufficient funds",
		"failed payment",
	],
	insufficient_data: [
		"insufficient",
		"no data",
		"missing",
		"gap",
		"unavailable",
		"too little",
		"sparse",
	],
};

const CONF_RANK = { low: 0, medium: 1, high: 2 } as const;

function strictDay(v: string): boolean {
	if (!DAY_RE.test(v)) return false;
	const [y, m, d] = v.split("-").map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d));
	return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Mirror of the applications contextWindow: calendar-month subtraction. */
function windowStart(asOfDate: string, historyMonths: number): string {
	const [y, m, d] = asOfDate.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1 - historyMonths, d)).toISOString().slice(0, 10);
}

function scanText(text: string): string | null {
	if (scanForbidden(text).length > 0) return "decision/graded language";
	if (scanProtected(text).length > 0) return "protected attribute";
	if (URL_RE.test(text)) return "external URL";
	if (INSTRUCTION_RE.test(normalizeForScan(text))) return "instruction";
	return null;
}

function semanticallySupported(claim: string, signal: ValidatedContextSignal): boolean {
	const hay = claim.toLowerCase();
	const words = [
		...(TYPE_KEYWORDS[signal.type] ?? []),
		...signal.metric
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((w) => w.length >= 3),
	];
	return words.some((w) => hay.includes(w));
}

/** Crime-allegation language: never a server-composed word; a model claim
 * carrying it is rejected, never persisted. */
const ALLEGATION_RE =
	/\b(launder\w*|fraud\w*|embezzl\w*|illicit|bribe\w*|kickbacks?|ponzi|terror\w*)\b/i;

/** Negation tokens for the contradiction check below. */
const NEGATION_RE = /\b(no|never|none|without|zero|not|neither|nor)\b|n't\b/i;

/** Numeric tokens in free text (`1,000`, `3.5`, `40%`, `-5000`). */
const NUM_TOKEN_RE = /-?\d[\d,]*(?:\.\d+)?%?/g;

function normalizeNumToken(raw: string): string {
	return raw.replace(/,/g, "").replace(/%$/, "");
}

/** Every number-like token in model text. */
function numericTokens(text: string): string[] {
	return (text.match(NUM_TOKEN_RE) ?? []).map(normalizeNumToken);
}

/** Number-like tokens the candidate itself attests: observed/expected plus
 * the metric/period vocabulary. Anything else is fabricated. */
function candidateNumbers(signal: ValidatedContextSignal): Set<string> {
	const allowed = new Set<string>();
	if (signal.observed !== null) allowed.add(normalizeNumToken(String(signal.observed)));
	if (signal.expected !== null) allowed.add(normalizeNumToken(String(signal.expected)));
	for (const field of [signal.metric, signal.periodStart, signal.periodEnd]) {
		for (const tok of numericTokens(field)) allowed.add(tok);
	}
	return allowed;
}

/** True when every numeric token in `text` is attested by at least one of
 * the cited signals — fabricated figures (injected company names,
 * financials, or invented amounts) fail. */
function numbersAttested(text: string, cited: ValidatedContextSignal[]): boolean {
	const tokens = numericTokens(text);
	if (tokens.length === 0) return true;
	const allowed = new Set<string>();
	for (const s of cited) {
		for (const tok of candidateNumbers(s)) allowed.add(tok);
	}
	return tokens.every((t) => allowed.has(t));
}

/** A model narrative that shares the signal's vocabulary yet negates it
 * ("no negative balances" against observed 3) contradicts the candidate. */
function contradictsSignal(claim: string, signal: ValidatedContextSignal): boolean {
	if (signal.observed === null || signal.observed === 0) return false;
	return NEGATION_RE.test(claim) && semanticallySupported(claim, signal);
}

/** Neutral server-composed claim for one validated signal: candidate
 * numbers/period/metric only, no model words. */
function composeClaimText(s: {
	type: string;
	metric: string;
	observed: number | null;
	expected: number | null;
	periodStart: string;
	periodEnd: string;
}): string {
	const range = `${s.periodStart} to ${s.periodEnd}`;
	const obs = s.observed === null ? "no observed value" : String(s.observed);
	const exp = s.expected === null ? "no expected value" : String(s.expected);
	switch (s.type) {
		case "negative_balance":
			return `Observed ${obs} end-of-day negative balances (${s.metric}) over ${range}; expected ${exp}.`;
		case "revenue_concentration":
			return `Observed top-counterparty inflow share ${obs} (${s.metric}) over ${range}; expected ${exp}.`;
		case "round_trip":
			return `Observed ${obs} paired round-trip transfers (${s.metric}) over ${range}; expected ${exp}.`;
		case "cash_deposit_share":
			return `Observed cash inflow share ${obs} (${s.metric}) over ${range}; expected ${exp}.`;
		case "declared_vs_observed_cashflow":
			return `Observed monthly cash flow ${obs} against declared ${exp} (${s.metric}) over ${range}.`;
		case "returned_payment":
			return `Observed ${obs} returned payments (${s.metric}) over ${range}; expected ${exp}.`;
		case "insufficient_data":
			return `Insufficient data for ${s.metric} over ${range}: observed ${obs} against expected ${exp}.`;
		default:
			return `Observed ${s.metric} of ${obs} against expected ${exp} over ${range} (${s.type}).`;
	}
}

/** Neutral server-composed signal explanation: the candidate tuple in
 * words, never model narrative. */
function composeExplanation(s: {
	type: string;
	metric: string;
	observed: number | null;
	expected: number | null;
	periodStart: string;
	periodEnd: string;
	confidence: string;
	status: string;
}): string {
	const obs = s.observed === null ? "no observed value" : String(s.observed);
	const exp = s.expected === null ? "no expected value" : String(s.expected);
	return (
		`Candidate ${s.type} (${s.metric}): observed ${obs}, expected ${exp}, ` +
		`period ${s.periodStart} to ${s.periodEnd}, confidence ${s.confidence}, status ${s.status}.`
	);
}

export function validateContextOutput(input: ContextValidationInput): ContextValidationResult {
	const dropped: ContextValidationResult["dropped"] = [];
	const issues: string[] = [];
	// No candidates observed (thin/no data): succeed explicitly with empty
	// signals/claims rather than failing the stage — the officer UI renders
	// the "no signals met the evidence bar" branch, never an all-clear.
	if (input.snapshots.length === 0) {
		return {
			ok: true,
			signals: [],
			claims: [],
			dataGaps: [],
			limitations: [],
			summary: "No signals met the evidence bar for this period.",
			dropped,
			issues,
		};
	}
	const parsed = contextModelOutputSchema.safeParse(input.output);
	if (!parsed.success) {
		return {
			ok: false,
			signals: [],
			claims: [],
			dataGaps: [],
			limitations: [],
			summary: "No supported context signals remained after validation.",
			dropped,
			issues: ["model output failed schema validation"],
		};
	}
	const output = parsed.data;
	const from = strictDay(input.asOfDate) ? windowStart(input.asOfDate, input.historyMonths) : null;

	const signals: ValidatedContextSignal[] = [];
	const validIndex = new Set<number>();
	// Coverage: every deterministic candidate must be accounted for. A
	// dropped or omitted candidate is a silent officer blind spot, so it
	// fails validation and drives repair instead of disappearing.
	const coveredCandidates = new Set<string>();
	for (const [i, s] of output.signals.entries()) {
		const drop = (reason: string): void => {
			dropped.push({ kind: "signal", index: i, reason });
		};
		if (
			!strictDay(s.periodStart) ||
			!strictDay(s.periodEnd) ||
			s.periodStart > s.periodEnd ||
			(from !== null && (s.periodStart < from || s.periodEnd > input.asOfDate))
		) {
			drop("period outside the observation window");
			continue;
		}
		const candidate = input.snapshots.find(
			(c) =>
				c.type === s.type &&
				c.periodStart === s.periodStart &&
				c.periodEnd === s.periodEnd &&
				c.metric === s.metric &&
				c.observed === s.observed &&
				c.expected === s.expected &&
				c.accountScope === s.accountScope,
		);
		if (!candidate) {
			drop("no matching candidate signal (type/period/metric/observed/expected/accountScope)");
			continue;
		}
		// No cross-candidate mixing: the tuple match above already binds one
		// snapshot; scope rides the same tuple. A candidate may be reported
		// once only.
		if (coveredCandidates.has(candidate.localId)) {
			drop("candidate already reported");
			continue;
		}
		if (candidate.accountScope !== "all" && !isUuid(candidate.accountScope)) {
			drop("candidate scope is not an account");
			continue;
		}
		if (CONF_RANK[s.confidence] > CONF_RANK[candidate.confidence]) {
			drop("confidence raised above the candidate baseline");
			continue;
		}
		if (s.status !== candidate.status) {
			drop("status differs from the candidate status");
			continue;
		}
		if (!s.policyVersion || s.policyVersion !== candidate.policyVersion) {
			drop("policy version mismatch");
			continue;
		}
		// Evidence is server-composed: non-insufficient signals persist the
		// candidate's exact evidence ids regardless of the model's subset.
		// Every supplied id must belong to this candidate and be
		// tool-observed — a seen-but-foreign transaction is rejected.
		// `insufficient_data` carries no evidence.
		if (s.status === "insufficient_data") {
			if (s.evidence.length > 0) {
				drop("insufficient_data carries no evidence");
				continue;
			}
		} else {
			const foreign = s.evidence.find((e) => !candidate.evidenceIds.includes(e.id));
			if (foreign) {
				drop(`evidence id is not from this candidate: ${foreign.kind}`);
				continue;
			}
			const badEvidence = s.evidence.find((e) => !input.seenEvidence.get(e.id)?.has(e.kind));
			if (badEvidence) {
				drop(`unknown evidence id: ${badEvidence.kind}`);
				continue;
			}
		}
		const evidence: Array<{
			kind: "transaction" | "account" | "metric" | "finding";
			id: string;
			page?: number;
		}> =
			s.status === "insufficient_data"
				? []
				: candidate.evidenceIds.map((id) => ({ kind: "transaction" as const, id }));
		// Every non-insufficient signal must carry tool-observed evidence;
		// `insufficient_data` is the service's no-data marker and carries none.
		if (s.status !== "insufficient_data" && evidence.length === 0) {
			drop("signal cites no evidence");
			continue;
		}
		// Model explanation text is never persisted. The signal is validated
		// on its deterministic tuple, evidence, confidence, status, and policy;
		// server-composed explanation text is added below.
		signals.push({
			index: i,
			candidateLocalId: candidate.localId,
			type: s.type,
			periodStart: s.periodStart,
			periodEnd: s.periodEnd,
			metric: s.metric,
			observed: s.observed,
			expected: s.expected,
			evidence: evidence.map((e) => ({
				kind: e.kind,
				id: e.id,
				...(e.page ? { page: e.page } : {}),
			})),
			confidence: s.confidence,
			status: s.status,
			policyVersion: s.policyVersion,
			accountScope: candidate.accountScope,
			// Server-composed: the model explanation is data for the gates
			// above, never persisted.
			explanation: composeExplanation({
				type: s.type,
				metric: s.metric,
				observed: s.observed,
				expected: s.expected,
				periodStart: s.periodStart,
				periodEnd: s.periodEnd,
				confidence: s.confidence,
				status: s.status,
			}),
		});
		coveredCandidates.add(candidate.localId);
		validIndex.add(i);
	}

	const missingCandidates = input.snapshots.filter((c) => !coveredCandidates.has(c.localId));
	for (const missing of missingCandidates) {
		issues.push(`missing candidate ${missing.localId} (${missing.type}/${missing.metric})`);
	}

	// Model narrative is data, never persisted: every model claim faces the
	// full check set (failures land in `dropped` and are ignored), while the
	// persisted claims are composed server-side below — one per validated
	// signal. The model selects/prioritizes candidates and lowers confidence
	// only; it never authors officer-facing words.
	for (const [i, c] of output.claims.entries()) {
		const drop = (reason: string): void => {
			dropped.push({ kind: "claim", index: i, reason });
		};
		const refs = c.signalRefs.filter((r) => validIndex.has(r));
		if (refs.length === 0) {
			drop("claim references no validated signal");
			continue;
		}
		const dirty = scanText(c.text);
		if (dirty) {
			drop(`claim carries ${dirty}`);
			continue;
		}
		const cited = signals.filter((s) => refs.includes(s.index));
		if (ALLEGATION_RE.test(c.text)) {
			drop("claim alleges financial crime");
			continue;
		}
		if (!cited.some((s) => semanticallySupported(c.text, s))) {
			drop("claim text is not supported by the referenced signal");
			continue;
		}
		if (cited.some((s) => contradictsSignal(c.text, s))) {
			drop("claim contradicts the cited signal");
			continue;
		}
		// No fabricated figures: every numeric token in the claim must be
		// attested by a cited candidate (observed/expected/metric/period).
		// Injected company names/financials smuggling amounts fail here.
		if (!numbersAttested(c.text, cited)) {
			drop("claim cites a number no cited signal attests");
			continue;
		}
		// Supported model narrative is acknowledged and ignored: the
		// persisted claim is the server composition below.
	}
	const claims: ValidatedContextClaim[] = signals.map((s) => ({
		text: composeClaimText(s),
		signalRefs: [s.index],
	}));

	const keepList = (items: string[], kind: "dataGap" | "limitation"): string[] => {
		const kept: string[] = [];
		items.forEach((text, i) => {
			const drop = (reason: string): void => {
				dropped.push({ kind, index: i, reason });
			};
			const dirty = scanText(text);
			if (dirty) return drop(`${kind} carries ${dirty}`);
			if (ALLEGATION_RE.test(text)) return drop(`${kind} alleges financial crime`);
			// Gaps/limitations are persisted model prose, so the same
			// numeric-attestation bar as claims applies: no invented figures.
			if (!numbersAttested(text, signals)) return drop(`${kind} cites an unattested number`);
			kept.push(text);
		});
		return kept;
	};
	const dataGaps = keepList(output.dataGaps, "dataGap");
	const limitations = keepList(output.limitations, "limitation");

	const summary =
		claims.length > 0
			? claims
					.map((c) => c.text)
					.join(" ")
					.slice(0, 2000)
			: "No supported context signals remained after validation.";

	if (signals.length === 0) issues.push("no signal matched a candidate");
	if (claims.length === 0) issues.push("no claim composed from validated signals");
	const ok =
		parsed.success && signals.length > 0 && claims.length > 0 && missingCandidates.length === 0;
	return { ok, signals, claims, dataGaps, limitations, summary, dropped, issues };
}
