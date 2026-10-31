// US-INT-1/2 deterministic candidate validation (pure).
//
// The model proposes values and exact quotes; this module verifies the quote
// by code-point offset, applies format/date/amount rules, and confirms
// cross-document pairs with the existing crosscheck comparators. Amount and
// period confirmation is label-aware and currency-aware; ambiguous pairs stay
// candidates. Explanations are server-composed from the exact quotes, never
// model prose.

import type {
	IntegrityCandidateField,
	IntegrityConsistencyField,
	IntegrityConsistencyProposal,
	IntegritySeverity,
	ValidatedConsistency,
} from "../../integrity/types.js";
import {
	codePointSlice,
	compareNames,
	compareRegistration,
	normalizeNameTokens,
	normalizeRegistration,
} from "../../documents/crosscheck.js";
import { sha256Hex } from "../../documents/crypto.js";

const MAX_QUOTE = 1_000;

export interface VerifiedQuote {
	offsetStart: number;
	offsetEnd: number;
	quoteHash: string;
}

/** Exact quote → code-point offsets. Whitespace is not normalized: a citation
 * must be character-for-character, matching the crosscheck convention. */
export function verifyQuote(pageText: string, quote: string): VerifiedQuote | null {
	const trimmed = quote.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_QUOTE) return null;
	const haystack = [...pageText];
	const needle = [...trimmed];
	if (needle.length > haystack.length) return null;
	for (let start = 0; start <= haystack.length - needle.length; start++) {
		let hit = true;
		for (let i = 0; i < needle.length; i++) {
			if (haystack[start + i] !== needle[i]) {
				hit = false;
				break;
			}
		}
		if (hit) {
			return {
				offsetStart: start,
				offsetEnd: start + needle.length,
				quoteHash: sha256Hex(Buffer.from(trimmed, "utf8")),
			};
		}
	}
	return null;
}

export function quoteMatchesOffset(
	pageText: string,
	offsetStart: number,
	offsetEnd: number,
	quote: string,
): boolean {
	if (offsetStart < 0 || offsetEnd <= offsetStart) return false;
	return codePointSlice(pageText, offsetStart, offsetEnd) === quote;
}

const KIND_LABELS: Record<string, string[]> = {
	id: ["identity card", "identity document", "national id", "nric", "passport", "id card"],
	business_registration: [
		"business registration",
		"business profile",
		"acra",
		"company registration",
		"certificate of incorporation",
	],
	bank_statement: ["bank statement", "account statement", "statement of account"],
	payslip: ["payslip", "pay slip", "salary slip", "pay statement"],
	financial_statements: [
		"financial statement",
		"balance sheet",
		"profit and loss",
		"income statement",
	],
	other: [],
};

function normalizedText(value: string): string {
	return value
		.normalize("NFKC")
		.toLowerCase()
		.replaceAll(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

function kindValue(value: string): string | null {
	const key = normalizedText(value).replaceAll(" ", "_");
	if (key in KIND_LABELS) return key;
	const byLabel = Object.entries(KIND_LABELS).find(([, labels]) =>
		labels.some((label) => normalizedText(label) === normalizedText(value)),
	);
	return byLabel?.[0] ?? null;
}

function makeUtcDate(
	year: number,
	month: number,
	day: number,
	hours = 0,
	minutes = 0,
	seconds = 0,
): Date | null {
	const date = new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds));
	if (
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month - 1 ||
		date.getUTCDate() !== day ||
		date.getUTCHours() !== hours ||
		date.getUTCMinutes() !== minutes ||
		date.getUTCSeconds() !== seconds
	) {
		return null;
	}
	return date;
}

export function parseDateValue(value: string): Date | null {
	const text = value.trim();
	const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
	if (iso) {
		return makeUtcDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
	}
	const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
	if (dmy) {
		return makeUtcDate(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));
	}
	const monthNames: Record<string, number> = {
		jan: 0,
		january: 0,
		feb: 1,
		february: 1,
		mar: 2,
		march: 2,
		apr: 3,
		april: 3,
		may: 4,
		jun: 5,
		june: 5,
		jul: 6,
		july: 6,
		aug: 7,
		august: 7,
		sep: 8,
		sept: 8,
		september: 8,
		oct: 9,
		october: 9,
		nov: 10,
		november: 10,
		dec: 11,
		december: 11,
	};
	const dMonY = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/.exec(text);
	if (dMonY) {
		const month = monthNames[dMonY[2]!.toLowerCase()];
		if (month === undefined) return null;
		return makeUtcDate(Number(dMonY[3]), month + 1, Number(dMonY[1]));
	}
	const monDY = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
	if (monDY) {
		const month = monthNames[monDY[1]!.toLowerCase()];
		if (month === undefined) return null;
		return makeUtcDate(Number(monDY[3]), month + 1, Number(monDY[2]));
	}
	return null;
}

export function parsePeriod(value: string): { start: Date; end: Date } | null {
	const parts = value.split(/\s+(?:to|until|through|–|-)\s+/i);
	if (parts.length !== 2) return null;
	const start = parseDateValue(parts[0] ?? "");
	const end = parseDateValue(parts[1] ?? "");
	if (!start || !end) return null;
	return start.getTime() <= end.getTime() ? { start, end } : null;
}

const CURRENCY_RE = /\b(SGD|USD|MYR|HKD|EUR|GBP|AUD|JPY|CNY)\b|S\$|\$|€|£|¥/i;

export function parseAmountValue(value: string): number | null {
	const cleaned = value.replaceAll(/[,\s]/g, "");
	const match = /-?\d+(?:\.\d{1,2})?/.exec(cleaned);
	if (!match) return null;
	const amount = Number(match[0]);
	return Number.isFinite(amount) ? amount : null;
}

export function extractCurrency(value: string): string | null {
	const match = CURRENCY_RE.exec(value);
	if (!match) return null;
	const token = (match[1] ?? match[0]).toUpperCase();
	return token === "S$" ? "SGD" : token === "$" ? "USD" : token;
}

export function normalizeLabel(value: string): string {
	return normalizedText(value)
		.replace(/\b(?:the|a|an|of|on|as|at|for|per|this|that)\b/g, " ")
		.replaceAll(/\s+/g, " ")
		.trim();
}

function normalizedAlnum(value: string): string {
	return value
		.normalize("NFKC")
		.toUpperCase()
		.replaceAll(/[^A-Z0-9]/g, "");
}

function onlyDigits(value: string): string {
	return value.replaceAll(/\D/g, "");
}

/** Dates may be written differently in the label and the quote (ISO vs
 * "1 May 2026"); compare parsed calendar days, not raw text. */
function quoteContainsDate(quote: string, date: Date): boolean {
	const tokens =
		quote.match(
			/\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})\b/g,
		) ?? [];
	return tokens.some((token) => {
		const parsed = parseDateValue(token);
		return parsed !== null && parsed.getTime() === date.getTime();
	});
}

function quoteContainsAmount(quote: string, amount: number): boolean {
	const tokens = quote.match(/-?\d[\d,]*(?:\.\d{1,2})?/g) ?? [];
	return tokens.some((token) => {
		const parsed = Number(token.replaceAll(",", ""));
		return Number.isFinite(parsed) && Math.abs(parsed - amount) < 0.005;
	});
}

function quoteContainsText(quote: string, value: string): boolean {
	return normalizedText(quote).includes(normalizedText(value));
}

function datesMatch(a: Date, b: Date): boolean {
	return a.getTime() === b.getTime();
}

export function normalizeCandidateValue(field: IntegrityCandidateField, value: string): string {
	if (field === "document_type") return kindValue(value) ?? normalizedText(value);
	if (
		field === "document_date" ||
		field === "statement_period_start" ||
		field === "statement_period_end"
	) {
		const date = parseDateValue(value);
		return date ? date.toISOString().slice(0, 10) : normalizedText(value);
	}
	if (field === "registration_number") return normalizeRegistration(value);
	if (field === "account_number") return value.replaceAll(/\D/g, "");
	if (field === "material_amount") {
		const amount = parseAmountValue(value);
		const currency = extractCurrency(value);
		return amount === null ? normalizedText(value) : `${currency ?? ""}${amount.toFixed(2)}`;
	}
	if (field === "account_holder_name") return normalizeNameTokens(value).join(" ");
	if (field === "issuer") return normalizedText(value);
	return normalizedText(value);
}

export interface CandidateValidationInput {
	field: IntegrityCandidateField;
	value: string;
	pageText: string;
	quote: string;
	confidence: number;
	now?: Date;
}

export interface CandidateValidationResult {
	quote: VerifiedQuote | null;
	normalizedValue: string;
	status: "candidate" | "validated" | "rejected";
	validationCodes: string[];
}

/** Formats and flags. A field with no deterministic rule stays `candidate` so
 * the panel never presents an AI guess as checked. */
export function validateCandidate(input: CandidateValidationInput): CandidateValidationResult {
	const verified = verifyQuote(input.pageText, input.quote);
	const codes: string[] = [];
	if (!verified) {
		return {
			quote: null,
			normalizedValue: normalizeCandidateValue(input.field, input.value),
			status: "rejected",
			validationCodes: ["quote_not_found"],
		};
	}
	codes.push("quote_exact");
	if (input.confidence < 0 || input.confidence > 1) codes.push("confidence_out_of_range");
	const value = input.value.trim();
	if (value.length === 0 || value.length > 200) {
		return {
			quote: verified,
			normalizedValue: "",
			status: "rejected",
			validationCodes: [...codes, "value_length_invalid"],
		};
	}
	const normalized = normalizeCandidateValue(input.field, value);

	if (input.field === "document_type") {
		const kind = kindValue(value);
		if (!kind) {
			return {
				quote: verified,
				normalizedValue: normalized,
				status: "rejected",
				validationCodes: [...codes, "unknown_document_type"],
			};
		}
		const labelHit = KIND_LABELS[kind]?.some((label) => quoteContainsText(input.quote, label));
		return {
			quote: verified,
			normalizedValue: kind,
			status: labelHit ? "validated" : "candidate",
			validationCodes: labelHit
				? [...codes, "type_label_present"]
				: [...codes, "classification_requires_review"],
		};
	}

	if (input.field === "document_date" || input.field.startsWith("statement_period_")) {
		const date = parseDateValue(value);
		if (!date || !quoteContainsDate(input.quote, date)) {
			return {
				quote: verified,
				normalizedValue: normalized,
				status: "rejected",
				validationCodes: [...codes, "date_not_in_quote"],
			};
		}
		const now = input.now ?? new Date();
		const plausible =
			date.getUTCFullYear() >= 1990 &&
			date.getUTCFullYear() <= 2100 &&
			(input.field === "document_date"
				? date.getTime() <= new Date(now.getTime() + 366 * 86_400_000).getTime()
				: true);
		return {
			quote: verified,
			normalizedValue: normalized,
			status: plausible ? "validated" : "rejected",
			validationCodes: plausible ? [...codes, "date_valid"] : [...codes, "date_invalid"],
		};
	}

	if (input.field === "registration_number") {
		const registration = normalizeRegistration(value);
		const formatOk = /^[A-Z0-9]{8,10}$/.test(registration);
		const present = normalizedAlnum(input.quote).includes(registration);
		return {
			quote: verified,
			normalizedValue: registration,
			status: formatOk && present ? "validated" : "rejected",
			validationCodes:
				formatOk && present
					? [...codes, "registration_format_valid", "checksum_not_available"]
					: [...codes, formatOk ? "value_not_in_quote" : "registration_format_invalid"],
		};
	}

	if (input.field === "account_number") {
		const digits = onlyDigits(value);
		const formatOk = /^\d{6,20}$/.test(digits);
		const present = onlyDigits(input.quote).includes(digits);
		return {
			quote: verified,
			normalizedValue: digits,
			status: formatOk && present ? "validated" : "rejected",
			validationCodes:
				formatOk && present
					? [...codes, "account_format_valid"]
					: [...codes, formatOk ? "value_not_in_quote" : "account_format_invalid"],
		};
	}

	if (input.field === "material_amount") {
		const amount = parseAmountValue(value);
		const formatOk = amount !== null && amount >= 0;
		const present = amount !== null && quoteContainsAmount(input.quote, amount);
		return {
			quote: verified,
			normalizedValue: normalized,
			status: formatOk && present ? "validated" : "rejected",
			validationCodes:
				formatOk && present
					? [...codes, "amount_valid"]
					: [...codes, formatOk ? "value_not_in_quote" : "amount_invalid"],
		};
	}

	if (!quoteContainsText(input.quote, value)) {
		return {
			quote: verified,
			normalizedValue: normalized,
			status: "rejected",
			validationCodes: [...codes, "value_not_in_quote"],
		};
	}

	return {
		quote: verified,
		normalizedValue: normalized,
		status: "candidate",
		validationCodes: [...codes, "requires_reviewer_confirmation"],
	};
}

function severityForField(field: IntegrityConsistencyField): IntegritySeverity {
	if (
		field === "company_name" ||
		field === "registration_number" ||
		field === "account_holder_name" ||
		field === "material_amount"
	) {
		return "high";
	}
	if (field === "statement_period" || field === "document_date") return "medium";
	return "low";
}

function compareAmounts(
	left: { value: string; currency?: string; label: string },
	right: { value: string; currency?: string; label: string },
): { kind: "match" | "mismatch" | null; basis: string } {
	if (
		normalizeLabel(left.label) === "" ||
		normalizeLabel(left.label) !== normalizeLabel(right.label)
	) {
		return { kind: null, basis: "label_mismatch" };
	}
	const leftCurrency = (left.currency ?? extractCurrency(left.value))?.toUpperCase() ?? null;
	const rightCurrency = (right.currency ?? extractCurrency(right.value))?.toUpperCase() ?? null;
	if (!leftCurrency || !rightCurrency || leftCurrency !== rightCurrency) {
		return { kind: null, basis: "currency_not_comparable" };
	}
	const a = parseAmountValue(left.value);
	const b = parseAmountValue(right.value);
	if (a === null || b === null) return { kind: null, basis: "amount_not_parsed" };
	return {
		kind: a === b ? "match" : "mismatch",
		basis: `amount:${leftCurrency}`,
	};
}

function compareDates(
	left: { value: string; label: string },
	right: { value: string; label: string },
): { kind: "match" | "mismatch" | null; basis: string } {
	if (normalizeLabel(left.label) !== normalizeLabel(right.label)) {
		return { kind: null, basis: "label_mismatch" };
	}
	const a = parseDateValue(left.value);
	const b = parseDateValue(right.value);
	if (!a || !b) return { kind: null, basis: "date_not_parsed" };
	return { kind: datesMatch(a, b) ? "match" : "mismatch", basis: "document_date" };
}

function comparePeriods(
	left: { value: string; label: string },
	right: { value: string; label: string },
): { kind: "match" | "mismatch" | null; basis: string } {
	if (normalizeLabel(left.label) !== normalizeLabel(right.label)) {
		return { kind: null, basis: "label_mismatch" };
	}
	const a = parsePeriod(left.value);
	const b = parsePeriod(right.value);
	if (!a || !b) return { kind: null, basis: "period_not_parsed" };
	return {
		kind: datesMatch(a.start, b.start) && datesMatch(a.end, b.end) ? "match" : "mismatch",
		basis: "statement_period",
	};
}

export interface ConsistencyValidationInput {
	proposal: IntegrityConsistencyProposal;
	leftPageText: string;
	rightPageText: string;
}

/** Deterministic confirmation. Anything not comparable stays `candidate` and
 * renders as needs_chase; it can never become a confirmed mismatch. */
export function confirmConsistency(input: ConsistencyValidationInput): ValidatedConsistency {
	const { proposal } = input;
	const leftQuote = verifyQuote(input.leftPageText, proposal.left.quote);
	const rightQuote = verifyQuote(input.rightPageText, proposal.right.quote);
	const severity = severityForField(proposal.field);
	const base = {
		field: proposal.field,
		proposedKind: proposal.proposedKind,
		severity,
		left: {
			documentFileId: proposal.left.documentFileId,
			pageNumber: proposal.left.pageNumber,
			value: proposal.left.value.trim(),
			label: proposal.left.label.trim(),
			currency: extractCurrency(proposal.left.quote),
			quote: proposal.left.quote.trim(),
			offsetStart: leftQuote?.offsetStart ?? 0,
			offsetEnd: leftQuote?.offsetEnd ?? 0,
			quoteHash: leftQuote?.quoteHash ?? "",
		},
		right: {
			documentFileId: proposal.right.documentFileId,
			pageNumber: proposal.right.pageNumber,
			value: proposal.right.value.trim(),
			label: proposal.right.label.trim(),
			currency: extractCurrency(proposal.right.quote),
			quote: proposal.right.quote.trim(),
			offsetStart: rightQuote?.offsetStart ?? 0,
			offsetEnd: rightQuote?.offsetEnd ?? 0,
			quoteHash: rightQuote?.quoteHash ?? "",
		},
	};

	if (!leftQuote || !rightQuote) {
		return {
			...base,
			kind: null,
			comparisonBasis: "quote_not_found",
			explanation: null,
			explanationVerified: false,
			status: "rejected",
			reason: "quote_not_found",
		};
	}
	const leftValuePresent = normalizedText(proposal.left.quote).includes(
		normalizedText(proposal.left.value),
	);
	const rightValuePresent = normalizedText(proposal.right.quote).includes(
		normalizedText(proposal.right.value),
	);
	if (!leftValuePresent || !rightValuePresent) {
		return {
			...base,
			kind: null,
			comparisonBasis: "value_not_in_quote",
			explanation: null,
			explanationVerified: false,
			status: "rejected",
			reason: "value_not_in_quote",
		};
	}

	let kind: "match" | "mismatch" | null = null;
	let basis = "";
	let reason = "";
	if (proposal.field === "company_name" || proposal.field === "account_holder_name") {
		const verdict = compareNames(proposal.left.value, proposal.right.value);
		if (verdict === "mismatch") {
			kind = "mismatch";
			reason = "deterministic_name_mismatch";
		} else if (verdict === "match") {
			kind = "match";
			reason = "deterministic_name_match";
		} else {
			reason = `name_${verdict}`;
		}
		basis = `name:${verdict}`;
	} else if (proposal.field === "registration_number") {
		const verdict = compareRegistration(proposal.left.value, proposal.right.value);
		if (verdict === "mismatch" || verdict === "confusable") {
			kind = "mismatch";
			reason = verdict === "confusable" ? "registration_confusable" : "registration_mismatch";
		} else {
			kind = "match";
			reason = "registration_match";
		}
		basis = `registration:${verdict}`;
	} else if (proposal.field === "material_amount") {
		const compared = compareAmounts(proposal.left, proposal.right);
		kind = compared.kind;
		basis = compared.basis;
		reason = kind === null ? "amount_needs_chase" : `amount_${kind}`;
	} else if (proposal.field === "statement_period") {
		const compared = comparePeriods(proposal.left, proposal.right);
		kind = compared.kind;
		basis = compared.basis;
		reason = kind === null ? "period_needs_chase" : `period_${kind}`;
	} else if (proposal.field === "document_date") {
		const compared = compareDates(proposal.left, proposal.right);
		kind = compared.kind;
		basis = compared.basis;
		reason = kind === null ? "date_needs_chase" : `date_${kind}`;
	} else {
		basis = "unsupported_field";
		reason = "field_not_comparable";
	}

	const status: ValidatedConsistency["status"] = kind === null ? "candidate" : "confirmed";
	const explanation =
		kind === null
			? null
			: `Left ${normalizeLabel(proposal.left.label) || "value"}: "${proposal.left.quote.trim()}"; ` +
				`right: "${proposal.right.quote.trim()}".`;
	return {
		...base,
		kind,
		comparisonBasis: basis,
		explanation,
		explanationVerified: explanation !== null,
		status,
		reason,
	};
}
