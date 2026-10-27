// Kafka consumer (SPEC FR-10.4): group `credit-activity`, fromBeginning,
// manual commit. Each message is validated against the core event schemas:
// invalid → dead_letter_events + commit (poison never stalls the
// partition); valid → projectEnvelope in ./projection.js (exactly-once) +
// commit; transient DB errors → throw without resolving, so kafkajs
// redelivers.
//
// Owned by the portfolio service (Wave P2): it writes the Kafka read model
// into credit_portfolio. Started/stopped by the portfolio server lifecycle.

import { createLogger } from "@credit/service-kit";
import { type EventEnvelope, eventEnvelopeSchema, TOPICS } from "@credit/core";
import type { Db } from "@credit/db";
import { Kafka } from "kafkajs";
import { getDb } from "../db.js";
import { env } from "../env.js";
import { insertDeadLetter, PoisonError, projectEnvelope } from "./projection.js";

export type { EventEnvelope };
export {
	feedMessageForEnvelope,
	insertDeadLetter,
	PoisonError,
	projectEnvelope,
} from "./projection.js";

export const CONSUMER_GROUP_ID = "credit-activity";

const logger = createLogger("portfolio-consumer");

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
	opts: { brokers?: string[]; groupId?: string; db?: Db } = {},
): Promise<ConsumerHandle> {
	const db = opts.db ?? getDb().db;
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
								await insertDeadLetter(
									{
										eventId: null,
										topic: batch.topic,
										payload: { raw: raw.slice(0, 1000) },
										error: "invalid JSON",
									},
									db,
								);
								resolveOffset(message.offset);
								// Commit the poison offset now: a later transient in
								// this batch must not re-dead-letter this row on retry.
								await commitOffsetsIfNecessary();
								continue;
							}
							const result = eventEnvelopeSchema.safeParse(parsed);
							if (!result.success) {
								await insertDeadLetter(
									{
										eventId: eventIdOf(parsed),
										topic: batch.topic,
										payload: parsed,
										error: result.error.issues[0]?.message ?? "schema rejected",
									},
									db,
								);
								resolveOffset(message.offset);
								await commitOffsetsIfNecessary();
								continue;
							}
							try {
								await projectEnvelope(result.data, batch.topic, db);
							} catch (err) {
								if (err instanceof PoisonError) {
									await insertDeadLetter(
										{
											eventId: result.data.id,
											topic: batch.topic,
											payload: parsed,
											error: err.message,
										},
										db,
									);
									resolveOffset(message.offset);
									await commitOffsetsIfNecessary();
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
				logger.error({ err }, "portfolio consumer: kafka error, retrying");
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
				logger.error({ err }, "portfolio consumer: disconnect failed");
			}
		},
		isConnected: () => connected && !stopped,
	};
}
