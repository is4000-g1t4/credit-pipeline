// EN-01/EN-02 deterministic credit-memo builder: evidence bundle -> CreditMemoContent.
//
// Pure: no clock, no DB, no logging. Every narrative claim cites bundle items
// (quotes are exact item content). Free text is static or number-formatted so
// it passes the EN-03 decision-language, PII, and protected-attribute scans:
// in particular the word "term" never appears ("duration"/"months" instead).
import {
	FACTOR_LABELS,
	parseSourceRef,
	type CreditMemoContent,
	type EvidenceBundle,
	type EvidenceItem,
	type OpenItem,
} from "@credit/core";
import type { applications } from "@credit/db/applications";

export interface MemoInput {
	application: typeof applications.$inferSelect;
	evidence: EvidenceBundle;
}

type ApplicationRow = typeof applications.$inferSelect;

const POLICY_RISK_TEXT: Record<string, string> = {
	SCORE_TOO_LOW: "The assessment factor is below the preferred minimum.",
	SCORE_IN_REFER_BAND: "The assessment factor is within the review band.",
	AMOUNT_ABOVE_AUTO_LIMIT: "The requested amount exceeds the automatic processing threshold.",
	AMOUNT_OUT_OF_RANGE: "The requested amount is outside the supported range.",
	TERM_OUT_OF_RANGE: "The requested duration is outside the supported range.",
	DTI_TOO_HIGH: "Debt-to-income is above the preferred maximum.",
	DTI_IN_REFER_BAND: "Debt-to-income is within the review band.",
	DSCR_TOO_LOW: "Debt-service coverage is below the preferred minimum.",
	DSCR_IN_REFER_BAND: "Debt-service coverage is within the review band.",
	SECTOR_REVIEW: "The sector is flagged for officer awareness.",
	SHORT_EMPLOYMENT: "Employment history is below the preferred tenure.",
	TRADING_HISTORY_TOO_SHORT: "Trading history is below the preferred minimum.",
	TRADING_HISTORY_IN_REFER_BAND: "Trading history is within the review band.",
	REVENUE_TOO_LOW: "Revenue is below the preferred minimum.",
};

const POLICY_RISK_FALLBACK = "A policy evaluation reason is recorded for officer review.";

const OFFICER_QUESTIONS = [
	"What is the current status of the requested documents?",
	"Are the latest financial statements available for review?",
	"Which policy exception route applies to this case?",
	"Are there any outstanding open items that need follow-up?",
];

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asText(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function formatUSD(cents: number): string {
	return `USD ${(cents / 100).toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;
}

/** Display a money value: row value first, else a numeric case-fact content, else null. */
function moneyText(rowValue: unknown, content: string): string | null {
	const cents =
		asNumber(rowValue) ?? (/^\d+$/.test(content.trim()) ? Number(content.trim()) : null);
	return cents !== null && Number.isFinite(cents) ? formatUSD(cents) : null;
}

function citationOf(item: EvidenceItem): { ref: string; quote: string } {
	// ponytail: the validator caps quotes at 4,000 chars; a longer source
	// excerpt is truncated to an exact prefix. Align the caps if evidence
	// excerpts grow.
	return { ref: item.ref, quote: item.content.slice(0, 4_000) };
}

function productLabel(product: string): string {
	if (product === "sme_term_loan") return "SME lending product";
	if (product === "personal_loan") return "personal loan product";
	// ponytail: "term" is banned by the EN-03 decision-language scan.
	return product.replaceAll("_", " ").replace(/\bterm\b/g, "duration");
}

/** Only interpolate short identifier-ish values into free text (PII-scan safety). */
function safeToken(value: string): boolean {
	if (!/^[A-Za-z0-9_.-]{1,80}$/.test(value)) return false;
	return value.replace(/[^0-9]/g, "").length <= 7 && !/^\d{8}$/.test(value);
}

function factorLabel(item: EvidenceItem): string {
	const code = asText(item.metadata["code"]);
	if (code !== null && code in FACTOR_LABELS) {
		return FACTOR_LABELS[code as keyof typeof FACTOR_LABELS];
	}
	return asText(item.metadata["label"]) ?? item.label;
}

function policyRiskText(item: EvidenceItem): string {
	const code = asText(item.metadata["code"]) ?? parseScoreCode(item.ref);
	if (code !== null && code in POLICY_RISK_TEXT) return POLICY_RISK_TEXT[code];
	return POLICY_RISK_FALLBACK;
}

function parseScoreCode(ref: string): string | null {
	const parsed = parseSourceRef(ref);
	return parsed !== null && parsed.type === "score_reason" ? parsed.code : null;
}

const SOURCE_LABELS: Record<string, string> = {
	document: "document",
	context_signal: "case signal",
	external_evidence: "external report",
	policy_section: "policy section",
	score_reason: "assessment reason",
	case_fact: "case fact",
};

function unavailableCode(sourceType: string, code: string): OpenItem["code"] {
	if (code === "missing") {
		if (sourceType === "document") return "missing_document";
		if (sourceType === "context_signal" || sourceType === "external_evidence")
			return "stale_document";
		if (sourceType === "policy_section" || sourceType === "score_reason") return "failed_rule";
		return "other";
	}
	if (code === "access_denied" || code === "retention_expired") {
		if (
			sourceType === "case_fact" ||
			sourceType === "policy_section" ||
			sourceType === "score_reason"
		) {
			return "other";
		}
		return "stale_document";
	}
	return "other";
}

interface SectionClaim {
	text: string;
	citations: Array<{ ref: string; quote: string }>;
}

function section(
	key: CreditMemoContent["sections"][number]["key"],
	title: string,
	claims: SectionClaim[],
): CreditMemoContent["sections"][number] {
	// ponytail: cap at the validator's 20-claim section bound. Aggregate the
	// overflow if evidence volume grows beyond a demo case.
	const capped = claims.slice(0, 20);
	return capped.length > 0
		? { key, title, claims: capped, notAvailable: false }
		: { key, title, claims: [], notAvailable: true };
}

function buildRequest(app: ApplicationRow, items: Map<string, EvidenceItem>): SectionClaim[] {
	const byField = (field: string): EvidenceItem | null => {
		const item = items.get(`case_fact:${app.id}:${field}`);
		return item !== undefined && item.sourceType === "case_fact" ? item : null;
	};
	const amount = byField("amountCents");
	const months = byField("termMonths");
	const product = byField("product");
	if (amount === null && months === null && product === null) return [];
	const fragments: string[] = [];
	const citations: Array<{ ref: string; quote: string }> = [];
	const cents = asNumber(app.amountCents);
	if (amount !== null) {
		const display = cents !== null ? formatUSD(cents) : moneyText(null, amount.content);
		fragments.push(
			display !== null ? `for ${display}` : "for the amount stated in the case record",
		);
		citations.push(citationOf(amount));
	}
	if (months !== null) {
		const raw = asNumber(app.termMonths);
		const parsed =
			raw !== null ? raw : /^\d{1,3}$/.test(months.content.trim()) ? months.content.trim() : null;
		fragments.push(
			parsed !== null ? `over ${parsed} months` : "over the duration stated in the case record",
		);
		citations.push(citationOf(months));
	}
	if (product !== null) {
		fragments.push(`under the ${productLabel(asText(app.product) ?? product.content)}`);
		citations.push(citationOf(product));
	}
	return [{ text: `The request is ${fragments.join(" ")}.`, citations: citations.slice(0, 5) }];
}

function buildEntity(app: ApplicationRow, items: Map<string, EvidenceItem>): SectionClaim[] {
	const isSme = app.type === "sme";
	const candidates: Array<{ field: string; text: string }> = [];
	if (isSme) {
		candidates.push(
			{ field: "companyName", text: "The applicant is the company named in the case record." },
			{
				field: "industry",
				text: "The applicant operates in the sector stated in the case record.",
			},
			{
				field: "yearsTrading",
				text: "The trading history stated in the case record is noted for review.",
			},
			{ field: "city", text: "The applicant is based in the city stated in the case record." },
		);
	} else {
		candidates.push(
			{ field: "applicantName", text: "The application relates to an individual applicant." },
			{ field: "city", text: "The applicant is based in the city stated in the case record." },
		);
	}
	const claims: SectionClaim[] = [];
	for (const candidate of candidates) {
		const item = items.get(`case_fact:${app.id}:${candidate.field}`);
		if (item !== undefined && item.sourceType === "case_fact") {
			claims.push({ text: candidate.text, citations: [citationOf(item)] });
		}
	}
	return claims;
}

function buildFinancials(app: ApplicationRow, items: Map<string, EvidenceItem>): SectionClaim[] {
	const isSme = app.type === "sme";
	const block = asRecord(isSme ? app.business : app.financial);
	const fields = isSme
		? [
				{
					field: "business.annualRevenueCents",
					row: block["annualRevenueCents"],
					generic: "A revenue figure is stated in the case record." as string,
					money: (v: string) => `Annual revenue is ${v} for the stated period.`,
				},
				{
					field: "business.monthlyFcfCents",
					row: block["monthlyFcfCents"],
					generic: "A cash-flow figure is stated in the case record." as string,
					money: (v: string) => `Average monthly free cash flow is ${v}.`,
				},
				{
					field: "business.existingDebtServiceCents",
					row: block["existingDebtServiceCents"],
					generic: "A debt-service figure is stated in the case record." as string,
					money: (v: string) => `Existing monthly debt service is ${v}.`,
				},
			]
		: [
				{
					field: "financial.monthlyIncomeCents",
					row: block["monthlyIncomeCents"],
					generic: "An income figure is stated in the case record." as string,
					money: (v: string) => `Monthly income is ${v}.`,
				},
				{
					field: "financial.existingDebtCents",
					row: block["existingDebtCents"],
					generic: "A debt figure is stated in the case record." as string,
					money: (v: string) => `Existing debt is ${v}.`,
				},
			];
	const claims: SectionClaim[] = [];
	for (const entry of fields) {
		const item = items.get(`case_fact:${app.id}:${entry.field}`);
		if (item === undefined || item.sourceType !== "case_fact") continue;
		const display = moneyText(entry.row, item.content);
		claims.push({
			text: display !== null ? entry.money(display) : entry.generic,
			citations: [citationOf(item)],
		});
	}
	return claims;
}

export function buildCreditMemo(input: MemoInput): CreditMemoContent {
	const { application: app, evidence } = input;
	const items = new Map<string, EvidenceItem>();
	for (const item of evidence.items) {
		if (!items.has(item.ref)) items.set(item.ref, item);
	}

	const strengths: SectionClaim[] = [];
	// Lower priority number survives the 20-claim cap first. Deterministic
	// assessment/policy and document findings outrank bulk signals/reports.
	const risks: Array<{ claim: SectionClaim; priority: number }> = [];
	let scoreSeen = false;
	let documentsSeen = false;
	for (const item of evidence.items) {
		if (item.sourceType === "document") documentsSeen = true;
		if (item.sourceType === "score_reason") {
			scoreSeen = true;
			const kind = asText(item.metadata["kind"]);
			const impact = asText(item.metadata["impact"]);
			if (kind === "factor" && impact === "positive") {
				strengths.push({
					text: `${factorLabel(item)} is a positive assessment factor.`,
					citations: [citationOf(item)],
				});
			} else if (kind === "factor" && impact === "negative") {
				risks.push({
					priority: 0,
					claim: {
						text: `${factorLabel(item)} is noted for officer review.`,
						citations: [citationOf(item)],
					},
				});
			} else if (kind === "factor") {
				continue;
			} else {
				risks.push({
					priority: 0,
					claim: { text: policyRiskText(item), citations: [citationOf(item)] },
				});
			}
		} else if (item.sourceType === "document" && asText(item.metadata["status"]) === "mismatch") {
			const field = asText(item.metadata["field"]);
			risks.push({
				priority: 1,
				claim: {
					text:
						field !== null && safeToken(field)
							? `A document consistency check recorded a mismatch for ${field}.`
							: "A document consistency check recorded a mismatch for the record.",
					citations: [citationOf(item)],
				},
			});
		} else if (item.sourceType === "external_evidence") {
			if (asText(item.metadata["reviewStatus"]) === "rejected") continue;
			risks.push({
				priority: 2,
				claim: {
					text: "An external report is recorded for officer review.",
					citations: [citationOf(item)],
				},
			});
		} else if (item.sourceType === "context_signal") {
			if (asText(item.metadata["reviewStatus"]) === "rejected") continue;
			risks.push({
				priority: 3,
				claim: {
					text: "A cash-flow signal is recorded for officer review.",
					citations: [citationOf(item)],
				},
			});
		}
	}
	const riskClaims = risks.sort((a, b) => a.priority - b.priority).map((entry) => entry.claim);

	const policyClaims: SectionClaim[] = [];
	for (const item of evidence.items) {
		if (item.sourceType !== "policy_section") continue;
		policyClaims.push({
			// Keep the prose neutral: a policy key/section id could itself
			// contain a banned word (e.g. `terms-1`). The citation metadata
			// carries the exact identifiers.
			text: "A policy section is cited for this case.",
			citations: [citationOf(item)],
		});
	}

	const request = buildRequest(app, items);
	const entity = buildEntity(app, items);
	const financials = buildFinancials(app, items);

	const openItems: OpenItem[] = [];
	for (const unavailable of evidence.unavailable) {
		const sourceType = unavailable.sourceType;
		openItems.push({
			text: `A ${SOURCE_LABELS[sourceType] ?? "case"} source is unavailable; follow-up is needed to complete the record.`,
			code: unavailableCode(sourceType, unavailable.code),
			sourceRef: unavailable.ref,
		});
	}
	if (financials.length === 0) {
		openItems.push({
			text: "Financial information is not available in the case record.",
			code: "financials_unavailable",
		});
	}
	if (!scoreSeen) {
		openItems.push({
			text: "Assessment factor detail is not available in the case evidence.",
			code: "other",
		});
	}
	if (!documentsSeen) {
		openItems.push({
			text: "Document citations are not available in the case evidence.",
			code: "missing_document",
		});
	}
	if (policyClaims.length === 0) {
		openItems.push({
			text: "Policy citations are not available in the case evidence.",
			code: "other",
		});
	}

	return {
		title: `Credit memorandum draft — ${app.reference}`,
		sections: [
			section("request", "Request", request),
			section("entity", "Entity", entity),
			section("financial_summary", "Financial summary", financials),
			section("strengths", "Strengths", strengths),
			section("risks", "Risks", riskClaims),
			section("policy_compliance", "Policy compliance", policyClaims),
		],
		openItems: openItems.slice(0, 50),
		officerQuestions: [...OFFICER_QUESTIONS],
	};
}
