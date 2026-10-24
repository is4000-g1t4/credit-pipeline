// Relay integration (compose): insert an outbox row per writer DB, observe
// each arrive in real Kafka under the row-key fallback, and see
// published_at set. Each DB has its own relay loop + advisory lock key.
//
// Dev-worker race: a locally running worker shares these compose DBs and
// may win the advisory lock and publish our row first. The test polls
// relayOnce until the row lands — whoever publishes it — instead of
// assuming a single call does the work.

import { randomUUID } from "node:crypto";
import { outboxEvents } from "@credit/db/shared";
import { eq } from "drizzle-orm";
import { Kafka, type Producer } from "kafkajs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, reserveApplications, reserveLoans } from "../../src/db.js";
import {
	LOANS_RELAY_LOCK_KEY,
	RELAY_LOCK_KEY,
	drizzleRelayStore,
	relayOnce,
} from "../../src/outbox/relay.js";
import { connectProducer, kafkaBrokers, testDb, testLoansDb, waitFor } from "./helpers.js";

const appsDb = testDb();
const loansDb = testLoansDb();
const TOPIC = "credit.ews.alert";

let producer: Producer;
const rowIds: Array<{ db: typeof appsDb.db; id: string }> = [];

function envelope() {
	return {
		id: randomUUID(),
		type: "ews.alert",
		version: 1,
		occurredAt: new Date().toISOString(),
		payload: {
			alertId: randomUUID(),
			loanId: randomUUID(),
			alertType: "payment_overdue",
			severity: "medium",
		},
	};
}

beforeAll(async () => {
	producer = await connectProducer();
});

afterAll(async () => {
	try {
		for (const { db, id } of rowIds) {
			await db.delete(outboxEvents).where(eq(outboxEvents.id, id));
		}
		await producer?.disconnect();
	} finally {
		await closeDb();
		await appsDb.sql.end();
		await loansDb.sql.end();
	}
});

/** One-shot observer: resolves when a message with `key` lands on TOPIC. */
function observeKey(topic: string, wantKey: string, groupId: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const consumer = new Kafka({
			clientId: `w3b-relay-obs-${randomUUID()}`,
			brokers: kafkaBrokers(),
		}).consumer({ groupId });
		const timer = setTimeout(() => {
			void consumer.disconnect();
			reject(new Error(`integration: timed out observing key ${wantKey}`));
		}, 60_000);
		void (async () => {
			await consumer.connect();
			await consumer.subscribe({ topic, fromBeginning: true });
			await consumer.run({
				autoCommit: true,
				eachMessage: async ({ message }) => {
					if (message.key?.toString() === wantKey) {
						clearTimeout(timer);
						resolve(wantKey);
						await consumer.disconnect();
					}
				},
			});
		})().catch(reject);
	});
}

describe("relayOnce (integration)", () => {
	it.each([
		{ db: "applications", handle: appsDb, reserve: reserveApplications, lock: RELAY_LOCK_KEY },
		{ db: "loans", handle: loansDb, reserve: reserveLoans, lock: LOANS_RELAY_LOCK_KEY },
	])(
		"publishes an inserted $db outbox row to Kafka and marks it published",
		async ({ handle, reserve, lock }) => {
			const key = `w3b-relay-${randomUUID()}`;
			const dedupe = `w3b.relay.${randomUUID()}`;
			const inserted = await handle.db
				.insert(outboxEvents)
				.values({ topic: TOPIC, key, payload: envelope(), dedupeKey: dedupe })
				.returning({ id: outboxEvents.id });
			const rowId = inserted[0].id;
			rowIds.push({ db: handle.db, id: rowId });

			const seen = observeKey(TOPIC, key, `w3b-relay-obs-${randomUUID()}`);
			// Whoever wins the advisory lock publishes the row (a dev
			// worker may beat us to it) — poll until it lands, then assert
			// the end state rather than which call did the work.
			await waitFor(`outbox row ${rowId} published`, async () => {
				await relayOnce({
					now: new Date(),
					producer,
					store: drizzleRelayStore(reserve, lock),
				});
				const [row] = await handle.db
					.select({ publishedAt: outboxEvents.publishedAt })
					.from(outboxEvents)
					.where(eq(outboxEvents.id, rowId));
				return row?.publishedAt instanceof Date;
			});

			const [updated] = await handle.db
				.select()
				.from(outboxEvents)
				.where(eq(outboxEvents.id, rowId));
			expect(updated?.publishedAt).not.toBeNull();

			// Proves the row actually reached Kafka (not just marked published).
			await expect(seen).resolves.toBe(key);
		},
	);
});
