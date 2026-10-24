// Demo controls (SPEC FR-8.5): officer-only AND DEMO_MODE=true, every write
// audited with demo:true. pay/age run in one transaction with row locks;
// age then runs monitoring synchronously through the gateway.
import { computeNextDueDate, dedupePaymentPosted, loanRollup } from "@credit/core";
import { ewsAlerts, installments, loans, payments, withTx, type Db } from "@credit/db/loans";
import {
	GatewayError,
	HttpError,
	insertOutbox,
	readJson,
	requireOfficer,
	writeAudit,
	type ServiceApp,
	type ServiceVariables,
	type WorkflowGateway,
	zodFields,
} from "@credit/service-kit";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DemoRouteDeps {
	db: Db;
	env: { demoMode: boolean };
	gateway: WorkflowGateway;
}

const requireDemoOfficer = (deps: DemoRouteDeps) =>
	createMiddleware<{ Variables: ServiceVariables }>(async (c, next) => {
		if (!deps.env.demoMode) {
			throw new HttpError(403, "DEMO_MODE_DISABLED", "demo endpoints are disabled");
		}
		// Role gate is the shared helper; the demo flag stays local.
		await requireOfficer(c, next);
	});

const paySchema = z.object({ installmentId: z.uuid() }).strict();
const ageSchema = z
	.object({
		days: z.number().int().min(0).max(3650),
		installmentId: z.uuid().optional(),
	})
	.strict();

export function demoRoutes(deps: DemoRouteDeps): ServiceApp {
	const app: ServiceApp = new Hono();
	const { db, gateway } = deps;
	const demo = requireDemoOfficer(deps);

	app.post("/api/demo/monitoring/run", demo, async (c) => {
		try {
			const { counts, workflowId, timedOut } = await gateway.runMonitoring(true);
			if (timedOut) return c.json({ workflowId }, 202);
			return c.json({ ...counts, workflowId });
		} catch (err) {
			if (err instanceof GatewayError) throw new HttpError(err.status, err.code, err.message);
			throw err;
		}
	});

	app.post("/api/demo/loans/:id/pay", demo, async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		if (!UUID_RE.test(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const parsed = paySchema.safeParse(await readJson(c));
		if (!parsed.success) {
			throw new HttpError(400, "VALIDATION_ERROR", "invalid payment", zodFields(parsed.error));
		}
		const result = await withTx(db, async (tx) => {
			// Lock order is installments → loans, matching the monitoring
			// sweep (which locks due installments before recomputing loans):
			// the reverse order deadlocks when pay races monitoring.
			const rows = await tx
				.select()
				.from(installments)
				.where(eq(installments.id, parsed.data.installmentId))
				.for("update");
			const item = rows[0];
			if (!item || item.loanId !== id) {
				throw new HttpError(404, "NOT_FOUND", "installment not found for this loan");
			}
			const loanRows = await tx.select().from(loans).where(eq(loans.id, id)).for("update");
			const loan = loanRows[0];
			if (!loan) throw new HttpError(404, "NOT_FOUND", "not found");
			if (item.status === "paid") {
				throw new HttpError(409, "ALREADY_PAID", "installment is already paid");
			}
			const [payment] = await tx
				.insert(payments)
				.values({
					installmentId: item.id,
					amountCents: item.totalCents,
					source: "operator",
				})
				.returning({ id: payments.id });
			const now = new Date();
			await tx
				.update(installments)
				.set({ status: "paid", paidCents: item.totalCents, paidAt: now })
				.where(eq(installments.id, item.id));
			// Paying an installment closes its open alerts (FR-9.1).
			await tx
				.update(ewsAlerts)
				.set({ status: "closed" })
				.where(and(eq(ewsAlerts.installmentId, item.id), eq(ewsAlerts.status, "open")));
			const all = await tx
				.select({
					status: installments.status,
					dueDate: installments.dueDate,
					principalCents: installments.principalCents,
				})
				.from(installments)
				.where(eq(installments.loanId, id));
			const { status, nextDueDate, outstandingCents } = loanRollup(all);
			await tx.update(loans).set({ status, nextDueDate, outstandingCents }).where(eq(loans.id, id));
			await writeAudit(tx, {
				applicationId: loan.applicationId,
				loanId: id,
				actor: me.id,
				action: "payment.posted",
				entity: "payment",
				payload: {
					paymentId: payment.id,
					loanId: id,
					installmentId: item.id,
					amountCents: item.totalCents,
					status,
					demo: true,
				},
			});
			await insertOutbox(tx, {
				type: "payment.posted",
				key: id,
				payload: {
					paymentId: payment.id,
					loanId: id,
					installmentId: item.id,
					amountCents: item.totalCents,
				},
				dedupeKey: dedupePaymentPosted(payment.id),
				applicationId: loan.applicationId,
				loanId: id,
			});
			return { paymentId: payment.id, status, outstandingCents, nextDueDate };
		});
		return c.json({ ...result, loanId: id });
	});

	app.post("/api/demo/loans/:id/age", demo, async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		if (!UUID_RE.test(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const parsed = ageSchema.safeParse(await readJson(c));
		if (!parsed.success) {
			throw new HttpError(400, "VALIDATION_ERROR", "invalid age request", zodFields(parsed.error));
		}
		const { days, installmentId } = parsed.data;
		const aged = await withTx(db, async (tx) => {
			// Same installments → loans order as pay/monitoring (see above).
			await tx
				.select({ id: installments.id })
				.from(installments)
				.where(eq(installments.loanId, id))
				.for("update");
			const loanRows = await tx.select().from(loans).where(eq(loans.id, id)).for("update");
			const loan = loanRows[0];
			if (!loan) throw new HttpError(404, "NOT_FOUND", "not found");
			const moved = await tx
				.update(installments)
				.set({
					dueDate: sql`${installments.dueDate} - make_interval(days => ${days})`,
				})
				.where(
					and(
						eq(installments.loanId, id),
						inArray(installments.status, ["scheduled", "overdue"]),
						...(installmentId ? [eq(installments.id, installmentId)] : []),
					),
				)
				.returning({ id: installments.id });
			const unpaid = await tx
				.select({ dueDate: installments.dueDate, status: installments.status })
				.from(installments)
				.where(eq(installments.loanId, id));
			await tx
				.update(loans)
				.set({
					nextDueDate: computeNextDueDate(
						unpaid.map((i) => ({ dueDate: i.dueDate, status: i.status })),
					),
				})
				.where(eq(loans.id, id));
			await writeAudit(tx, {
				applicationId: loan.applicationId,
				loanId: id,
				actor: me.id,
				action: "loan.aged",
				entity: "loan",
				payload: { loanId: id, days, aged: moved.length, demo: true },
			});
			return moved.length;
		});
		// Then run monitoring synchronously and return its counts (FR-8.5).
		try {
			const { counts, workflowId, timedOut } = await gateway.runMonitoring(true);
			if (timedOut) return c.json({ aged, workflowId }, 202);
			return c.json({ aged, ...counts, workflowId });
		} catch (err) {
			if (err instanceof GatewayError) throw new HttpError(err.status, err.code, err.message);
			throw err;
		}
	});

	return app;
}
