// Projection (SPEC FR-10.4): exactly-once insert of processed_events and
// activity_feed (both ON CONFLICT DO NOTHING — a duplicate delivery writes
// nothing and still commits), plus dead-letter writes for poison messages.
// Feed text uses only the core reason-text map and allowlisted payload
// fields (AC-18 — no PII). Transient DB errors throw without resolving, so
// kafkajs redelivers. The Db is passed in; startConsumer supplies the
// production handle (getDb()).
import { type EventEnvelope, reasonText } from "@credit/core";
import { withTx, type Db } from "@credit/db";
import { activityFeed, deadLetterEvents, processedEvents } from "@credit/db/portfolio";
import { UUID_RE } from "@credit/service-kit";

function reasonList(codes: unknown): string {
	if (!Array.isArray(codes)) return "";
	return codes
		.map((c) => (typeof c === "string" ? reasonText(c) : ""))
		.filter(Boolean)
		.join("; ");
}

/** Human feed text from allowlisted fields only — never identity/finance. */
export function feedMessageForEnvelope(envelope: EventEnvelope): string {
	const p = envelope.payload as Record<string, unknown>;
	switch (envelope.type) {
		case "application.submitted":
			return `Application ${p.reference} submitted (${p.type}, ${p.product})`;
		case "decision.made":
			return `Decision ${p.outcome} by ${p.decidedBy}: ${reasonList(p.reasonCodes)}`;
		case "review.requested":
			return `Review requested for ${p.reference}: ${reasonList(p.reasonCodes)}`;
		case "review.expired":
			return `Review expired for ${p.reference}`;
		case "loan.booked":
			return `Loan booked: ${p.principalCents}c over ${p.termMonths}m at ${p.rateBps}bps`;
		case "payment.posted":
			return `Payment of ${p.amountCents}c posted`;
		case "ews.alert":
			return `Alert ${p.alertType} (${p.severity})`;
		default:
			throw new Error(`feedMessageForEnvelope: unknown event type`);
	}
}

/** Project one valid envelope: idempotent on redelivery. Non-UUID ids are
 * data poison (the strict schema can't see FKs — and there are none
 * cross-DB), so they dead-letter instead of throwing. */
export async function projectEnvelope(
	envelope: EventEnvelope,
	topic: string,
	db: Db,
): Promise<void> {
	for (const id of [envelope.applicationId, envelope.loanId]) {
		if (id !== undefined && !UUID_RE.test(id)) {
			throw new PoisonError(`envelope id is not a UUID: ${id}`);
		}
	}
	try {
		await withTx(db, async (tx) => {
			await tx
				.insert(processedEvents)
				.values({ eventId: envelope.id, topic })
				.onConflictDoNothing();
			await tx
				.insert(activityFeed)
				.values({
					eventId: envelope.id,
					applicationId: envelope.applicationId ?? null,
					loanId: envelope.loanId ?? null,
					type: envelope.type,
					message: feedMessageForEnvelope(envelope),
					payload: envelope.payload,
					occurredAt: new Date(envelope.occurredAt),
				})
				.onConflictDoNothing();
		});
	} catch (err) {
		if (isPermanentDbError(err)) {
			throw new PoisonError(
				`projection rejected: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		throw err;
	}
}

/** Poison that must dead-letter + commit, never redeliver-loop. */
export class PoisonError extends Error {}

function isPermanentDbError(err: unknown): boolean {
	// 22P02 bad UUID text. (Uniques can't fire: every projection insert is
	// ON CONFLICT DO NOTHING. No FKs exist in this DB by design.)
	const code = (err as { code?: string })?.code;
	return code === "22P02";
}

export async function insertDeadLetter(
	input: {
		eventId: string | null;
		topic: string;
		payload: unknown;
		error: string;
	},
	db: Db,
): Promise<void> {
	await db
		.insert(deadLetterEvents)
		.values({
			eventId: input.eventId,
			topic: input.topic,
			payload: input.payload,
			error: input.error.slice(0, 500),
		})
		.onConflictDoNothing();
}
