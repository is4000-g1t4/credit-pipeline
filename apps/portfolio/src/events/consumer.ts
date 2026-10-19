// Kafka consumer (SPEC FR-10.4): group `credit-activity`, fromBeginning,
// manual commit. Each message is validated against the core event schemas:
// invalid → dead_letter_events + commit (poison never stalls the
// partition); valid → ONE transaction inserting processed_events and
// activity_feed, both ON CONFLICT DO NOTHING (a duplicate delivery writes
// nothing and still commits); transient DB errors → throw without
// resolving, so kafkajs redelivers. Feed text uses only the core
// reason-text map and allowlisted payload fields (AC-18 — no PII).
//
// Owned by the portfolio service (Wave P2): it writes the Kafka read model
// into credit_portfolio. Started/stopped by the portfolio server lifecycle.

import { type EventEnvelope, eventEnvelopeSchema, REASON_TEXT, TOPICS } from "@credit/core";
import { withTx } from "@credit/db";
import { activityFeed, deadLetterEvents, processedEvents } from "@credit/db/portfolio";
import { Kafka } from "kafkajs";
import { getDb } from "../db.js";
import { env } from "../env.js";

export const CONSUMER_GROUP_ID = "credit-activity";

function reasonList(codes: unknown): string {
	if (!Array.isArray(codes)) return "";
	return codes
		.map((c) => (typeof c === "string" ? ((REASON_TEXT as Record<string, string>)[c] ?? c) : ""))
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Project one valid envelope: idempotent on redelivery. Non-UUID ids are
 * data poison (the strict schema can't see FKs — and there are none
 * cross-DB), so they dead-letter instead of throwing. */
export async function projectEnvelope(envelope: EventEnvelope, topic: string): Promise<void> {
	for (const id of [envelope.applicationId, envelope.loanId]) {
		if (id !== undefined && !UUID_RE.test(id)) {
			throw new PoisonError(`envelope id is not a UUID: ${id}`);
		}
	}
	const { db } = getDb();
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

export async function insertDeadLetter(input: {
	eventId: string | null;
	topic: string;
	payload: unknown;
	error: string;
}): Promise<void> {
	const { db } = getDb();
	await db.insert(deadLetterEvents).values({
		eventId: input.eventId,
		topic: input.topic,
		payload: input.payload,
		error: input.error.slice(0, 500),
	});
}

function eventIdOf(parsed: unknown): string | null {
	if (
		parsed !== null &&
		typeof parsed === "object" &&
		typeof (parsed as { id?: unknown }).id === "string"
	) {
		return (parsed as { id: string }).id;
	}
	return null;
}

export interface ConsumerHandle {
	stop(): Promise<void>;
	/** True once subscribed; surfaces in /health so a stalled consumer is visible. */
	isConnected(): boolean;
}

/** Starts the consumer; resolves with the handle once the background
 * connect loop is kicked off (never rejects on Kafka outage — it logs and
 * retries, so the service starts cleanly while Kafka is briefly down). */
export async function startConsumer(
	opts: { brokers?: string[]; groupId?: string } = {},
): Promise<ConsumerHandle> {
	const brokers =
		opts.brokers ??
		env.kafkaBrokers
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	const kafka = new Kafka({ clientId: "credit-activity", brokers });
	const consumer = kafka.consumer({
		groupId: opts.groupId ?? CONSUMER_GROUP_ID,
	});
	let stopped = false;
	let connected = false;

	void (async () => {
		for (;;) {
			if (stopped) return;
			try {
				await consumer.connect();
				await consumer.subscribe({
					topics: Object.values(TOPICS),
					fromBeginning: true,
				});
				connected = true;
				await consumer.run({
					autoCommit: false,
					eachBatchAutoResolve: false,
					eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary }) => {
						for (const message of batch.messages) {
							const raw = message.value?.toString() ?? "";
							let parsed: unknown = null;
							try {
								parsed = JSON.parse(raw);
							} catch {
								await insertDeadLetter({
									eventId: null,
									topic: batch.topic,
									payload: { raw: raw.slice(0, 1000) },
									error: "invalid JSON",
								});
								resolveOffset(message.offset);
								continue;
							}
							const result = eventEnvelopeSchema.safeParse(parsed);
							if (!result.success) {
								await insertDeadLetter({
									eventId: eventIdOf(parsed),
									topic: batch.topic,
									payload: parsed,
									error: result.error.issues[0]?.message ?? "schema rejected",
								});
								resolveOffset(message.offset);
								continue;
							}
							try {
								await projectEnvelope(result.data, batch.topic);
							} catch (err) {
								if (err instanceof PoisonError) {
									await insertDeadLetter({
										eventId: result.data.id,
										topic: batch.topic,
										payload: parsed,
										error: err.message,
									});
									resolveOffset(message.offset);
									continue;
								}
								throw err; // transient: unresolved → redelivered
							}
							resolveOffset(message.offset);
							await heartbeat();
						}
						await commitOffsetsIfNecessary();
					},
				});
				return;
			} catch (err) {
				connected = false;
				if (stopped) return;
				console.error("portfolio consumer: kafka error, retrying:", err);
				await new Promise((r) => setTimeout(r, 1000));
			}
		}
	})();

	return {
		stop: async () => {
			stopped = true;
			connected = false;
			try {
				await consumer.disconnect();
			} catch (err) {
				console.error("portfolio consumer: disconnect failed:", err);
			}
		},
		isConnected: () => connected && !stopped,
	};
}
