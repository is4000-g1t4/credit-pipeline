import dotenv from "dotenv";

dotenv.config();

import { Kafka } from "kafkajs";

// SPEC FR-10.1: topics provisioned by `pnpm kafka:init` (3 partitions, RF 1).
const TOPICS = [
	"credit.application.submitted",
	"credit.decision.made",
	"credit.review.requested",
	"credit.review.expired",
	"credit.loan.booked",
	"credit.payment.posted",
	"credit.ews.alert",
];

const brokers = (process.env.KAFKA_BROKERS ?? "localhost:9092")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);

const kafka = new Kafka({ clientId: "credit-kafka-init", brokers });
const admin = kafka.admin();

const deadline = Date.now() + 120_000;
for (;;) {
	try {
		await admin.connect();
		break;
	} catch (err) {
		if (Date.now() >= deadline) throw err;
		await new Promise((r) => setTimeout(r, 2000));
	}
}

try {
	const existing = new Set(await admin.listTopics());
	const missing = TOPICS.filter((t) => !existing.has(t));
	if (missing.length === 0) {
		console.log("kafka:init: all 7 topics already exist (no-op)");
	} else {
		await admin.createTopics({
			topics: missing.map((topic) => ({
				topic,
				numPartitions: 3,
				replicationFactor: 1,
			})),
		});
		console.log(`kafka:init: created ${missing.join(", ")}`);
	}
} finally {
	await admin.disconnect();
}
