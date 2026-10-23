// Research service entry (Node 22+; the Agents/Grafana SDKs are
// Node-only — never Bun). Stdlib http + app.fetch, no extra server dep.
import { createDb } from "@credit/db/research";
import { createLogger } from "@credit/service-kit";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
	bootRecovery,
	recoverQueuedRuns,
	startAutoTrigger,
	type ConsumerHandle,
} from "./auto-trigger.js";
import { createLlmSupportJudge } from "./support.js";
import { createLlmLanguageRepair } from "./repair.js";
import { createRealRunner, OPENROUTER_BASE_URL } from "./agent.js";
import { createRealContextRunner } from "./context-agent.js";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";
import { createHttpPolicyRunner } from "./policy-stage.js";
import { reapContextStages, reapPolicyStages, reapStaleRuns } from "./lifecycle.js";
import { getObservability } from "./observability.js";
import OpenAI from "openai";
import { createTavilyClient } from "./tavily.js";

const env = loadEnv();
const logger = createLogger("research");
const { db, sql } = createDb(env.databaseUrl);

const tavily = createTavilyClient({ apiKey: env.tavilyApiKey });
const openai = new OpenAI({
	apiKey: env.openrouterApiKey || "unconfigured",
	baseURL: OPENROUTER_BASE_URL,
});
// Same cached instance createApp defaults to: direct repair/judge calls join
// the run conversation without a second pipeline.
const observability = getObservability();
const runner = createRealRunner({ env, tavily, openai });
const judge = createLlmSupportJudge(openai, env.agentModel, { observability });
const repair = createLlmLanguageRepair(openai, env.agentModel, { observability });
const contextRunner = createRealContextRunner({ env, openai });
const policyRunner = createHttpPolicyRunner(env);
const app = createApp({ db, sql, env, logger, runner, judge, repair, contextRunner, policyRunner });

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

// Crash recovery on boot + periodic sweep; SKIP LOCKED, never touches live runs.
// Recovery runs BEFORE the reaper: a crash-left queued run starts instead
// of being failed first (see bootRecovery).
const execDeps = { db, env, logger, runner, judge, repair, observability, contextRunner, policyRunner };
try {
	const { recovered, reaped } = await bootRecovery(execDeps);
	if (recovered.length > 0)
		logger.info({ count: recovered.length }, "recovered queued runs on boot");
	if (reaped.length > 0) logger.info({ count: reaped.length }, "reaped stale runs on boot");
	try {
		const reapedContext = await reapContextStages(db);
		if (reapedContext.length > 0)
			logger.info({ count: reapedContext.length }, "reaped stale context stages on boot");
	} catch (err: unknown) {
		logger.error({ err }, "context stage reaper failed");
	}
	try {
		const reapedPolicy = await reapPolicyStages(db);
		if (reapedPolicy.length > 0)
			logger.info({ count: reapedPolicy.length }, "reaped stale policy stages on boot");
	} catch (err: unknown) {
		logger.error({ err }, "policy stage reaper failed");
	}
} catch (err: unknown) {
	logger.error({ err }, "boot recovery failed");
}
const reaper = setInterval(() => {
	void (async () => {
		try {
			await reapStaleRuns(db);
			// Context/policy stage reapers run on both running and terminal
			// T11 runs; they clear expired stage state and never touch a
			// persisted external brief.
			await reapContextStages(db);
			await reapPolicyStages(db);
		} catch (err: unknown) {
			logger.error({ err }, "reaper failed");
		}
	})();
}, 30_000);
reaper.unref();
const recovery = setInterval(() => {
	void (async () => {
		try {
			await recoverQueuedRuns(execDeps);
		} catch (err: unknown) {
			logger.error({ err }, "queued-run recovery failed");
		}
	})();
}, 10_000);
recovery.unref();

// T11: Kafka auto-trigger starts only when enabled; Kafka down never fails
// boot (the consumer retries in the background).
let autoTrigger: ConsumerHandle | null = null;
if (env.autoTriggerEnabled) {
	try {
		autoTrigger = await startAutoTrigger(execDeps);
		logger.info("auto-trigger consumer starting");
	} catch (err: unknown) {
		logger.error({ err }, "auto-trigger consumer failed to start");
	}
}

let shuttingDown = false;
const shutdown = (): void => {
	if (shuttingDown) return;
	shuttingDown = true;
	clearInterval(reaper);
	clearInterval(recovery);
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
	server.close(() => void sql.end());
	setTimeout(() => process.exit(0), 2500).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
