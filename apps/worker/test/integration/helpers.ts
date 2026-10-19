// Shared integration-test helpers (compose required): root .env, fresh DB
// handles per file (one per writer database), Kafka producer factory, and a
// polling waiter.
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({
	path: fileURLToPath(new URL("../../../.env", import.meta.url)),
});

import { randomUUID } from "node:crypto";
import { createDb } from "@credit/db";
import { Kafka, type Producer } from "kafkajs";

export function testDb() {
	const url = process.env.APPLICATIONS_DATABASE_URL;
	if (!url) throw new Error("integration: APPLICATIONS_DATABASE_URL is not set (root .env?)");
	return createDb(url);
}

export function testLoansDb() {
	const url = process.env.LOANS_DATABASE_URL;
	if (!url) throw new Error("integration: LOANS_DATABASE_URL is not set (root .env?)");
	return createDb(url);
}

export function kafkaBrokers(): string[] {
	return (process.env.KAFKA_BROKERS ?? "localhost:9092")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export function temporalAddress(): string {
	return process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
}

export async function connectProducer(): Promise<Producer> {
	const producer = new Kafka({
		clientId: `w3b-test-${randomUUID()}`,
		brokers: kafkaBrokers(),
	}).producer();
	await producer.connect();
	return producer;
}

/** UTC YYYY-MM-DD `offsetDays` from today (matches the date column). */
export function isoDay(offsetDays: number): string {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() + offsetDays);
	return d.toISOString().slice(0, 10);
}

export async function waitFor(
	label: string,
	check: () => Promise<boolean>,
	timeoutMs = 60_000,
	intervalMs = 500,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await check()) return;
		if (Date.now() >= deadline) throw new Error(`integration: timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}
