import { createLogger } from "@credit/service-kit";
import { createApp } from "./app.js";
import { closeDb, getDb } from "./db.js";
import { loadEnv } from "./env.js";
import { startConsumer } from "./events/consumer.js";

const env = loadEnv();
const logger = createLogger("portfolio");
const { db, sql } = getDb();

// The Kafka consumer (FR-10.4 read model) lives here, not in the worker.
// It tolerates a briefly unavailable broker: connect retries in the
// background while the service stays up.
const consumer = await startConsumer();
logger.info("portfolio: kafka consumer started");

const app = createApp({ db, sql, env, logger, consumer });

let shuttingDown = false;
const shutdown = async () => {
	if (shuttingDown) return;
	shuttingDown = true;
	logger.info("portfolio: shutting down...");
	try {
		await consumer.stop();
	} catch (err) {
		logger.error({ err }, "portfolio: consumer stop failed");
	}
	try {
		await closeDb();
	} catch (err) {
		logger.error({ err }, "portfolio: db close failed");
	}
	process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

// Bun entry: `bun --watch --env-file=../../.env src/server.ts` (see
// package.json dev). Bun serves the default export; `app.ts` stays a pure
// Hono factory so tests keep importing it directly under Node/Vitest.
export default {
	port: env.port,
	hostname: env.host,
	// Bun's default 10s idle timeout would pre-empt the 45s demo/review calls.
	idleTimeout: 60,
	fetch(req: Request) {
		return app.fetch(req);
	},
};

logger.info(`portfolio listening on http://${env.host}:${env.port}`);
