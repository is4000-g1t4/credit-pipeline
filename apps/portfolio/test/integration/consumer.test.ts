// Consumer integration (compose): hand-publish a valid event → projected
// exactly once across a duplicate delivery; a malformed payload dead-letters
// without stalling later events. Envelope-level ids are omitted so the
// activity_feed references stay null (payload ids are opaque strings there).

import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({
	path: fileURLToPath(new URL("../../../../.env", import.meta.url)),
});

import { randomUUID } from "node:crypto";
import { createDb } from "@credit/db";
import { activityFeed, processedEvents } from "@credit/db/portfolio";
import { eq } from "drizzle-orm";
import type { Producer } from "kafkajs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "../../src/db.js";
import { type ConsumerHandle, startConsumer } from "../../src/events/consumer.js";
import { connectProducer, waitFor } from "./helpers.js";

function testDb() {
	const url = process.env.PORTFOLIO_DATABASE_URL;
	if (!url) throw new Error("integration: PORTFOLIO_DATABASE_URL is not set (root .env?)");
	return createDb(url);
}

const { db, sql } = testDb();
const TOPIC = "credit.review.expired";

let producer: Producer;
let consumer: ConsumerHandle;
const feedIds: string[] = [];
let poisonMarker = "";

function reviewExpired(id: string) {
	return {
		id,
		type: "review.expired",
		version: 1,
		occurredAt: new Date().toISOString(),
		payload: {
			applicationId: randomUUID(),
			reference: `APP-W3B-${id.slice(0, 4)}`,
		},
	};
}

async function feedCount(eventId: string): Promise<number> {
	const rows = await db
		.select({ id: activityFeed.id })
		.from(activityFeed)
		.where(eq(activityFeed.eventId, eventId));
	return rows.length;
}

beforeAll(async () => {
	producer = await connectProducer();
	// Unique group per run: a shared group (or a running dev worker) would
	// steal our partitions/offsets and the assertions would flake. A fresh
	// group reads fromBeginning, so only fresh event ids are asserted.
	consumer = await startConsumer({ groupId: `test-credit-activity-${randomUUID()}` });
	await waitFor("consumer connect", async () => consumer.isConnected());
	expect(consumer.isConnected()).toBe(true);
});

afterAll(async () => {
	try {
		// Stop consuming before deleting so no late insert races the cleanup.
		await producer?.disconnect();
		await consumer?.stop();
		for (const eventId of feedIds) {
			await db.delete(activityFeed).where(eq(activityFeed.eventId, eventId));
			await db.delete(processedEvents).where(eq(processedEvents.eventId, eventId));
		}
		if (poisonMarker) {
			await sql`DELETE FROM dead_letter_events WHERE payload->>'raw' LIKE ${`%${poisonMarker}%`}`;
		}
	} finally {
		await closeDb();
		await sql.end();
	}
});

describe("consumer (integration)", () => {
	it("projects a hand-published event exactly once across duplicate delivery", async () => {
		const eventId = randomUUID();
		const followUpId = randomUUID();
		feedIds.push(eventId, followUpId);

		await producer.send({
			topic: TOPIC,
			messages: [{ value: JSON.stringify(reviewExpired(eventId)) }],
		});
		await waitFor(`feed row ${eventId}`, () => feedCount(eventId).then((n) => n === 1));

		// Duplicate delivery of the same event id…
		await producer.send({
			topic: TOPIC,
			messages: [{ value: JSON.stringify(reviewExpired(eventId)) }],
		});
		// …followed by a fresh event: proves the duplicate committed instead
		// of stalling the partition.
		await producer.send({
			topic: TOPIC,
			messages: [{ value: JSON.stringify(reviewExpired(followUpId)) }],
		});
		await waitFor(`feed row ${followUpId}`, () => feedCount(followUpId).then((n) => n === 1));

		expect(await feedCount(eventId)).toBe(1);
		const processed = await db
			.select()
			.from(processedEvents)
			.where(eq(processedEvents.eventId, eventId));
		expect(processed).toHaveLength(1);
		const [feed] = await db.select().from(activityFeed).where(eq(activityFeed.eventId, eventId));
		expect(feed?.type).toBe("review.expired");
		expect(feed?.message).toContain("APP-W3B-");
	});

	it("dead-letters a malformed payload without stalling", async () => {
		poisonMarker = randomUUID();
		const afterId = randomUUID();
		feedIds.push(afterId);

		await producer.send({
			topic: TOPIC,
			messages: [{ value: `{not-json-${poisonMarker}` }],
		});
		await producer.send({
			topic: TOPIC,
			messages: [{ value: JSON.stringify(reviewExpired(afterId)) }],
		});
		// The later valid event still projects → the poison didn't stall.
		await waitFor(`feed row ${afterId}`, () => feedCount(afterId).then((n) => n === 1));

		const dead =
			await sql`SELECT id FROM dead_letter_events WHERE payload->>'raw' LIKE ${`%${poisonMarker}%`}`;
		expect((dead as Array<unknown>).length).toBe(1);
	});
});
