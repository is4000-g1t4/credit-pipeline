// Officer dashboard (SPEC FR-9.2): application/loan counts, average
// decision time (submitted→decided), recent activity feed. Application/loan
// numbers come from the owning services' internal stats endpoints (signed,
// same user); the feed is the local Kafka read model.
import { activityFeed, type Db } from "@credit/db/portfolio";
import { HttpError, internalFetch, requireOfficer, type ServiceApp } from "@credit/service-kit";
import { desc } from "drizzle-orm";
import { Hono } from "hono";

export interface DashboardRouteDeps {
	db: Db;
	applicationsUrl: string;
	loansUrl: string;
	internalSecret: string;
	fetchImpl?: typeof fetch;
}

interface ApplicationsStats {
	applications: Record<string, number>;
	avgDecisionSeconds: number | null;
	decidedApplications: number;
	decisionsToday?: number;
}

interface LoansStats {
	loans: Record<string, number>;
}

export function dashboardRoutes(deps: DashboardRouteDeps): ServiceApp {
	const app: ServiceApp = new Hono();
	const { db, applicationsUrl, loansUrl, internalSecret, fetchImpl } = deps;

	app.get("/api/dashboard/summary", requireOfficer, async (c) => {
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
			decisionsToday: apps.decisionsToday ?? null,
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

	// Portfolio book summary (SPEC §5): officer only, proxied from the loans
	// service aggregation. Non-OK upstream surfaces as 502, like the dashboard.
	app.get("/api/portfolio/summary", requireOfficer, async (c) => {
		const me = c.var.user;
		const loansRes = await internalFetch(loansUrl, "/internal/portfolio/summary", me, {
			secret: internalSecret,
			fetchImpl,
		});
		if (!loansRes.ok) {
			throw new HttpError(502, "BAD_GATEWAY", "upstream service unavailable");
		}
		return c.json(await loansRes.json());
	});

	return app;
}
