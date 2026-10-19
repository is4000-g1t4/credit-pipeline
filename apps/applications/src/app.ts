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
import type { ApplicationsEnv } from "./env.js";
import { applicationsRoutes } from "./routes/applications.js";
import { internalRoutes } from "./routes/internal.js";

export interface ApplicationsDeps {
	db: Db;
	sql: Sql;
	env: ApplicationsEnv;
	gateway: WorkflowGateway;
	logger: Logger;
}

/** Test seam: pass fakes for gateway/db; the production server wires the real ones. */
export function createApp(deps: ApplicationsDeps): ServiceApp {
	const routes: ServiceApp = applicationsRoutes(deps);
	routes.route("/", internalRoutes(deps));
	return createService({
		name: "applications",
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
