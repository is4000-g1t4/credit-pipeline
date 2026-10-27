// Boundary validation (SPEC FR-1, FR-6.2, FR-10.2). Event payload schemas are
// `.strict()` so allowlisted fields only — any PII key fails (AC-18).
// Age ("18+") needs a clock, so dob is format-checked here and age-checked
// via the pure `ageInYears(dobISO, now)` helper (W4 passes request time).
import { z } from "zod";
import {
	MIN_MONTHLY_INCOME_CENTS,
	PERSONAL_MAX_CENTS,
	PERSONAL_MIN_CENTS,
	SME_MAX_CENTS,
	SME_MIN_CENTS,
	TERM_MAX_MONTHS,
	TERM_MIN_MONTHS,
} from "./constants.js";
import { OFFICER_REASON_CODES } from "./reasons.js";

export const applicationTypeSchema = z.enum(["individual", "sme"]);
export const productSchema = z.enum(["personal_loan", "sme_term_loan"]);
export const industrySchema = z.enum([
	"hospitality",
	"retail",
	"services",
	"construction",
	"other",
]);
export const employmentStatusSchema = z.enum(["employed", "self_employed", "retired", "student"]);

const centsSchema = z.number().int("must be integer cents");

export const identitySchema = z
	.object({
		fullName: z.string().min(1).max(200),
		dob: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
			.refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "must be a valid date"),
		nationalId: z.string().regex(/^[A-Za-z0-9]{8,20}$/, "must be 8–20 alphanumeric characters"),
		email: z.string().email().max(320),
		phone: z.string().min(1).max(40),
		address: z.string().min(1).max(500),
		city: z.string().min(2).max(80),
	})
	.strict();

/** Whole years of age at `now` (UTC); pure — inject the clock. */
export function ageInYears(dobISO: string, now: Date): number {
	const dob = new Date(`${dobISO}T00:00:00Z`);
	let age = now.getUTCFullYear() - dob.getUTCFullYear();
	const month = now.getUTCMonth() - dob.getUTCMonth();
	if (month < 0 || (month === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
	return age;
}

export function isAdult(dobISO: string, now: Date): boolean {
	return ageInYears(dobISO, now) >= 18;
}

export const individualBlockSchema = z
	.object({
		employmentStatus: employmentStatusSchema,
		employerName: z.string().max(200).optional(),
		employmentYears: z.number().min(0).max(60),
		monthlyIncomeCents: centsSchema.min(MIN_MONTHLY_INCOME_CENTS),
		existingDebtCents: centsSchema.min(0),
		bankRelationshipYears: z.number().min(0).max(60),
	})
	.strict()
	.refine(
		(b) =>
			b.employmentStatus === "employed" || b.employmentStatus === "self_employed"
				? (b.employerName?.trim().length ?? 0) > 0
				: true,
		{
			message: "employerName is required when employed/self-employed",
			path: ["employerName"],
		},
	);

export const smeBlockSchema = z
	.object({
		companyName: z.string().min(1).max(200),
		registrationNumber: z
			.string()
			.regex(/^[A-Za-z0-9]{6,20}$/, "must be 6–20 alphanumeric characters"),
		industry: industrySchema,
		yearsTrading: z.number().min(0).max(100),
		employees: z.number().int().min(0).max(10000),
		annualRevenueCents: centsSchema.min(0),
		monthlyFcfCents: centsSchema.min(0),
		existingDebtServiceCents: centsSchema.min(0),
		collateral: z
			.object({
				hasCollateral: z.boolean(),
				valueCents: centsSchema.min(0).optional(),
			})
			.strict()
			.optional(),
	})
	.strict()
	.refine((b) => BigInt(b.monthlyFcfCents) * 12n <= BigInt(b.annualRevenueCents), {
		message: "monthlyFcfCents must not exceed annualRevenueCents / 12",
		path: ["monthlyFcfCents"],
	});

export const consentsSchema = z
	.array(z.boolean())
	.length(3)
	.refine((c) => c.every(Boolean), { message: "all 3 consents are required" });

/** Document-processing policy version recorded with consent (T01/D0). */
export const DOCUMENT_CONSENT_VERSION = "document-consent-v1";

/** Context-analysis policy version recorded with consent (T17/D0). */
export const CONTEXT_CONSENT_VERSION = "context-consent-v1";

// T17 prefill confirmations: client hashes are advisory only — the server
// derives reused vs edited by comparing canonical values (D1). Strict, max
// 20; unknown fields fail at the allowlist (D1).
export const profileConfirmationSchema = z
	.object({
		field: z.string().min(1).max(100),
		valueHash: z.string().min(1).max(200),
	})
	.strict();

export const applicationCreateSchema = z
	.object({
		type: applicationTypeSchema,
		product: productSchema,
		amountCents: centsSchema,
		termMonths: z.number().int().min(TERM_MIN_MONTHS).max(TERM_MAX_MONTHS),
		purpose: z.string().min(1).max(500),
		consents: consentsSchema,
		aiResearchConsent: z.boolean().default(false),
		documentProcessingConsent: z.boolean().default(false),
		contextAnalysisConsent: z.boolean().optional(),
		profileConfirmations: z.array(profileConfirmationSchema).max(20).optional(),
		identity: identitySchema,
		individual: individualBlockSchema.optional(),
		sme: smeBlockSchema.optional(),
	})
	.strict()
	.superRefine((app, ctx) => {
		if (app.type === "individual" && app.product !== "personal_loan") {
			ctx.addIssue({
				code: "custom",
				message: "individual requires personal_loan",
				path: ["product"],
			});
		}
		if (app.type === "sme" && app.product !== "sme_term_loan") {
			ctx.addIssue({
				code: "custom",
				message: "sme requires sme_term_loan",
				path: ["product"],
			});
		}
		const [min, max] =
			app.product === "personal_loan"
				? [PERSONAL_MIN_CENTS, PERSONAL_MAX_CENTS]
				: [SME_MIN_CENTS, SME_MAX_CENTS];
		if (app.amountCents < min || app.amountCents > max) {
			ctx.addIssue({
				code: "custom",
				message: `amountCents outside ${min}–${max} for ${app.product}`,
				path: ["amountCents"],
			});
		}
		if (app.type === "individual" && !app.individual) {
			ctx.addIssue({
				code: "custom",
				message: "individual block is required",
				path: ["individual"],
			});
		}
		if (app.type === "sme" && !app.sme) {
			ctx.addIssue({
				code: "custom",
				message: "sme block is required",
				path: ["sme"],
			});
		}
	});

const officerDecisionBase = z
	.object({
		requestId: z.uuid(),
		outcome: z.enum(["approve", "decline"]),
		approvedAmountCents: centsSchema.positive().optional(),
		termMonths: z.number().int().min(TERM_MIN_MONTHS).max(TERM_MAX_MONTHS).optional(),
		reasonCode: z.enum(OFFICER_REASON_CODES).optional(),
		notes: z.string().max(2000).optional(),
	})
	.strict();

function refineDeclineFields(d: z.infer<typeof officerDecisionBase>, ctx: z.RefinementCtx): void {
	if (d.outcome === "decline") {
		if (!d.reasonCode) {
			ctx.addIssue({
				code: "custom",
				message: "reasonCode is required to decline",
				path: ["reasonCode"],
			});
		}
		if (!d.notes || d.notes.trim().length === 0) {
			ctx.addIssue({
				code: "custom",
				message: "notes are required to decline",
				path: ["notes"],
			});
		}
	}
}

/** Public officer-decision payload. The research selection (`agentRunId` +
 * `acceptedFindingIds`) lives only here: review resolves it server-side to
 * the frozen bundle and forwards internal `research`. Frozen research is
 * deliberately rejected. */
export const officerDecisionSchema = officerDecisionBase
	.extend({
		agentRunId: z.uuid().optional(),
		acceptedFindingIds: z.array(z.uuid()).min(1).max(50).optional(),
	})
	.strict()
	.superRefine((d, ctx) => {
		if ((d.agentRunId === undefined) !== (d.acceptedFindingIds === undefined)) {
			ctx.addIssue({
				code: "custom",
				message: "agentRunId and acceptedFindingIds must be provided together",
				path: ["agentRunId"],
			});
		}
		refineDeclineFields(d, ctx);
	});

/** Server-built research bundle copied into the decision snapshot. */
export const researchEvidenceSchema = z
	.object({
		url: z.string().url(),
		quote: z.string().min(1),
		snapshotHash: z.string().min(1),
	})
	.strict();

export const researchFindingSchema = z
	.object({
		findingId: z.uuid(),
		claim: z.string().min(1),
		category: z.string().min(1),
		entityMatch: z.unknown(),
		evidence: z.array(researchEvidenceSchema).min(1),
	})
	.strict();

export const researchBundleSchema = z
	.object({
		agentRunId: z.uuid(),
		applicationId: z.uuid(),
		briefHash: z.string().min(1),
		viewedAt: z.string().nullable(),
		acceptedFindings: z.array(researchFindingSchema).min(1),
	})
	.strict();

export type ResearchBundle = z.infer<typeof researchBundleSchema>;

/** Internal workflow update: public fields plus the server-built bundle.
 * The research selection never travels here — review strips it after
 * resolving the frozen bundle. */
export const internalOfficerDecisionSchema = officerDecisionBase
	.extend({
		research: researchBundleSchema.optional(),
		// The gateway/review authenticate the officer; the worker persists
		// this id on the decision row, so validate it at the update boundary.
		officerUserId: z.uuid().optional(),
	})
	.strict()
	.superRefine(refineDeclineFields);

// --- Case facts (SPEC §3.1): single source of truth (16 keys). ---
// Applications builds it, review allowlists it, research validates + stores
// it (minus consent). Strict: new keys fail loudly, never silently dropped.

export const caseFactsSchema = z
	.object({
		applicationId: z.uuid(),
		reference: z.string().min(1).max(100),
		type: z.string().min(1).max(100),
		product: z.string().min(1).max(100),
		amountCents: z.number().int().nonnegative(),
		termMonths: z.number().int().positive(),
		submittedAt: z.string().min(1),
		asOf: z.string().min(1),
		applicantName: z.string().min(1).max(300),
		companyName: z.string().max(300).nullable(),
		registrationNumber: z.string().max(100).nullable(),
		industry: z.string().max(200).nullable(),
		yearsTrading: z.number().nullable(),
		city: z.string().max(80).nullable(),
		aiResearchConsent: z.boolean(),
		status: z.string().min(1).max(100),
	})
	.strict();

export type CaseFacts = z.infer<typeof caseFactsSchema>;

// --- Events (SPEC FR-10.1/10.2): payload allowlist only. ---

export const eventTypeSchema = z.enum([
	"application.submitted",
	"decision.made",
	"review.requested",
	"review.expired",
	"loan.booked",
	"payment.posted",
	"ews.alert",
]);
export type EventType = z.infer<typeof eventTypeSchema>;

const applicationSubmittedPayload = z
	.object({
		applicationId: z.string().min(1),
		reference: z.string().min(1),
		type: applicationTypeSchema,
		product: productSchema,
		amountCents: centsSchema,
		termMonths: z.number().int(),
	})
	.strict();

const decisionMadePayload = z
	.object({
		decisionId: z.string().min(1),
		applicationId: z.string().min(1),
		outcome: z.enum(["approved", "declined"]),
		decidedBy: z.enum(["system", "officer"]),
		reasonCodes: z.array(z.string().min(1)),
		approvedAmountCents: centsSchema.optional(),
		termMonths: z.number().int().optional(),
		rateBps: z.number().int().optional(),
	})
	.strict();

const reviewRequestedPayload = z
	.object({
		applicationId: z.string().min(1),
		reference: z.string().min(1),
		reasonCodes: z.array(z.string().min(1)),
	})
	.strict();

const reviewExpiredPayload = z
	.object({
		applicationId: z.string().min(1),
		reference: z.string().min(1),
	})
	.strict();

const loanBookedPayload = z
	.object({
		loanId: z.string().min(1),
		applicationId: z.string().min(1),
		principalCents: centsSchema,
		termMonths: z.number().int(),
		rateBps: z.number().int(),
		monthlyPaymentCents: centsSchema,
	})
	.strict();

const paymentPostedPayload = z
	.object({
		paymentId: z.string().min(1),
		loanId: z.string().min(1),
		installmentId: z.string().min(1),
		amountCents: centsSchema,
	})
	.strict();

const ewsAlertPayload = z
	.object({
		alertId: z.string().min(1),
		loanId: z.string().min(1),
		installmentId: z.string().min(1).optional(),
		alertType: z.string().min(1),
		severity: z.enum(["low", "medium", "high"]),
	})
	.strict();

function envelopeOf<T extends EventType>(type: T, payload: z.ZodType) {
	return z
		.object({
			id: z.uuid(),
			type: z.literal(type),
			version: z.literal(1),
			occurredAt: z.iso.datetime(),
			applicationId: z.string().min(1).optional(),
			loanId: z.string().min(1).optional(),
			payload,
		})
		.strict();
}

export const eventEnvelopeSchema = z.discriminatedUnion("type", [
	envelopeOf("application.submitted", applicationSubmittedPayload),
	envelopeOf("decision.made", decisionMadePayload),
	envelopeOf("review.requested", reviewRequestedPayload),
	envelopeOf("review.expired", reviewExpiredPayload),
	envelopeOf("loan.booked", loanBookedPayload),
	envelopeOf("payment.posted", paymentPostedPayload),
	envelopeOf("ews.alert", ewsAlertPayload),
]);

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

export const eventPayloadSchemas = {
	"application.submitted": applicationSubmittedPayload,
	"decision.made": decisionMadePayload,
	"review.requested": reviewRequestedPayload,
	"review.expired": reviewExpiredPayload,
	"loan.booked": loanBookedPayload,
	"payment.posted": paymentPostedPayload,
	"ews.alert": ewsAlertPayload,
} as const;
