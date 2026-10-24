// T17 requirements engine unit tests (compose-free): freshness
// boundaries, hard/soft classification, KYC/identity, latest-per-kind,
// reusable evidence. Every required field maps to an existing schema field
// or document kind (SPEC-t17-t18 §2.2).
import { describe, expect, it } from "vitest";
import {
	classifyCustomerDoc,
	effectiveAsOf,
	identityMatchesProfile,
	REQUIREMENTS_POLICY_VERSION,
	REQUIRED_DOCS,
	requirementsFor,
	statementFreshness,
	type RequirementsInput,
} from "../../src/customer/requirements.js";

const AS_OF = new Date("2026-06-30T00:00:00Z");
const day = (n: number): string => new Date(Date.UTC(2026, 5, 30 - n)).toISOString().slice(0, 10);

const IDENTITY = {
	fullName: "Aisha Rahman",
	dob: "1990-05-01",
	nationalId: "S1234567A",
	email: "aisha@example.com",
	phone: "+65-8100-0001",
	address: "1 Test Street",
	city: "Singapore",
};

function baseInput(overrides: Partial<RequirementsInput> = {}): RequirementsInput {
	return {
		product: "personal_loan",
		asOf: AS_OF,
		profile: {
			kycStatus: "verified",
			kycExpiresAt: new Date("2027-06-30T00:00:00Z"),
			identity: { ...IDENTITY },
			business: null,
		},
		application: {
			identity: { ...IDENTITY },
			sme: null,
			consents: [true, true, true],
			documentProcessingConsent: true,
		},
		confirmedFields: [],
		appDocs: [
			{ kind: "id", status: "ready", periodEnd: null, documentDate: null, uploadedAt: AS_OF },
			{ kind: "payslip", status: "ready", periodEnd: null, documentDate: null, uploadedAt: AS_OF },
			{
				kind: "bank_statement",
				status: "ready",
				periodEnd: day(30),
				documentDate: day(30),
				uploadedAt: AS_OF,
				documentDateSource: "reused",
			},
		],
		customerDocs: [],
		...overrides,
	};
}

describe("requirements matrix shape", () => {
	it("pins every required kind to the T01 kind set", () => {
		const known = new Set([
			"id",
			"business_registration",
			"bank_statement",
			"payslip",
			"financial_statements",
			"other",
		]);
		expect(REQUIRED_DOCS.personal_loan).toEqual(["id", "payslip", "bank_statement"]);
		expect(REQUIRED_DOCS.sme_term_loan).toEqual([
			"id",
			"business_registration",
			"financial_statements",
			"bank_statement",
		]);
		for (const kinds of Object.values(REQUIRED_DOCS)) {
			for (const kind of kinds) expect(known.has(kind)).toBe(true);
		}
	});
});

describe("fresh application", () => {
	it("is ready with the policy version and no blockers", () => {
		const result = requirementsFor(baseInput());
		expect(result.policyVersion).toBe(REQUIREMENTS_POLICY_VERSION);
		expect(result.readyToSubmit).toBe(true);
		expect(result.blockers).toEqual({});
		expect(result.requiredDocuments).toEqual([]);
		expect(result.kyc).toEqual({ status: "verified", expiresAt: "2027-06-30T00:00:00.000Z" });
	});
});

describe("statement freshness boundaries", () => {
	it("treats exactly-90d bank statements fresh and 91d stale", () => {
		expect(statementFreshness("bank_statement", day(90), AS_OF)).toBe("fresh");
		expect(statementFreshness("bank_statement", day(91), AS_OF)).toBe("stale");
	});

	it("treats 120d statements stale and future periods invalid", () => {
		expect(statementFreshness("bank_statement", day(120), AS_OF)).toBe("stale");
		expect(statementFreshness("bank_statement", null, AS_OF)).toBe("unknown");
		expect(statementFreshness("bank_statement", "2026-07-01", AS_OF)).toBe("invalid");
	});

	it("treats 24m financial statements stale and 6m fresh", () => {
		expect(statementFreshness("financial_statements", "2024-06-30", AS_OF)).toBe("stale");
		expect(statementFreshness("financial_statements", "2025-12-31", AS_OF)).toBe("fresh");
		expect(statementFreshness("financial_statements", null, AS_OF)).toBe("unknown");
	});

	it("treats exactly-18m financial statements fresh and a day older stale", () => {
		// AS_OF 2026-06-30 minus 18 months is 2024-12-30 (day-precision).
		expect(statementFreshness("financial_statements", "2024-12-30", AS_OF)).toBe("fresh");
		expect(statementFreshness("financial_statements", "2024-12-29", AS_OF)).toBe("stale");
	});

	it("applies no age rule to id/business_registration/payslip", () => {
		for (const kind of ["id", "business_registration", "payslip"]) {
			expect(statementFreshness(kind, null, AS_OF)).toBe("na");
			expect(statementFreshness(kind, day(900), AS_OF)).toBe("na");
		}
	});
});

describe("document blockers", () => {
	it("marks a 120d bank statement stale with a typed blocker", () => {
		const result = requirementsFor(
			baseInput({
				appDocs: [
					{ kind: "id", status: "ready", periodEnd: null, documentDate: null, uploadedAt: AS_OF },
					{
						kind: "payslip",
						status: "ready",
						periodEnd: null,
						documentDate: null,
						uploadedAt: AS_OF,
					},
					{
						kind: "bank_statement",
						status: "ready",
						periodEnd: day(120),
						documentDate: day(120),
						uploadedAt: AS_OF,
						documentDateSource: "reused",
					},
				],
			}),
		);
		expect(result.readyToSubmit).toBe(false);
		expect(result.blockers["document:bank_statement"]).toEqual(["stale"]);
		expect(result.requiredDocuments).toEqual([{ kind: "bank_statement", reason: "stale" }]);
	});

	it("blocks a fresh server_ocr upload as unknown_date (never hard-fresh)", () => {
		const result = requirementsFor(
			baseInput({
				appDocs: [
					{ kind: "id", status: "ready", periodEnd: null, documentDate: null, uploadedAt: AS_OF },
					{
						kind: "payslip",
						status: "ready",
						periodEnd: null,
						documentDate: null,
						uploadedAt: AS_OF,
					},
					{
						kind: "bank_statement",
						status: "ready",
						periodEnd: day(10),
						documentDate: day(10),
						uploadedAt: AS_OF,
						documentDateSource: "server_ocr",
					},
				],
			}),
		);
		expect(result.readyToSubmit).toBe(false);
		expect(result.blockers["document:bank_statement"]).toEqual(["unknown_date"]);
		expect(result.requiredDocuments).toEqual([{ kind: "bank_statement", reason: "unknown_date" }]);
	});

	it("passes a fresh reused statement_import date; blocks a missing source", () => {
		const trusted = requirementsFor(
			baseInput({
				appDocs: [
					{ kind: "id", status: "ready", periodEnd: null, documentDate: null, uploadedAt: AS_OF },
					{
						kind: "payslip",
						status: "ready",
						periodEnd: null,
						documentDate: null,
						uploadedAt: AS_OF,
					},
					{
						kind: "bank_statement",
						status: "ready",
						periodEnd: day(10),
						documentDate: day(10),
						uploadedAt: AS_OF,
						documentDateSource: "statement_import",
					},
				],
			}),
		);
		expect(trusted.readyToSubmit).toBe(true);
		expect(trusted.blockers).toEqual({});

		const unsourced = requirementsFor(
			baseInput({
				appDocs: [
					{ kind: "id", status: "ready", periodEnd: null, documentDate: null, uploadedAt: AS_OF },
					{
						kind: "payslip",
						status: "ready",
						periodEnd: null,
						documentDate: null,
						uploadedAt: AS_OF,
					},
					{
						kind: "bank_statement",
						status: "ready",
						periodEnd: day(10),
						documentDate: day(10),
						uploadedAt: AS_OF,
					},
				],
			}),
		);
		expect(unsourced.readyToSubmit).toBe(false);
		expect(unsourced.blockers["document:bank_statement"]).toEqual(["unknown_date"]);
	});

	it("marks unknown-date statements unknown_date and missing kinds missing", () => {
		const result = requirementsFor(
			baseInput({
				appDocs: [
					{
						kind: "bank_statement",
						status: "ready",
						periodEnd: null,
						documentDate: null,
						uploadedAt: AS_OF,
					},
				],
			}),
		);
		expect(result.readyToSubmit).toBe(false);
		expect(result.blockers["document:bank_statement"]).toEqual(["unknown_date"]);
		expect(result.blockers["document:id"]).toEqual(["missing"]);
		expect(result.blockers["document:payslip"]).toEqual(["missing"]);
	});

	it("marks rejected-only kinds rejected", () => {
		const result = requirementsFor(
			baseInput({
				appDocs: [
					{
						kind: "id",
						status: "rejected",
						periodEnd: null,
						documentDate: null,
						uploadedAt: AS_OF,
					},
				],
			}),
		);
		expect(result.blockers["document:id"]).toEqual(["rejected"]);
	});

	it("lets a newer fresh copy supersede a stale one (warning, not blocker)", () => {
		const result = requirementsFor(
			baseInput({
				appDocs: [
					{ kind: "id", status: "ready", periodEnd: null, documentDate: null, uploadedAt: AS_OF },
					{
						kind: "payslip",
						status: "ready",
						periodEnd: null,
						documentDate: null,
						uploadedAt: AS_OF,
					},
					{
						kind: "bank_statement",
						status: "ready",
						periodEnd: day(120),
						documentDate: day(120),
						uploadedAt: new Date("2026-02-01T00:00:00Z"),
						id: "00000000-0000-0000-0000-000000000001",
						documentDateSource: "reused",
					},
					{
						kind: "bank_statement",
						status: "ready",
						periodEnd: day(10),
						documentDate: day(10),
						uploadedAt: new Date("2026-06-01T00:00:00Z"),
						id: "00000000-0000-0000-0000-000000000002",
						documentDateSource: "reused",
					},
				],
			}),
		);
		expect(result.readyToSubmit).toBe(true);
		expect(result.warnings).toContainEqual({ code: "superseded_stale", kind: "bank_statement" });
	});

	it("blocks when every copy is stale (latest = least stale, still stale)", () => {
		const result = requirementsFor(
			baseInput({
				appDocs: [
					{ kind: "id", status: "ready", periodEnd: null, documentDate: null, uploadedAt: AS_OF },
					{
						kind: "payslip",
						status: "ready",
						periodEnd: null,
						documentDate: null,
						uploadedAt: AS_OF,
					},
					{
						kind: "bank_statement",
						status: "ready",
						periodEnd: day(120),
						documentDate: day(120),
						uploadedAt: new Date("2026-06-01T00:00:00Z"),
						id: "00000000-0000-0000-0000-000000000002",
						documentDateSource: "reused",
					},
					{
						kind: "bank_statement",
						status: "ready",
						periodEnd: day(100),
						documentDate: day(100),
						uploadedAt: new Date("2026-06-02T00:00:00Z"),
						id: "00000000-0000-0000-0000-000000000003",
						documentDateSource: "reused",
					},
				],
			}),
		);
		expect(result.readyToSubmit).toBe(false);
		expect(result.blockers["document:bank_statement"]).toEqual(["stale"]);
		// No fresh copy exists, so nothing is superseded — both stay blockers.
		expect(result.warnings.filter((w) => w.code.startsWith("superseded"))).toEqual([]);
	});

	it("prefers a dated copy over an undated one regardless of upload order", () => {
		const result = requirementsFor(
			baseInput({
				appDocs: [
					{ kind: "id", status: "ready", periodEnd: null, documentDate: null, uploadedAt: AS_OF },
					{
						kind: "payslip",
						status: "ready",
						periodEnd: null,
						documentDate: null,
						uploadedAt: AS_OF,
					},
					{
						kind: "bank_statement",
						status: "ready",
						periodEnd: null,
						documentDate: null,
						uploadedAt: new Date("2026-06-29T00:00:00Z"),
						id: "00000000-0000-0000-0000-000000000009",
					},
					{
						kind: "bank_statement",
						status: "ready",
						periodEnd: day(10),
						documentDate: day(10),
						uploadedAt: new Date("2026-06-01T00:00:00Z"),
						id: "00000000-0000-0000-0000-000000000002",
						documentDateSource: "reused",
					},
				],
			}),
		);
		expect(result.readyToSubmit).toBe(true);
		expect(result.warnings).toContainEqual({ code: "superseded_unknown", kind: "bank_statement" });
	});

	it("warns (not blocks) on unknown-date id documents", () => {
		const result = requirementsFor(baseInput());
		expect(result.readyToSubmit).toBe(true);
		expect(result.warnings).toContainEqual({ code: "unknown_date", kind: "id" });
	});
});

describe("KYC and identity", () => {
	it("blocks expired KYC and missing KYC distinctly", () => {
		const expired = requirementsFor(
			baseInput({
				profile: {
					kycStatus: "expired",
					kycExpiresAt: new Date("2026-01-01T00:00:00Z"),
					identity: { ...IDENTITY },
					business: null,
				},
			}),
		);
		expect(expired.readyToSubmit).toBe(false);
		expect(expired.blockers["field:kyc"]).toEqual(["expired"]);

		const missing = requirementsFor(
			baseInput({
				profile: {
					kycStatus: "not_started",
					kycExpiresAt: null,
					identity: { ...IDENTITY },
					business: null,
				},
			}),
		);
		expect(missing.blockers["field:kyc"]).toEqual(["missing"]);
	});

	it("blocks identity mismatch even with valid KYC", () => {
		const mismatch = requirementsFor(
			baseInput({
				application: {
					identity: { ...IDENTITY, nationalId: "DIFFERENT1" },
					sme: null,
					consents: [true, true, true],
					documentProcessingConsent: true,
				},
			}),
		);
		expect(mismatch.readyToSubmit).toBe(false);
		expect(mismatch.blockers["field:kyc"]).toEqual(["identity_mismatch"]);
	});

	it("skips KYC with no profile", () => {
		const result = requirementsFor(baseInput({ profile: null }));
		expect(result.readyToSubmit).toBe(true);
		expect(result.kyc).toEqual({ status: null, expiresAt: null });
	});

	it("matches identity on name+dob+nationalId only", () => {
		expect(identityMatchesProfile({ ...IDENTITY }, { ...IDENTITY })).toBe(true);
		expect(identityMatchesProfile({ ...IDENTITY, city: "Elsewhere" }, { ...IDENTITY })).toBe(true);
		expect(identityMatchesProfile({ ...IDENTITY, dob: "2000-01-01" }, { ...IDENTITY })).toBe(false);
	});
});

describe("consents", () => {
	it("blocks missing base or document-processing consent with reason codes", () => {
		const noBase = requirementsFor(
			baseInput({
				application: {
					identity: { ...IDENTITY },
					sme: null,
					consents: [true, false, true],
					documentProcessingConsent: true,
				},
			}),
		);
		expect(noBase.readyToSubmit).toBe(false);
		expect(noBase.blockers["field:consents"]).toEqual(["consent"]);

		const noDoc = requirementsFor(
			baseInput({
				application: {
					identity: { ...IDENTITY },
					sme: null,
					consents: [true, true, true],
					documentProcessingConsent: false,
				},
			}),
		);
		expect(noDoc.readyToSubmit).toBe(false);
		expect(noDoc.blockers["field:documentProcessingConsent"]).toEqual(["consent"]);
	});
});

describe("reusable evidence", () => {
	it("lists fresh customer docs as reusable", () => {
		const customerDocs: RequirementsInput["customerDocs"] = [
			{
				id: "c-doc-1",
				kind: "bank_statement",
				status: "ready",
				scanStatus: "clean",
				retentionUntil: new Date("2027-01-01T00:00:00Z"),
				blobPurgedAt: null,
				periodEnd: day(20),
				documentDate: day(20),
			},
			{
				id: "c-doc-2",
				kind: "id",
				status: "ready",
				scanStatus: "clean",
				retentionUntil: new Date("2027-01-01T00:00:00Z"),
				blobPurgedAt: null,
				periodEnd: null,
				documentDate: null,
			},
		];
		const result = requirementsFor(baseInput({ customerDocs }));
		expect(result.reusableDocuments).toHaveLength(2);
	});

	it("excludes stale/rejected/expired customer docs", () => {
		const mk = (over: Partial<RequirementsInput["customerDocs"][number]>) => ({
			id: "c-doc-x",
			kind: "bank_statement",
			status: "ready",
			scanStatus: "clean",
			retentionUntil: new Date("2027-01-01T00:00:00Z"),
			blobPurgedAt: null,
			periodEnd: day(20),
			documentDate: day(20),
			...over,
		});
		expect(classifyCustomerDoc(mk({ periodEnd: day(120), documentDate: day(120) }), AS_OF)).toEqual(
			{
				eligible: false,
				reason: "stale",
			},
		);
		expect(classifyCustomerDoc(mk({ status: "rejected" }), AS_OF).eligible).toBe(false);
		expect(classifyCustomerDoc(mk({ scanStatus: "rejected" }), AS_OF).eligible).toBe(false);
		expect(
			classifyCustomerDoc(mk({ retentionUntil: new Date("2026-01-01T00:00:00Z") }), AS_OF),
		).toEqual({ eligible: false, reason: "expired" });
		// A purged blob is expired even with a future retentionUntil.
		expect(
			classifyCustomerDoc(
				mk({ retentionUntil: new Date("2027-01-01T00:00:00Z"), blobPurgedAt: new Date() }),
				AS_OF,
			),
		).toEqual({ eligible: false, reason: "expired" });
		expect(classifyCustomerDoc(mk({ periodEnd: null, documentDate: null }), AS_OF)).toEqual({
			eligible: false,
			reason: "unknown_date",
		});
	});
});

describe("effectiveAsOf", () => {
	it("keys fixture rows to DEMO_AS_OF and live rows to wall clock", () => {
		const demoAsOf = new Date("2026-06-30T00:00:00Z");
		const now = new Date("2026-10-22T00:00:00Z");
		expect(
			effectiveAsOf({ appSource: "demo_case", profileSource: null, demoMode: true, demoAsOf, now }),
		).toEqual(demoAsOf);
		expect(
			effectiveAsOf({
				appSource: null,
				profileSource: "demo_seed",
				demoMode: true,
				demoAsOf,
				now,
			}),
		).toEqual(demoAsOf);
		expect(
			effectiveAsOf({
				appSource: "live",
				profileSource: "demo_seed",
				demoMode: true,
				demoAsOf,
				now,
			}),
		).toEqual(now);
		expect(
			effectiveAsOf({
				appSource: null,
				profileSource: "demo_seed",
				demoMode: false,
				demoAsOf,
				now,
			}),
		).toEqual(now);
	});
});
