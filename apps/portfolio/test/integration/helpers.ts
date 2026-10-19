// Shared Kafka/test helpers (compose required): back here after the
// consumer moved to portfolio (only connect/wait/iso-day remain shared).
import { randomUUID } from "node:crypto";
import { Kafka, type Producer } from "kafkajs";

export function kafkaBrokers(): string[] {
	return (process.env.KAFKA_BROKERS ?? "localhost:9092")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export async function connectProducer(): Promise<Producer> {
	const producer = new Kafka({
		clientId: `w3b-test-${randomUUID()}`,
		brokers: kafkaBrokers(),
	}).producer();
	await producer.connect();
	return producer;
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
