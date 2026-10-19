import type { Db } from "@credit/db";
import type { Sql } from "postgres";
import {
	checkDb,
	checkOutbox,
	checkTemporal,
	createService,
	type Logger,
	type ServiceApp,
	type WorkflowGateway,
} from "@credit/service-kit";
import type { LoansEnv } from "./env.js";
import { demoRoutes } from "./routes/demo.js";
import { loansRoutes } from "./routes/loans.js";

export interface LoansDeps {
	db: Db;
	sql: Sql;
	env: LoansEnv;
	gateway: WorkflowGateway;
	logger: Logger;
}

/** Test seam: pass fakes for gateway/db; the production server wires the real ones. */
export function createApp(deps: LoansDeps): ServiceApp {
	const routes: ServiceApp = loansRoutes(deps);
	routes.route("/", demoRoutes(deps));
	return createService({
		name: "loans",
		secret: deps.env.internalSecret,
		logger: deps.logger,
		routes,
		health: async () => ({
			db: await checkDb(() => deps.sql`SELECT 1`),
			temporal: await checkTemporal(deps.env.temporalAddress),
			outbox: await checkOutbox(
				() =>
					deps.sql`SELECT count(*) FILTER (WHERE dead_lettered_at IS NULL)::int AS backlog,
					count(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::int AS dead
					FROM outbox_events WHERE published_at IS NULL` as Promise<
						Array<{ backlog: number; dead: number }>
					>,
			),
		}),
	});
}
