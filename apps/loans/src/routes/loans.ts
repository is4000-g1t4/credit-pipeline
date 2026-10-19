// Loans (SPEC FR-9.1): role-scoped list/detail + officer alert acknowledge,
// plus the internal loan-by-application lookup the P1b gateway uses to
// compose the application detail response. Loans carry denormalised
// application columns (reference/applicant/product) — ownership scoping
// never joins to the applications database.
import { ewsAlerts, installments, loans, payments, withTx, type Db } from "@credit/db/loans";
import { HttpError, writeAudit, type ServiceApp, type ServiceVariables } from "@credit/service-kit";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function summarizeLoan(loan: typeof loans.$inferSelect): Record<string, unknown> {
	return {
		id: loan.id,
		applicationId: loan.applicationId,
		reference: loan.applicationReference,
		principalCents: loan.principalCents,
		termMonths: loan.termMonths,
		rateBps: loan.rateBps,
		monthlyPaymentCents: loan.monthlyPaymentCents,
		status: loan.status,
		outstandingCents: loan.outstandingCents,
		nextDueDate: loan.nextDueDate,
		disbursedAt: loan.disbursedAt.toISOString(),
	};
}

export interface LoansRouteDeps {
	db: Db;
}

export const requireOfficerRole = createMiddleware<{ Variables: ServiceVariables }>(
	async (c, next) => {
		const me = c.var.user;
		if (!me) throw new HttpError(401, "UNAUTHENTICATED", "login required");
		if (me.role !== "officer") throw new HttpError(403, "FORBIDDEN", "officer role required");
		await next();
	},
);

export function loansRoutes(deps: LoansRouteDeps): ServiceApp {
	const app: ServiceApp = new Hono();
	const { db } = deps;

	app.get("/api/loans", async (c) => {
		const me = c.var.user;
		const rows = await db
			.select()
			.from(loans)
			.where(me.role === "officer" ? undefined : eq(loans.applicantUserId, me.id))
			.orderBy(desc(loans.disbursedAt));
		return c.json({ items: rows.map((loan) => summarizeLoan(loan)) });
	});

	app.get("/api/loans/:id", async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		if (!UUID_RE.test(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const rows = await db.select().from(loans).where(eq(loans.id, id));
		const loan = rows[0];
		if (!loan || (me.role !== "officer" && loan.applicantUserId !== me.id)) {
			throw new HttpError(404, "NOT_FOUND", "not found");
		}
		const [items, alertRows] = await Promise.all([
			db
				.select()
				.from(installments)
				.where(eq(installments.loanId, id))
				.orderBy(installments.number),
			db.select().from(ewsAlerts).where(eq(ewsAlerts.loanId, id)),
		]);
		const paid = await db
			.select()
			.from(payments)
			.where(
				inArray(
					payments.installmentId,
					items.map((i) => i.id),
				),
			);
		return c.json({
			loan: summarizeLoan(loan),
			installments: items,
			payments: paid,
			alerts: alertRows,
		});
	});

	app.post("/api/loans/:id/alerts/:alertId/acknowledge", requireOfficerRole, async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		const alertId = c.req.param("alertId");
		if (!UUID_RE.test(id) || !UUID_RE.test(alertId)) {
			throw new HttpError(404, "NOT_FOUND", "not found");
		}
		const updated = await withTx(db, async (tx) => {
			const rows = await tx
				.update(ewsAlerts)
				.set({ status: "acknowledged", acknowledgedBy: me.id })
				.where(
					and(eq(ewsAlerts.id, alertId), eq(ewsAlerts.loanId, id), eq(ewsAlerts.status, "open")),
				)
				.returning({ id: ewsAlerts.id, loanId: ewsAlerts.loanId });
			const won = rows[0];
			if (won) {
				const loanRows = await tx
					.select({ applicationId: loans.applicationId })
					.from(loans)
					.where(eq(loans.id, id));
				await writeAudit(tx, {
					...(loanRows[0] ? { applicationId: loanRows[0].applicationId } : {}),
					loanId: id,
					actor: me.id,
					action: "ews.alert.acknowledged",
					entity: "ews_alert",
					payload: { alertId, loanId: id },
				});
			}
			return won ?? null;
		});
		if (updated) return c.json({ id: updated.id, status: "acknowledged" });
		const existing = await db
			.select({ id: ewsAlerts.id, status: ewsAlerts.status })
			.from(ewsAlerts)
			.where(and(eq(ewsAlerts.id, alertId), eq(ewsAlerts.loanId, id)));
		if (!existing[0]) throw new HttpError(404, "NOT_FOUND", "not found");
		throw new HttpError(409, "ALERT_NOT_OPEN", `alert is ${existing[0].status}`);
	});

	// Internal composition lookup for the gateway (P1b): loan summary plus
	// paid/overdue installment counts for one application. Same ownership
	// rule as the detail route — cross-applicant reads are 404.
	app.get("/internal/loans/by-application/:id", async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		if (!UUID_RE.test(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const rows = await db.select().from(loans).where(eq(loans.applicationId, id));
		const loan = rows[0];
		if (!loan || (me.role !== "officer" && loan.applicantUserId !== me.id)) {
			throw new HttpError(404, "NOT_FOUND", "not found");
		}
		const items = await db
			.select({ status: installments.status })
			.from(installments)
			.where(eq(installments.loanId, loan.id));
		return c.json({
			loan: {
				...summarizeLoan(loan),
			},
			installments: {
				total: items.length,
				paid: items.filter((i) => i.status === "paid").length,
				overdue: items.filter((i) => i.status === "overdue").length,
			},
		});
	});

	// Dashboard counts for the portfolio service (FR-9.2): loan status counts.
	app.get("/internal/stats", requireOfficerRole, async (c) => {
		const loanCounts = await db
			.select({ status: loans.status, n: count() })
			.from(loans)
			.groupBy(loans.status);
		return c.json({ loans: Object.fromEntries(loanCounts.map((r) => [r.status, r.n])) });
	});

	return app;
}
