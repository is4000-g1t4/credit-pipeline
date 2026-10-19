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

export const applicationCreateSchema = z
	.object({
		type: applicationTypeSchema,
		product: productSchema,
		amountCents: centsSchema,
		termMonths: z.number().int().min(TERM_MIN_MONTHS).max(TERM_MAX_MONTHS),
		purpose: z.string().min(1).max(500),
		consents: consentsSchema,
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

export const officerDecisionSchema = z
	.object({
		requestId: z.uuid(),
		outcome: z.enum(["approve", "decline"]),
		approvedAmountCents: centsSchema.positive().optional(),
		termMonths: z.number().int().min(TERM_MIN_MONTHS).max(TERM_MAX_MONTHS).optional(),
		reasonCode: z
			.enum(["OFFICER_JUDGEMENT", "INSUFFICIENT_EVIDENCE", "POLICY_EXCEPTION"])
			.optional(),
		notes: z.string().max(2000).optional(),
	})
	.strict()
	.superRefine((d, ctx) => {
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
	});

export const apiErrorSchema = z
	.object({
		error: z
			.object({
				code: z.string().min(1),
				message: z.string().min(1),
				fields: z.record(z.string(), z.array(z.string())).optional(),
			})
			.strict(),
	})
	.strict();

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
