// Internal API for sibling services (signed internal auth, no cookies).
// The stateless review service drives its queue + decision replay off these;
// portfolio drives its dashboard off /internal/stats. Officer-only: the
// gateway only routes officer callers here, and the service enforces it.
import {
	applications,
	decisions,
	policyEvaluations,
	scores,
	type Db,
} from "@credit/db/applications";
import { HttpError, type ServiceApp, type ServiceVariables } from "@credit/service-kit";
import { asc, count, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { Sql } from "postgres";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface InternalRouteDeps {
	db: Db;
	sql: Sql;
}

const officer = createMiddleware<{ Variables: ServiceVariables }>(async (c, next) => {
	const me = c.var.user;
	if (!me) throw new HttpError(401, "UNAUTHENTICATED", "login required");
	if (me.role !== "officer") throw new HttpError(403, "FORBIDDEN", "officer role required");
	await next();
});

export function internalRoutes(deps: InternalRouteDeps): ServiceApp {
	const app: ServiceApp = new Hono();
	const { db, sql } = deps;

	// Shared review queue (SPEC FR-7.1): pending oldest first, with
	// score/grade + top reasons. Shape matches the former review-service
	// queue so the UI contract is unchanged.
	app.get("/internal/review/queue", officer, async (c) => {
		const now = Date.now();
		const pending = await db
			.select()
			.from(applications)
			.where(eq(applications.status, "pending_review"))
			.orderBy(asc(applications.submittedAt))
			.limit(100);
		const ids = pending.map((a) => a.id);
		const [scoreRows, policyRows] =
			ids.length === 0
				? [[], []]
				: await Promise.all([
						db.select().from(scores).where(inArray(scores.applicationId, ids)),
						db
							.select()
							.from(policyEvaluations)
							.where(inArray(policyEvaluations.applicationId, ids)),
					]);
		const scoreByApp = new Map(scoreRows.map((s) => [s.applicationId, s]));
		const policyByApp = new Map(policyRows.map((p) => [p.applicationId, p]));
		return c.json({
			items: pending.map((a) => {
				const score = scoreByApp.get(a.id);
				const policy = policyByApp.get(a.id);
				const reasons = Array.isArray(policy?.reasons)
					? (policy.reasons as Array<{ code: string }>).map((r) => r.code)
					: [];
				const factors = Array.isArray(score?.factors)
					? (score.factors as Array<{ code: string; points: number }>)
					: [];
				const topReasons = [...factors]
					.sort((x, y) => Math.abs(y.points) - Math.abs(x.points))
					.slice(0, 5)
					.map((f) => f.code);
				return {
					id: a.id,
					reference: a.reference,
					type: a.type,
					product: a.product,
					amountCents: a.amountCents,
					termMonths: a.termMonths,
					submittedAt: a.submittedAt.toISOString(),
					waitMs: now - a.submittedAt.getTime(),
					score: score?.score ?? null,
					grade: score?.grade ?? null,
					reasons,
					topReasons,
				};
			}),
		});
	});

	// Decision replay probe for the review service (FR-6.2): current status
	// plus the terminal decision, if any.
	app.get("/internal/applications/:id/decision", officer, async (c) => {
		const id = c.req.param("id");
		if (!UUID_RE.test(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const rows = await db.select().from(applications).where(eq(applications.id, id));
		const row = rows[0];
		if (!row) throw new HttpError(404, "NOT_FOUND", "not found");
		const decisionRows = await db.select().from(decisions).where(eq(decisions.applicationId, id));
		const decision = decisionRows[0];
		return c.json({
			status: row.status,
			decision: decision
				? { id: decision.id, outcome: decision.outcome, requestId: decision.requestId }
				: null,
		});
	});

	// Dashboard counts for the portfolio service (FR-9.2): application
	// status counts + avg submitted→decided seconds.
	app.get("/internal/stats", officer, async (c) => {
		const appCounts = await db
			.select({ status: applications.status, n: count() })
			.from(applications)
			.groupBy(applications.status);
		const timing = (await sql`
			SELECT avg(EXTRACT(EPOCH FROM (decided_at - submitted_at))) AS avg_seconds,
			       count(*)::int AS decided
			FROM applications WHERE decided_at IS NOT NULL
		`) as Array<{ avg_seconds: string | null; decided: number }>;
		return c.json({
			applications: Object.fromEntries(appCounts.map((r) => [r.status, r.n])),
			avgDecisionSeconds:
				timing[0]?.avg_seconds === null || timing[0]?.avg_seconds === undefined
					? null
					: Number(timing[0].avg_seconds),
			decidedApplications: timing[0]?.decided ?? 0,
		});
	});

	return app;
}
