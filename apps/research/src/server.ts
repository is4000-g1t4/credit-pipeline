// Research service entry (Node 22+ here for the Grafana/OpenTelemetry stack;
// `@openai/agents` itself runs on Bun). Stdlib http + app.fetch, no extra server dep.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { startAutoTrigger, type ConsumerHandle } from "./auto-trigger.js";
import { createApp } from "./app.js";
import { createResearchRuntime, createResearchStarter } from "./deps.js";

const { env, logger, sql, caseAssistant, observability, execDeps } = createResearchRuntime();
// Starts durable agent runs; execution lives in the separate agent-worker
// process (src/agent-worker.ts).
const starter = createResearchStarter(env.temporalAddress);
const app = createApp({
	...execDeps,
	sql,
	caseAssistant,
	starter,
});

const MAX_BODY_BYTES = 1_000_000;

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req) {
			size += (chunk as Buffer).length;
			if (size > MAX_BODY_BYTES) {
				res.writeHead(413, { "content-type": "application/json" });
				res.end(
					JSON.stringify({ error: { code: "BODY_TOO_LARGE", message: "request body too large" } }),
				);
				req.resume();
				return;
			}
			chunks.push(chunk as Buffer);
		}
		const body = Buffer.concat(chunks);
		const host = req.headers.host ?? `${env.host}:${env.port}`;
		const request = new Request(`http://${host}${req.url ?? "/"}`, {
			method: req.method ?? "GET",
			headers: req.headers as Record<string, string>,
			body: body.length > 0 ? new Uint8Array(body) : undefined,
			duplex: "half",
		});
		const out = await app.fetch(request);
		res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
		if (out.body) {
			for await (const chunk of out.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
		}
		res.end();
	} catch (err) {
		logger.error({ err }, "unhandled error");
		res.writeHead(500, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "internal error" } }));
	}
}

const server = createServer((req, res) => void handle(req, res));
server.listen(env.port, env.host, () => {
	console.log(`research listening on http://${env.host}:${env.port}`);
});

// T11: Kafka auto-trigger starts only when enabled; Kafka down never fails
// boot (the consumer retries in the background).
let autoTrigger: ConsumerHandle | null = null;
if (env.autoTriggerEnabled) {
	try {
		autoTrigger = await startAutoTrigger({ ...execDeps, starter });
		logger.info("auto-trigger consumer starting");
	} catch (err: unknown) {
		logger.error({ err }, "auto-trigger consumer failed to start");
	}
}

let shuttingDown = false;
const shutdown = (): void => {
	if (shuttingDown) return;
	shuttingDown = true;
	if (autoTrigger) {
		const stopping = autoTrigger;
		void (async () => {
			try {
				await stopping.stop();
			} catch (err: unknown) {
				logger.error({ err }, "auto-trigger stop failed");
			}
		})();
	}
	server.close(() => {
		void starter.close();
		void sql.end();
	});
	// Grafana flush is best-effort and bounded by its own export timeout
	// (2s client + 2s SDK); give it room before the hard exit.
	void (async () => {
		try {
			await observability.shutdown?.();
		} catch (err: unknown) {
			logger.error({ err }, "observability shutdown failed");
		}
	})();
	setTimeout(() => process.exit(0), 6500).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
