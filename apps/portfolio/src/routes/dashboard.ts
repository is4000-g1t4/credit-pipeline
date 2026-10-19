// Officer dashboard (SPEC FR-9.2): application/loan counts, average
// decision time (submitted→decided), recent activity feed. Application/loan
// numbers come from the owning services' internal stats endpoints (signed,
// same user); the feed is the local Kafka read model.
import { activityFeed, type Db } from "@credit/db/portfolio";
import {
	HttpError,
	internalFetch,
	type ServiceApp,
	type ServiceVariables,
} from "@credit/service-kit";
import { desc } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";

export interface DashboardRouteDeps {
	db: Db;
	applicationsUrl: string;
	loansUrl: string;
	internalSecret: string;
	fetchImpl?: typeof fetch;
}

const officer = createMiddleware<{ Variables: ServiceVariables }>(async (c, next) => {
	const me = c.var.user;
	if (!me) throw new HttpError(401, "UNAUTHENTICATED", "login required");
	if (me.role !== "officer") throw new HttpError(403, "FORBIDDEN", "officer role required");
	await next();
});

interface ApplicationsStats {
	applications: Record<string, number>;
	avgDecisionSeconds: number | null;
	decidedApplications: number;
}

interface LoansStats {
	loans: Record<string, number>;
}

export function dashboardRoutes(deps: DashboardRouteDeps): ServiceApp {
	const app: ServiceApp = new Hono();
	const { db, applicationsUrl, loansUrl, internalSecret, fetchImpl } = deps;

	app.get("/api/dashboard/summary", officer, async (c) => {
		const me = c.var.user;
		const [appsRes, loansRes, feed] = await Promise.all([
			internalFetch(applicationsUrl, "/internal/stats", me, {
				secret: internalSecret,
				fetchImpl,
			}),
			internalFetch(loansUrl, "/internal/stats", me, { secret: internalSecret, fetchImpl }),
			db.select().from(activityFeed).orderBy(desc(activityFeed.occurredAt)).limit(20),
		]);
		if (!appsRes.ok || !loansRes.ok) {
			throw new HttpError(502, "BAD_GATEWAY", "upstream service unavailable");
		}
		const apps = (await appsRes.json()) as ApplicationsStats;
		const loanStats = (await loansRes.json()) as LoansStats;
		return c.json({
			applications: apps.applications,
			loans: loanStats.loans,
			avgDecisionSeconds: apps.avgDecisionSeconds,
			decidedApplications: apps.decidedApplications,
			recentFeed: feed.map((f) => ({
				id: f.id,
				type: f.type,
				message: f.message,
				applicationId: f.applicationId,
				loanId: f.loanId,
				occurredAt: f.occurredAt.toISOString(),
			})),
		});
	});

	return app;
}
