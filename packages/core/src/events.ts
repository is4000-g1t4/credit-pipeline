// Event topics, envelope builder, and outbox dedupe keys (SPEC FR-10.1/10.3).
import { randomUUID } from "node:crypto";
import type { EventType } from "./schemas.js";

export const TOPICS = {
	"application.submitted": "credit.application.submitted",
	"decision.made": "credit.decision.made",
	"review.requested": "credit.review.requested",
	"review.expired": "credit.review.expired",
	"loan.booked": "credit.loan.booked",
	"payment.posted": "credit.payment.posted",
	"ews.alert": "credit.ews.alert",
} as const satisfies Record<EventType, string>;

export type Topic = (typeof TOPICS)[EventType];

export interface EnvelopeArgs {
	type: EventType;
	payload: unknown;
	/** Injected clock value (ISO-8601 UTC) — core never calls Date.now(). */
	occurredAt: string;
	applicationId?: string;
	loanId?: string;
	id?: string;
}

export interface EventEnvelopeValue {
	id: string;
	type: EventType;
	version: 1;
	occurredAt: string;
	applicationId?: string;
	loanId?: string;
	payload: unknown;
}

export function buildEnvelope(args: EnvelopeArgs): EventEnvelopeValue {
	const envelope: EventEnvelopeValue = {
		id: args.id ?? randomUUID(),
		type: args.type,
		version: 1,
		occurredAt: args.occurredAt,
		payload: args.payload,
	};
	if (args.applicationId !== undefined) envelope.applicationId = args.applicationId;
	if (args.loanId !== undefined) envelope.loanId = args.loanId;
	return envelope;
}

// Dedupe keys (FR-10.3) — one builder per event.
export function dedupeApplicationSubmitted(applicationId: string): string {
	return `application.submitted:${applicationId}`;
}
export function dedupeReviewRequested(applicationId: string): string {
	return `review.requested:${applicationId}`;
}
export function dedupeDecisionMade(decisionId: string): string {
	return `decision.made:${decisionId}`;
}
export function dedupeReviewExpired(applicationId: string): string {
	return `review.expired:${applicationId}`;
}
export function dedupeLoanBooked(loanId: string): string {
	return `loan.booked:${loanId}`;
}
export function dedupePaymentPosted(paymentId: string): string {
	return `payment.posted:${paymentId}`;
}
export function dedupeEwsAlert(alertId: string): string {
	return `ews.alert:${alertId}`;
}
