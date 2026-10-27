// Outbox relay (SPEC FR-6.6): every second, one owner (advisory lock 4242)
// publishes up to 50 unpublished rows in seq order, marking published_at
// after each ack. First failure stops the batch (order preserved);
// attempts increment per failure, 10 failures dead-letters the row.
// At-least-once: the consumer dedupes on processed_events.
//
// Seams: relayOnce takes an injected producer and an optional store — unit
// tests pass fakes, production uses the drizzle store. The drizzle store
// reserves one pooled connection per call because pg_try_advisory_lock is
// session-scoped (a checkout-per-statement would lock a random session).

import { Kafka, type Producer } from "kafkajs";
import { workerEnv } from "../env.js";
import { type ReservedDb } from "../db.js";
import { logger } from "../logger.js";

export const RELAY_LOCK_KEY = 4242;
export const LOANS_RELAY_LOCK_KEY = 4243;
export const MAX_RELAY_ATTEMPTS = 10;

export interface RelayProducer {
	send(args: { topic: string; messages: Array<{ key?: string; value: string }> }): Promise<unknown>;
}

export interface OutboxRelayRow {
	id: string;
	topic: string;
	key: string | null;
	payload: unknown;
	attempts: number;
}

export interface RelayStore {
	tryLock(): Promise<boolean>;
	unlock(): Promise<void>;
	fetchBatch(limit: number): Promise<OutboxRelayRow[]>;
	markPublished(id: string, now: Date): Promise<void>;
	markAttempt(id: string, now: Date, lastError: string, deadLetter: boolean): Promise<void>;
}

export interface RelayResult {
	skipped: boolean;
	published: number;
	deadLettered: number;
}

function kafkaKeyFor(row: OutboxRelayRow): string | undefined {
	const envelope = row.payload as {
		applicationId?: unknown;
		loanId?: unknown;
	} | null;
	if (envelope && typeof envelope === "object") {
		if (typeof envelope.applicationId === "string" && envelope.applicationId)
			return envelope.applicationId;
		if (typeof envelope.loanId === "string" && envelope.loanId) return envelope.loanId;
	}
	return row.key ?? undefined;
}

/** Connection-level outage (broker down, socket reset, producer
 * disconnected) vs a message-level failure (poison record): only the
 * latter burns an attempt. Outages leave the row untouched for the next
 * tick so a Kafka outage cannot dead-letter the backlog. Conservative on
 * purpose: only KafkaJS connection/transport names and the `cause` chain
 * mark an outage. `retriable` alone is not enough: KafkaJS marks message
 * errors (for example CORRUPT_MESSAGE) retriable too. DB errors from the
 * store are handled separately and never reset the producer. */
export function isConnectionError(err: unknown): boolean {
	let current: unknown = err;
	for (let depth = 0; depth < 3; depth++) {
		if (current === null || (typeof current !== "object" && !(current instanceof Error))) {
			return typeof current === "string" && isOutageMessage(current);
		}
		const rec = current as { name?: unknown; retriable?: unknown; cause?: unknown };
		const name = typeof rec.name === "string" ? rec.name : "";
		if (
			name.includes("KafkaJSConnection") ||
			name.includes("KafkaJSRequestTimeout") ||
			name.includes("KafkaJSNoBrokerAvailable") ||
			name.includes("KafkaJSBrokerNotFound") ||
			name.includes("KafkaJSNotConnected")
		) {
			return true;
		}
		if (current instanceof Error && isOutageMessage(current.message)) return true;
		if (rec.cause === undefined || rec.cause === null) return false;
		current = rec.cause;
	}
	return false;
}

function isOutageMessage(message: string): boolean {
	return /producer (is )?disconnected|not connected|no broker available|econnrefused|econnreset|etimedout|enotfound|socket|sasl/i.test(
		message,
	);
}

export async function relayOnce(opts: {
	now: Date;
	producer: RelayProducer;
	batchSize?: number;
	store: RelayStore;
	/** Called on connection-level send failures so the owner can reset its
	 * producer; the row is left untouched (no attempt burned). */
	onConnectionError?: (err: unknown) => void;
}): Promise<RelayResult> {
	const store = opts.store;
	const batchSize = opts.batchSize ?? 50;
	if (!(await store.tryLock())) return { skipped: true, published: 0, deadLettered: 0 };
	try {
		const batch = await store.fetchBatch(batchSize);
		let published = 0;
		let deadLettered = 0;
		for (const row of batch) {
			// Only the send is classified: a connection-class send failure
			// resets the producer and stops the batch with nothing burned.
			try {
				await opts.producer.send({
					topic: row.topic,
					messages: [{ key: kafkaKeyFor(row), value: JSON.stringify(row.payload) }],
				});
			} catch (err) {
				if (isConnectionError(err)) {
					opts.onConnectionError?.(err);
					break; // outage: stop the batch, burn nothing
				}
				const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
				const deadLetter = row.attempts + 1 >= MAX_RELAY_ATTEMPTS;
				await store.markAttempt(row.id, opts.now, message, deadLetter);
				if (deadLetter) deadLettered++;
				break; // stop the batch on first failure — never reorder
			}
			// The send landed: a markPublished failure is a store problem,
			// not a Kafka outage — log and stop without resetting the
			// producer. The row stays unpublished and may republish
			// (at-least-once; the consumer dedupes).
			try {
				await store.markPublished(row.id, opts.now);
			} catch (err) {
				logger.error({ err }, "worker relay: markPublished failed");
				break;
			}
			published++;
		}
		return { skipped: false, published, deadLettered };
	} finally {
		await store.unlock();
	}
}

export function drizzleRelayStore(
	reserve: () => Promise<ReservedDb>,
	lockKey: number = RELAY_LOCK_KEY,
): RelayStore {
	let conn: ReservedDb | null = null;
	const requireConn = (): ReservedDb => {
		if (!conn) throw new Error("relay store: no reserved connection");
		return conn;
	};
	return {
		async tryLock(): Promise<boolean> {
			const c = await reserve();
			try {
				const rows =
					(await c`SELECT pg_try_advisory_lock(${lockKey}) AS "locked"`) as unknown as Array<{
						locked: boolean;
					}>;
				if (rows[0]?.locked === true) {
					conn = c;
					return true;
				}
				c.release();
				return false;
			} catch (err) {
				c.release();
				throw err;
			}
		},
		async unlock(): Promise<void> {
			const c = conn;
			conn = null;
			if (!c) return;
			try {
				await c`SELECT pg_advisory_unlock(${lockKey})`;
			} finally {
				c.release();
			}
		},
		async fetchBatch(limit: number): Promise<OutboxRelayRow[]> {
			const rows = await requireConn()`
				SELECT id, topic, "key", payload, attempts FROM outbox_events
				WHERE published_at IS NULL AND dead_lettered_at IS NULL
				ORDER BY seq LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
			return rows as unknown as OutboxRelayRow[];
		},
		async markPublished(id: string, now: Date): Promise<void> {
			// Raw postgres-js templates don't serialize Date (drizzle does
			// that mapping itself) — pass the ISO string, Postgres casts it.
			await requireConn()`UPDATE outbox_events SET published_at = ${now.toISOString()} WHERE id = ${id}`;
		},
		async markAttempt(
			id: string,
			now: Date,
			lastError: string,
			deadLetter: boolean,
		): Promise<void> {
			if (deadLetter) {
				await requireConn()`UPDATE outbox_events
					SET attempts = attempts + 1, last_error = ${lastError}, dead_lettered_at = ${now.toISOString()}
					WHERE id = ${id}`;
			} else {
				await requireConn()`UPDATE outbox_events
					SET attempts = attempts + 1, last_error = ${lastError}
					WHERE id = ${id}`;
			}
		},
	};
}

export interface RelayLoopHandle {
	stop(): void;
}

/** 1s relay loop. Owns a Kafka producer; while Kafka is down the tick is
 * skipped (logged) without touching rows — no attempt-burning during an
 * outage. Never throws out of the tick. */
export function startRelayLoop(opts: {
	intervalMs?: number;
	producer?: RelayProducer;
	store: RelayStore;
}): RelayLoopHandle {
	const intervalMs = opts.intervalMs ?? 1000;
	const brokers = workerEnv.kafkaBrokers
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	let stopped = false;
	let inFlight: Promise<void> | null = null;
	let kafkaProducer: Producer | null = null;
	let connected = false;

	/** Drop the producer after a connection-level send failure so the next
	 * tick reconnects instead of reusing a dead connection. */
	const resetProducer = (): void => {
		connected = false;
		if (kafkaProducer) {
			kafkaProducer.disconnect().catch((err) => {
				logger.error({ err }, "worker relay: producer disconnect failed");
			});
			kafkaProducer = null;
		}
	};

	const getProducer = async (): Promise<RelayProducer | null> => {
		if (opts.producer) return opts.producer;
		if (!kafkaProducer) {
			kafkaProducer = new Kafka({
				clientId: "credit-outbox-relay",
				brokers,
			}).producer();
		}
		if (!connected) {
			try {
				await kafkaProducer.connect();
				connected = true;
			} catch (err) {
				logger.error({ err }, "worker relay: kafka unavailable, retrying");
				return null;
			}
		}
		const delegate = kafkaProducer;
		return {
			send: async (args) => {
				await delegate.send({
					topic: args.topic,
					messages: args.messages.map((m) => ({
						...(m.key !== undefined ? { key: m.key } : {}),
						value: m.value,
					})),
				});
			},
		};
	};

	const timer = setInterval(() => {
		if (stopped || inFlight) return;
		inFlight = (async () => {
			try {
				const producer = await getProducer();
				if (!producer) return; // kafka down: skip, don't burn attempts
				await relayOnce({
					now: new Date(),
					producer,
					store: opts.store,
					onConnectionError: () => resetProducer(),
				});
			} catch (err) {
				logger.error({ err }, "worker relay: tick failed");
			}
		})().finally(() => {
			inFlight = null;
		});
	}, intervalMs);
	timer.unref?.();

	return {
		async stop() {
			stopped = true;
			clearInterval(timer);
			await inFlight?.catch(() => {});
			if (kafkaProducer) {
				kafkaProducer.disconnect().catch((err) => {
					logger.error({ err }, "worker relay: producer disconnect failed");
				});
				kafkaProducer = null;
				connected = false;
			}
		},
	};
}
