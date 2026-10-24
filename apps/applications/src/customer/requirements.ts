// T17 requirements engine (SPEC-t17-t18 §2.2, `demo-requirements-v1`).
// Pure: every input is data, `asOf` is injected — routes resolve the
// effective clock (live now vs fixture DEMO_AS_OF) and feed rows in.
// Unit-tested without a DB.
//
// Freshness: `period_end` is authoritative for bank_statement (≤90d) and
// financial_statements (≤18m); a null/unknown or future period is a blocker,
// never fresh. `id`/`business_registration`/`payslip` carry no statement age
// — KYC validity is their hard gate, an unknown date is advisory only.
import { createHmac } from "node:crypto";
import { canonicalJson } from "@credit/core";
import type { DocumentKind } from "../documents/pipeline.js";

export const REQUIREMENTS_POLICY_VERSION = "demo-requirements-v1";
export const BANK_STATEMENT_MAX_DAYS = 90;
export const FINANCIAL_STATEMENT_MAX_MONTHS = 18;

/** Statement date provenance trusted for hard freshness. `server_ocr`
 * (ordinary upload extraction) and null/unknown sources never satisfy the
 * hard age gate for statement kinds — they read as `unknown_date`. */
export const TRUSTED_DATE_SOURCES = new Set(["statement_import", "reused", "customer_kyc"]);

function isStatementKind(kind: string): boolean {
	return kind === "bank_statement" || kind === "financial_statements";
}

/** Product-required app evidence. `payslip`/`financial_statements` are D0
 * enum additions (SPEC §2.2); T02 still treats them as needs_chase. */
export const REQUIRED_DOCS: Record<"personal_loan" | "sme_term_loan", DocumentKind[]> = {
	personal_loan: ["id", "payslip", "bank_statement"],
	sme_term_loan: ["id", "business_registration", "financial_statements", "bank_statement"],
};

export type DocFreshness = "fresh" | "stale" | "unknown" | "invalid" | "na";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Statement freshness against `asOf`. Non-statement kinds are `na` — the
 * caller still requires a ready row, but no age applies. */
export function statementFreshness(
	kind: string,
	periodEnd: string | null,
	asOf: Date,
): DocFreshness {
	if (kind !== "bank_statement" && kind !== "financial_statements") return "na";
	if (!periodEnd || !DATE_RE.test(periodEnd)) return "unknown";
	const pe = new Date(`${periodEnd}T00:00:00Z`);
	if (Number.isNaN(pe.getTime())) return "invalid";
	if (pe.getTime() > asOf.getTime()) return "invalid";
	if (kind === "bank_statement") {
		const asOfDay = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
		const ageDays = Math.floor((asOfDay - pe.getTime()) / 86_400_000);
		return ageDays <= BANK_STATEMENT_MAX_DAYS ? "fresh" : "stale";
	}
	const threshold = Date.UTC(
		asOf.getUTCFullYear(),
		asOf.getUTCMonth() - FINANCIAL_STATEMENT_MAX_MONTHS,
		asOf.getUTCDate(),
	);
	return pe.getTime() >= threshold ? "fresh" : "stale";
}

export interface AppDocInput {
	kind: string;
	status: string;
	periodEnd: string | null;
	documentDate: string | null;
	uploadedAt: Date;
	id?: string;
	/** Provenance of the statement date. Only trusted verified sources
	 * (`statement_import`, `reused`, `customer_kyc`) satisfy hard freshness
	 * for statement kinds; `server_ocr` from ordinary uploads is
	 * `unknown_date`/needs-chase, never hard-fresh. */
	documentDateSource?: string | null;
}

export interface CustomerDocInput {
	id: string;
	kind: string;
	status: string;
	scanStatus: string;
	retentionUntil: Date;
	blobPurgedAt: Date | null;
	periodEnd: string | null;
	documentDate: string | null;
}

export interface RequirementsInput {
	product: "personal_loan" | "sme_term_loan";
	asOf: Date;
	profile: {
		kycStatus: string;
		kycExpiresAt: Date | null;
		identity: Record<string, unknown>;
		business: Record<string, unknown> | null;
	} | null;
	application: {
		identity: Record<string, unknown>;
		sme: Record<string, unknown> | null;
		consents: unknown;
		documentProcessingConsent: boolean;
	};
	/** Stored server-derived confirmation fields for the application. */
	confirmedFields: string[];
	appDocs: AppDocInput[];
	customerDocs: CustomerDocInput[];
}

export interface RequirementsWarning {
	code: string;
	kind?: string;
	field?: string;
}

export interface RequirementsResult {
	policyVersion: string;
	asOf: string;
	readyToSubmit: boolean;
	/** Typed checklist: `field:<path>` / `document:<kind>` → reason codes
	 * (`required|stale|expired|unknown_date|rejected|missing|consent|
	 * identity_mismatch|invalid`). No PII, no document content. */
	blockers: Record<string, string[]>;
	warnings: RequirementsWarning[];
	requiredDocuments: Array<{ kind: string; reason: string }>;
	reusableDocuments: Array<{
		customerDocumentId: string;
		kind: string;
		periodEnd: string | null;
		documentDate: string | null;
	}>;
	prefill: { reused: string[]; edited: string[]; unconfirmed: string[] };
	kyc: { status: string | null; expiresAt: string | null };
}

function compareDocs(a: AppDocInput, b: AppDocInput): number {
	// Latest eligible first: period_end, document_date, uploaded_at, id —
	// nulls sort LAST so an unknown-date row never outranks a dated one.
	for (const pick of [
		(d: AppDocInput) => d.periodEnd,
		(d: AppDocInput) => d.documentDate,
	] as const) {
		const x = pick(a);
		const y = pick(b);
		if (x === y) continue;
		if (x === null || x === undefined) return 1;
		if (y === null || y === undefined) return -1;
		return x < y ? 1 : -1;
	}
	const ta = a.uploadedAt.getTime();
	const tb = b.uploadedAt.getTime();
	if (ta !== tb) return ta < tb ? 1 : -1;
	const ia = a.id ?? "";
	const ib = b.id ?? "";
	return ia < ib ? 1 : ia > ib ? -1 : 0;
}

/** KYC identity match: the application's declared identity must equal the
 * verified profile on name + dob + national id, or the profile KYC cannot
 * cover this application (refresh/identity evidence required). */
export function identityMatchesProfile(
	appIdentity: Record<string, unknown>,
	profileIdentity: Record<string, unknown>,
): boolean {
	for (const field of ["fullName", "dob", "nationalId"] as const) {
		if (
			canonicalJson(appIdentity[field] ?? null) !== canonicalJson(profileIdentity[field] ?? null)
		) {
			return false;
		}
	}
	return true;
}

function baseConsentsOk(consents: unknown): boolean {
	return Array.isArray(consents) && consents.length === 3 && consents.every((c) => c === true);
}

export function requirementsFor(input: RequirementsInput): RequirementsResult {
	const { asOf, product, profile, application } = input;
	const blockers: Record<string, string[]> = {};
	const warnings: RequirementsWarning[] = [];
	const requiredDocuments: Array<{ kind: string; reason: string }> = [];

	// --- Consents (hard; context/AI consents stay optional for submit). ---
	if (!baseConsentsOk(application.consents)) {
		blockers["field:consents"] = ["consent"];
	}
	if (!application.documentProcessingConsent) {
		blockers["field:documentProcessingConsent"] = ["consent"];
	}

	// --- KYC (hard only with a matching verified profile). ---
	let kycStatus: string | null = null;
	let kycExpiresAt: string | null = null;
	if (profile) {
		kycStatus = profile.kycStatus;
		kycExpiresAt = profile.kycExpiresAt?.toISOString() ?? null;
		if (!identityMatchesProfile(application.identity, profile.identity)) {
			blockers["field:kyc"] = ["identity_mismatch"];
		} else if (profile.kycStatus === "verified") {
			if (!profile.kycExpiresAt || profile.kycExpiresAt.getTime() <= asOf.getTime()) {
				blockers["field:kyc"] = ["expired"];
			}
		} else if (profile.kycStatus === "expired") {
			blockers["field:kyc"] = ["expired"];
		} else {
			blockers["field:kyc"] = ["missing"];
		}
	}

	// --- Prefill status (informational; create-time confirmation is strict
	// but there is no post-create confirmation endpoint in v1, so an
	// unconfirmed reused value warns rather than bricking the draft). ---
	const confirmed = new Set(input.confirmedFields);
	const reused: string[] = [];
	const edited: string[] = [];
	const unconfirmed: string[] = [];
	if (profile) {
		for (const field of CONFIRMABLE_FIELDS) {
			const appVal = getConfirmableValue(
				{ identity: application.identity, sme: application.sme },
				field,
			);
			if (appVal === undefined) continue;
			const profVal = getConfirmableValue(
				{ identity: profile.identity, sme: profile.business },
				field,
			);
			if (profVal === undefined) {
				edited.push(field);
			} else if (canonicalJson(appVal) === canonicalJson(profVal)) {
				if (confirmed.has(field)) reused.push(field);
				else {
					unconfirmed.push(field);
					warnings.push({ code: "unconfirmed_prefill", field });
				}
			} else {
				edited.push(field);
			}
		}
	}

	// --- Documents: latest eligible ready row per kind decides; older stale
	// copies are warnings once a newer fresh copy exists. ---
	const readyByKind = new Map<string, AppDocInput[]>();
	const rejectedKinds = new Set<string>();
	for (const doc of input.appDocs) {
		if (doc.status === "deleted") continue;
		if (doc.status === "rejected") {
			rejectedKinds.add(doc.kind);
			continue;
		}
		if (doc.status !== "ready") continue;
		const list = readyByKind.get(doc.kind) ?? [];
		list.push(doc);
		readyByKind.set(doc.kind, list);
	}
	for (const kind of REQUIRED_DOCS[product]) {
		const rows = (readyByKind.get(kind) ?? []).sort(compareDocs);
		const latest = rows[0];
		if (!latest) {
			const reason = rejectedKinds.has(kind) ? "rejected" : "missing";
			blockers[`document:${kind}`] = [reason];
			requiredDocuments.push({ kind, reason });
			continue;
		}
		// Statement kinds need a trusted verified date: ordinary-upload
		// `server_ocr` (or a missing source) is unknown_date, never
		// hard-fresh, even with a fresh-looking periodEnd.
		if (isStatementKind(kind) && !TRUSTED_DATE_SOURCES.has(latest.documentDateSource ?? "")) {
			blockers[`document:${kind}`] = ["unknown_date"];
			requiredDocuments.push({ kind, reason: "unknown_date" });
			continue;
		}
		const freshness = statementFreshness(kind, latest.periodEnd, asOf);
		if (freshness === "fresh" || freshness === "na") {
			if (freshness === "na" && !latest.periodEnd && !latest.documentDate) {
				warnings.push({ code: "unknown_date", kind });
			}
			for (const older of rows.slice(1)) {
				const of = statementFreshness(kind, older.periodEnd, asOf);
				if (of === "stale") warnings.push({ code: "superseded_stale", kind });
				else if (of === "unknown" || of === "invalid")
					warnings.push({ code: "superseded_unknown", kind });
			}
			continue;
		}
		const reason = freshness === "unknown" ? "unknown_date" : freshness;
		blockers[`document:${kind}`] = [reason];
		requiredDocuments.push({ kind, reason });
	}

	// --- Reusable customer evidence: ready + clean + unexpired + fresh
	// (statement kinds must be fresh; other kinds carry no age rule). ---
	const reusableDocuments: RequirementsResult["reusableDocuments"] = [];
	for (const doc of input.customerDocs) {
		if (classifyCustomerDoc(doc, asOf).eligible) {
			reusableDocuments.push({
				customerDocumentId: doc.id,
				kind: doc.kind,
				periodEnd: doc.periodEnd,
				documentDate: doc.documentDate,
			});
		}
	}

	return {
		policyVersion: REQUIREMENTS_POLICY_VERSION,
		asOf: asOf.toISOString(),
		readyToSubmit: Object.keys(blockers).length === 0,
		blockers,
		warnings,
		requiredDocuments,
		reusableDocuments,
		prefill: { reused, edited, unconfirmed },
		kyc: { status: kycStatus, expiresAt: kycExpiresAt },
	};
}

/** Reuse eligibility for one customer row (pure; the route additionally
 * enforces ownership via the profile-scoped query). */
export function classifyCustomerDoc(
	doc: CustomerDocInput,
	asOf: Date,
): { eligible: boolean; reason?: string } {
	if (doc.status !== "ready" || doc.scanStatus !== "clean")
		return { eligible: false, reason: "rejected" };
	if (doc.blobPurgedAt !== null) return { eligible: false, reason: "expired" };
	if (doc.retentionUntil.getTime() <= asOf.getTime()) return { eligible: false, reason: "expired" };
	const freshness = statementFreshness(doc.kind, doc.periodEnd, asOf);
	if (freshness === "stale") return { eligible: false, reason: "stale" };
	if (freshness === "unknown" || freshness === "invalid")
		return { eligible: false, reason: "unknown_date" };
	return { eligible: true };
}

// --- Profile confirmations (SPEC §2.2): the client `valueHash` is advisory
// only. A field counts as reused iff the submitted value canonically equals
// the profile value; the stored hash is a server HMAC, never a plain hash
// of these low-entropy values. Unknown fields fail closed (422). ---

/** Closed allowlist: only existing applicationCreateSchema fields. Always
 * application-specific (amount/term/purpose/income declarations) values
 * never match a profile slot and land in `edited` by equality. */
export const CONFIRMABLE_FIELDS = [
	"identity.fullName",
	"identity.dob",
	"identity.nationalId",
	"identity.email",
	"identity.phone",
	"identity.address",
	"identity.city",
	"sme.companyName",
	"sme.registrationNumber",
	"sme.industry",
	"sme.yearsTrading",
	"sme.employees",
	"sme.annualRevenueCents",
	"sme.monthlyFcfCents",
	"sme.existingDebtServiceCents",
] as const;

export type ConfirmableField = (typeof CONFIRMABLE_FIELDS)[number];

export function isConfirmableField(field: string): field is ConfirmableField {
	return (CONFIRMABLE_FIELDS as readonly string[]).includes(field);
}

/** Path lookup: `sme.*` reads the trading-declaration block on the
 * application side and the stored business block on the profile side. */
export function getConfirmableValue(
	source: { identity: Record<string, unknown>; sme: Record<string, unknown> | null },
	field: string,
): unknown {
	const dot = field.indexOf(".");
	if (dot < 0) return undefined;
	const head = field.slice(0, dot);
	const tail = field.slice(dot + 1);
	if (head === "identity") return (source.identity as Record<string, unknown>)[tail];
	if (head === "sme") return source.sme?.[tail];
	return undefined;
}

/** Server HMAC of the canonical value (hex). */
export function confirmationHmac(value: unknown, key: string): string {
	return createHmac("sha256", key).update(canonicalJson(value), "utf8").digest("hex");
}

export interface ClaimedConfirmation {
	field: string;
	valueHash: string;
}

/** Derive reused vs edited purely by canonical equality. Unknown fields
 * throw (the route maps to 422); client hashes are ignored for the
 * decision — a spoofed confirmation of an edited value stays edited. */
export function deriveConfirmations(input: {
	application: { identity: Record<string, unknown>; sme: Record<string, unknown> | null };
	profile: { identity: Record<string, unknown>; business: Record<string, unknown> | null };
	claimed: ClaimedConfirmation[];
}): { reused: ConfirmableField[]; edited: string[] } {
	const reused: ConfirmableField[] = [];
	const edited: string[] = [];
	for (const entry of input.claimed) {
		if (!isConfirmableField(entry.field)) {
			throw new Error(`unknown confirmation field: ${entry.field}`);
		}
		const appVal = getConfirmableValue(input.application, entry.field);
		const profVal = getConfirmableValue(
			{ identity: input.profile.identity, sme: input.profile.business },
			entry.field,
		);
		if (
			appVal !== undefined &&
			profVal !== undefined &&
			canonicalJson(appVal) === canonicalJson(profVal)
		) {
			reused.push(entry.field);
		} else {
			edited.push(entry.field);
		}
	}
	return { reused, edited };
}

// --- Effective clock (SPEC §2.5): one provider for requirements, reuse
// eligibility, submit, and the customer pre-draft views. Fixture-owned rows
// (`applications.source='demo_case'`, stamped at draft create from a
// `demo_seed` profile in DEMO_MODE) evaluate against DEMO_AS_OF; live rows
// use wall clock. Explicit precedence — no mixed-clock case. ---

export function effectiveAsOf(input: {
	appSource: "live" | "demo_case" | null;
	profileSource: "demo_seed" | "customer_master" | null;
	demoMode: boolean;
	demoAsOf: Date;
	now?: Date;
}): Date {
	// App-scoped calls key on the application source only: fixture-owned
	// drafts are stamped `demo_case` at create, live rows use wall clock.
	// Pre-draft customer views (no application yet) use the profile clock.
	if (input.appSource === "demo_case") return input.demoAsOf;
	if (input.appSource === "live") return input.now ?? new Date();
	if (input.demoMode && input.profileSource === "demo_seed") return input.demoAsOf;
	return input.now ?? new Date();
}
