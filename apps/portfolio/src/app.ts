import type { Db } from "@credit/db";
import type { Sql } from "postgres";
import { checkDb, createService, type Logger, type ServiceApp } from "@credit/service-kit";
import type { PortfolioEnv } from "./env.js";
import type { ConsumerHandle } from "./events/consumer.js";
import { dashboardRoutes } from "./routes/dashboard.js";

export interface PortfolioDeps {
	db: Db;
	sql: Sql;
	env: PortfolioEnv;
	logger: Logger;
	fetchImpl?: typeof fetch;
	/** Kafka consumer handle (server lifecycle owns it); absent in tests. */
	consumer?: ConsumerHandle | null;
}

/** Test seam: pass a fake db handle; the production server wires the real one. */
export function createApp(deps: PortfolioDeps): ServiceApp {
	const routes: ServiceApp = dashboardRoutes({
		db: deps.db,
		applicationsUrl: deps.env.applicationsUrl,
		loansUrl: deps.env.loansUrl,
		internalSecret: deps.env.internalSecret,
		fetchImpl: deps.fetchImpl,
	});
	return createService({
		name: "portfolio",
		secret: deps.env.internalSecret,
		logger: deps.logger,
		routes,
		health: async () => ({
			db: await checkDb(() => deps.sql`SELECT 1`),
			consumer:
				!deps.consumer || deps.consumer.isConnected()
					? { ok: true }
					: { ok: false, error: "consumer not connected" },
		}),
	});
}
