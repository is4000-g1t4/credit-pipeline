// Events: envelope builder + zod schemas. Valid payloads pass; any payload
// carrying PII (nationalId/dob/email/phone/address/income/revenue) FAILS.
import { describe, expect, it } from "vitest";
import {
	buildEnvelope,
	dedupeApplicationSubmitted,
	dedupeDecisionMade,
	dedupeEwsAlert,
	dedupeLoanBooked,
	dedupePaymentPosted,
	dedupeReviewExpired,
	dedupeReviewRequested,
	eventEnvelopeSchema,
	eventPayloadSchemas,
	TOPICS,
} from "../src/index.js";

const NOW = "2026-10-19T12:00:00.000Z";

const VALID_PAYLOADS = {
	"application.submitted": {
		applicationId: "app-1",
		reference: "APP-2026-ABCDEF",
		type: "individual",
		product: "personal_loan",
		amountCents: 1200000,
		termMonths: 48,
	},
	"decision.made": {
		decisionId: "dec-1",
		applicationId: "app-1",
		outcome: "approved",
		decidedBy: "system",
		reasonCodes: [],
		approvedAmountCents: 1200000,
		termMonths: 48,
		rateBps: 650,
	},
	"review.requested": {
		applicationId: "app-1",
		reference: "APP-2026-ABCDEF",
		reasonCodes: ["SCORE_IN_REFER_BAND"],
	},
	"review.expired": { applicationId: "app-1", reference: "APP-2026-ABCDEF" },
	"loan.booked": {
		loanId: "loan-1",
		applicationId: "app-1",
		principalCents: 1200000,
		termMonths: 48,
		rateBps: 650,
		monthlyPaymentCents: 28458,
	},
	"payment.posted": {
		paymentId: "pay-1",
		loanId: "loan-1",
		installmentId: "inst-1",
		amountCents: 28458,
	},
	"ews.alert": {
		alertId: "alert-1",
		loanId: "loan-1",
		installmentId: "inst-2",
		alertType: "payment_overdue",
		severity: "medium",
	},
} as const;

const PII_PROBES = {
	nationalId: "AB12345678",
	dob: "1990-01-01",
	email: "maria@example.com",
	phone: "+1-555-0100",
	address: "123 Main St",
	income: 420000,
	revenue: 61000000,
};

describe("events", () => {
	it("topics cover all 7 FR-10.1 names", () => {
		expect(Object.values(TOPICS)).toEqual([
			"credit.application.submitted",
			"credit.decision.made",
			"credit.review.requested",
			"credit.review.expired",
			"credit.loan.booked",
			"credit.payment.posted",
			"credit.ews.alert",
		]);
	});

	it("every valid payload passes its schema and the full envelope", () => {
		for (const [type, payload] of Object.entries(VALID_PAYLOADS)) {
			const t = type as keyof typeof VALID_PAYLOADS;
			expect(eventPayloadSchemas[t].safeParse(payload).success).toBe(true);
			const envelope = buildEnvelope({
				type: t,
				payload,
				occurredAt: NOW,
				applicationId: "app-1",
				id: "00000000-0000-4000-8000-000000000001",
			});
			expect(envelope.version).toBe(1);
			expect(eventEnvelopeSchema.safeParse(envelope).success).toBe(true);
		}
	});

	it("payloads containing PII fields FAIL validation", () => {
		for (const [type, payload] of Object.entries(VALID_PAYLOADS)) {
			const t = type as keyof typeof VALID_PAYLOADS;
			for (const [key, value] of Object.entries(PII_PROBES)) {
				const tainted = { ...payload, [key]: value };
				expect(eventPayloadSchemas[t].safeParse(tainted).success, `${t} accepted ${key}`).toBe(
					false,
				);
			}
		}
	});

	it("envelope rejects bad version / timestamp / unknown type", () => {
		const base = buildEnvelope({
			type: "application.submitted",
			payload: VALID_PAYLOADS["application.submitted"],
			occurredAt: NOW,
		});
		expect(eventEnvelopeSchema.safeParse({ ...base, version: 2 }).success).toBe(false);
		expect(eventEnvelopeSchema.safeParse({ ...base, occurredAt: "yesterday" }).success).toBe(false);
		expect(eventEnvelopeSchema.safeParse({ ...base, type: "application.deleted" }).success).toBe(
			false,
		);
	});

	it("dedupe keys match FR-10.3 exactly", () => {
		expect(dedupeApplicationSubmitted("a")).toBe("application.submitted:a");
		expect(dedupeReviewRequested("a")).toBe("review.requested:a");
		expect(dedupeDecisionMade("d")).toBe("decision.made:d");
		expect(dedupeReviewExpired("a")).toBe("review.expired:a");
		expect(dedupeLoanBooked("l")).toBe("loan.booked:l");
		expect(dedupePaymentPosted("p")).toBe("payment.posted:p");
		expect(dedupeEwsAlert("e")).toBe("ews.alert:e");
	});
});
