// feedMessageForEnvelope unit test (compose-free): every event type renders
// from allowlisted fields only — no DB, no Kafka.
import type { EventEnvelope } from "@credit/core";
import { describe, expect, it } from "vitest";
import { feedMessageForEnvelope } from "../src/events/projection.js";

function envelope(type: EventEnvelope["type"], payload: Record<string, unknown>): EventEnvelope {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		type,
		version: 1,
		occurredAt: new Date("2026-10-27T00:00:00.000Z").toISOString(),
		payload,
	} as EventEnvelope;
}

describe("feedMessageForEnvelope", () => {
	it("renders every event type from allowlisted fields", () => {
		expect(
			feedMessageForEnvelope(
				envelope("application.submitted", {
					reference: "APP-1",
					type: "individual",
					product: "personal_loan",
				}),
			),
		).toBe("Application APP-1 submitted (individual, personal_loan)");
		expect(
			feedMessageForEnvelope(
				envelope("decision.made", {
					outcome: "approved",
					decidedBy: "officer-1",
					reasonCodes: ["OFFICER_JUDGEMENT"],
				}),
			),
		).toContain("Decision approved by officer-1:");
		expect(
			feedMessageForEnvelope(
				envelope("review.requested", { reference: "APP-1", reasonCodes: [] }),
			),
		).toBe("Review requested for APP-1: ");
		expect(feedMessageForEnvelope(envelope("review.expired", { reference: "APP-1" }))).toBe(
			"Review expired for APP-1",
		);
		expect(
			feedMessageForEnvelope(
				envelope("loan.booked", { principalCents: 100000, termMonths: 12, rateBps: 650 }),
			),
		).toBe("Loan booked: 100000c over 12m at 650bps");
		expect(feedMessageForEnvelope(envelope("payment.posted", { amountCents: 500 }))).toBe(
			"Payment of 500c posted",
		);
		expect(
			feedMessageForEnvelope(envelope("ews.alert", { alertType: "missed_payment", severity: "high" })),
		).toBe("Alert missed_payment (high)");
	});

	it("throws on an unknown event type", () => {
		expect(() =>
			feedMessageForEnvelope(envelope("application.submitted", {})),
		).not.toThrow();
		expect(() =>
			feedMessageForEnvelope({ ...envelope("application.submitted", {}), type: "nope" } as unknown as EventEnvelope),
		).toThrow("unknown event type");
	});
});
