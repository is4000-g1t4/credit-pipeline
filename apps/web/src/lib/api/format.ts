// --- Formatting / status helpers. ---

import { isTerminal as coreIsTerminal, type ApplicationStatus } from "@credit/core/browser";

const usd = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
});

const DATE_LOCALE = "en-SG";
const TIME_ZONE = "Asia/Singapore";

const dateFmt = new Intl.DateTimeFormat(DATE_LOCALE, {
	day: "2-digit",
	month: "short",
	year: "numeric",
	timeZone: TIME_ZONE,
});

const dateTimeFmt = new Intl.DateTimeFormat(DATE_LOCALE, {
	day: "2-digit",
	month: "short",
	year: "numeric",
	hour: "2-digit",
	minute: "2-digit",
	hour12: false,
	timeZone: TIME_ZONE,
});

/** Null-safe cents → USD; check-only decisions carry null amounts (SPEC §2.2). */
export function formatMoney(cents: number | null | undefined): string {
	return cents === null || cents === undefined ? "—" : usd.format(cents / 100);
}

export function formatDate(iso: string | null | undefined): string {
	if (!iso) return "—";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : dateFmt.format(d);
}

/** Date-only values (YYYY-MM-DD or date-only ISO) render in UTC: parsing
 * them as local midnight shifts the day for negative offsets. */
export function formatDateOnly(iso: string | null | undefined): string {
	if (!iso) return "—";
	const datePart = iso.length >= 10 ? iso.slice(0, 10) : iso;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return formatDate(iso);
	const d = new Date(`${datePart}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return iso;
	return dateFmt.format(d);
}

export function formatDateTime(iso: string | null | undefined): string {
	if (!iso) return "—";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : dateTimeFmt.format(d);
}

export function formatWait(ms: number): string {
	const mins = Math.floor(ms / 60000);
	if (mins < 1) return "<1m";
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

const FIELD_LABELS: Record<string, string> = {
	dob: "Date of birth",
	fullName: "Full name",
	nationalId: "National ID",
	email: "Email",
	phone: "Phone",
	address: "Address",
	city: "City",
	employerName: "Employer",
	employmentStatus: "Employment status",
	employmentYears: "Years employed",
	monthlyIncomeCents: "Monthly income",
	existingDebtCents: "Existing debt",
	bankRelationshipYears: "Bank relationship (years)",
	companyName: "Company",
	registrationNumber: "Registration number",
	industry: "Industry",
	yearsTrading: "Years trading",
	employees: "Employees",
	annualRevenueCents: "Annual revenue",
	monthlyFcfCents: "Monthly free cash flow",
	existingDebtServiceCents: "Existing debt service",
	collateral: "Collateral",
	hasCollateral: "Has collateral",
	valueCents: "Value",
	id: "ID document",
};

const VALUE_LABELS: Record<string, Record<string, string>> = {
	employmentStatus: {
		employed: "Employed",
		self_employed: "Self-employed",
		retired: "Retired",
		student: "Student",
	},
	industry: {
		hospitality: "Hospitality",
		retail: "Retail",
		services: "Services",
		construction: "Construction",
		other: "Other",
	},
	productScope: {
		individual: "Individual",
		sme: "SME",
		all: "All products",
	},
};

export function valueLabel(key: string, value: string): string {
	return VALUE_LABELS[key]?.[value] ?? value;
}

/** Human label for API field keys; falls back to camelCase/underscore
 * splitting so a new field never renders as a raw machine key. */
export function fieldLabel(key: string): string {
	const mapped = FIELD_LABELS[key];
	if (mapped) return mapped;
	const words = key
		.replace(/_/g, " ")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

export function isMoneyField(key: string): boolean {
	return key.endsWith("Cents");
}

/** Display an arbitrary application field without leaking API notation. */
export function formatFieldValue(key: string, value: unknown): string {
	if (value === null || value === undefined || value === "") return "—";
	if (key === "dob" && typeof value === "string") return formatDateOnly(value);
	if (key === "collateral" && typeof value === "object") {
		const collateral = value as { hasCollateral?: boolean; valueCents?: number };
		const flag = collateral.hasCollateral ? "Yes" : "No";
		return collateral.valueCents === undefined
			? flag
			: `${flag} · ${formatMoney(collateral.valueCents)}`;
	}
	if (isMoneyField(key) && typeof value === "number") return formatMoney(value);
	if (typeof value === "boolean") return value ? "Yes" : "No";
	if (typeof value === "string") return valueLabel(key, value);
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

export function typeLabel(type: string): string {
	return type === "sme" ? "SME" : "Individual";
}

export function productLabel(product: string): string {
	return product === "sme_term_loan" ? "SME term loan" : "Personal loan";
}

const ACTION_LABELS: Record<string, string> = {
	"application.submitted": "Application submitted",
	"application.draft_created": "Draft created",
	"application.draft_updated": "Draft updated",
	"application.booked": "Application booked",
	"application.failed": "Application failed",
	"review.requested": "Review requested",
	"review.expired": "Review window expired",
	"decision.made": "Decision recorded",
	"policy.evaluated": "Policy evaluated",
	"policy.rule_failures_read": "Policy rule failures viewed",
	"score.computed": "Score computed",
	"data.bank": "Bank data retrieved",
	"data.bureau": "Bureau data retrieved",
	"kyc.identity": "Identity checked",
	"kyc.sanctions": "Sanctions checked",
	"kyc.documents": "Documents checked",
	"document.uploaded": "Document uploaded",
	"document.reused": "Document reused",
	"document.rejected": "Document rejected",
	"document.deleted": "Document deleted",
	"document.consent_updated": "Document consent updated",
	"document.chase_drafted": "Document chase drafted",
	"document.crosscheck_started": "Document cross-check started",
	"document.crosscheck_completed": "Document cross-check completed",
	"document.original_opened": "Document opened",
	"document.viewed": "Document viewed",
	"document.retry_ocr": "Document text retried",
	"document.hold_created": "Document hold created",
	"document.hold_released": "Document hold released",
	"customer.profile_confirmed": "Profile details confirmed",
	"customer.document_deleted": "Customer document deleted",
	"customer.hold_created": "Customer document hold created",
	"customer.hold_released": "Customer document hold released",
	"customer.read": "Customer profile viewed",
	"context.consent_updated": "Context consent updated",
	"context.completed": "Context analysis completed",
	"context.failed": "Context analysis failed",
	"context.retry": "Context analysis retried",
	"context.purge": "Context data purged",
	"context.purge_failed": "Context purge failed",
	"context.read": "Context data viewed",
	"context.denied": "Context access denied",
	"context.signal_review": "Context signal reviewed",
	"access.claim": "Case claimed",
	"access.grant": "Case access granted",
	"access.revoke": "Case access revoked",
	"access.denied": "Case access denied",
	"integrity.analysis_requested": "Integrity analysis requested",
	"integrity.analysis_started": "Integrity analysis started",
	"integrity.analysis_succeeded": "Integrity analysis completed",
	"integrity.analysis_failed": "Integrity analysis failed",
	"integrity.flag_opened": "Fraud review opened",
	"integrity.flag_updated": "Fraud review updated",
	"integrity.brief_stale": "Integrity brief marked stale",
	"integrity.review_staled": "Fraud review marked stale",
	"integrity.consistency_escalated": "Consistency mismatch escalated",
	"integrity.evaluate_requested": "Integrity evaluation requested",
	"integrity.evaluate_failed": "Integrity evaluation failed",
	"integrity.run_queued": "Integrity run queued",
	"integrity.run_enqueue_failed": "Integrity run could not be queued",
	"integrity.triage_succeeded": "Integrity triage completed",
	"fraud_review.resolved": "Fraud review resolved",
	"fraud_review.viewed": "Fraud review viewed",
	"fraud_review.retention_applied": "Fraud review retention applied",
	"fraud.duplicate_lookup": "Duplicate document lookup",
	"fraud.duplicate_explained": "Duplicate document explained",
	"fraud.duplicate_explanation_retention": "Duplicate explanation retention applied",
	"artifact.created": "Artifact created",
	"artifact.edited": "Artifact edited",
	"artifact.approved": "Artifact approved",
	"artifact.superseded": "Artifact superseded",
	"artifact.version_created": "Artifact version created",
	"artifact.tombstoned": "Artifact deleted",
	"artifact.deleted": "Artifact deleted",
	"artifact.generate_blocked": "Artifact generation blocked",
	"artifact.hold_created": "Artifact hold created",
	"artifact.hold_released": "Artifact hold released",
	"artifact.retention_deleted": "Artifact retention applied",
	"policy_exception.explained": "Policy exception explained",
	"policy_exception.followup": "Policy exception follow-up",
	"policy_exception.viewed": "Policy exception viewed",
	"policy_exception.generate_blocked": "Policy exception generation blocked",
	"loan.booked": "Loan booked",
	"loan.aged": "Loan aged for demo",
	"payment.posted": "Payment posted",
	"ews.alert": "Early-warning alert raised",
	"ews.alert.acknowledged": "Early-warning alert acknowledged",
	"run.ensure": "Research run ensured",
	"run.read": "Research run viewed",
	"run.view": "Research findings viewed",
	"bundle.read": "Research bundle read",
	"auto.ensure": "Automatic research started",
	"auto.skip": "Automatic research skipped",
	"finding.review": "Research finding reviewed",
};

/** Sentence-case label for an audit/feed code; unknown codes are de-slugged. */
export function actionLabel(action: string | null | undefined): string {
	if (!action) return "Activity";
	const mapped = ACTION_LABELS[action];
	if (mapped) return mapped;
	const words = action.replace(/[._]+/g, " ").trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Terminal application statuses — single source of truth in @credit/core. */
export function isTerminal(status: string): boolean {
	return coreIsTerminal(status as ApplicationStatus);
}
