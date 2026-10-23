import { createDb } from "@credit/db";
import { createLogger } from "@credit/service-kit";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";
import { createOpenRouterAnswerer, createOpenRouterEmbedder } from "./openrouter.js";
import { createPostgresPolicyStore } from "./postgres-store.js";

const env = loadEnv();
const logger = createLogger("policy");
const { sql } = createDb(env.databaseUrl);
const store = createPostgresPolicyStore(sql);
const openRouter = {
	apiKey: env.openrouterApiKey,
	baseUrl: env.openrouterBaseUrl,
	model: env.agentModel,
	dimensions: env.embeddingDimensions,
	embeddingModel: env.embeddingModel,
	temperature: env.agentTemperature,
	maxOutputTokens: env.agentMaxOutputTokens,
	embeddingProviders: env.embeddingProviders ? env.embeddingProviders.split(",") : [],
	answererProviderOrder: env.answererProviderOrder ? env.answererProviderOrder.split(",") : [],
};
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
