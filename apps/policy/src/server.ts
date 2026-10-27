import { createDb } from "@credit/db";
import { createLogger } from "@credit/service-kit";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";
import {
	createOpenRouterAnswerer,
	createOpenRouterEmbedder,
	openRouterConfigFromEnv,
} from "./openrouter.js";
import { policyObservability } from "./observability.js";
import { createPostgresPolicyStore } from "./postgres-store.js";

const env = loadEnv();
const logger = createLogger("policy");
// Start OTel providers before any agent client is used.
policyObservability();
const { sql } = createDb(env.databaseUrl);
const store = createPostgresPolicyStore(sql);
const openRouter = openRouterConfigFromEnv(env);
const embedder = createOpenRouterEmbedder(openRouter);
const answerer = createOpenRouterAnswerer(openRouter);
const app = createApp({ sql, env, logger, store, embedder, answerer });

export default {
	port: env.port,
	hostname: env.host,
	idleTimeout: 60,
	fetch(req: Request) {
		return app.fetch(req);
	},
};

console.log(`policy listening on http://${env.host}:${env.port}`);
