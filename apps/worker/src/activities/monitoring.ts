// Monitoring sweep (SPEC FR-6.5): ONE transaction — lock due installments,
// conditionally mark them overdue, alert every overdue installment that
// lacks one (newly marked + pre-existing), recompute affected loans, audit
// and outbox each inserted alert. Re-running with the same data writes
// nothing (alert unique + conditional update), so schedule/manual overlap
// is safe. Outstanding = principal of unpaid installments (booking sets it
// to the principal, so the recompute stays consistent).

import { computeNextDueDate, dedupeEwsAlert, deriveLoanStatus } from "@credit/core";
import { ewsAlerts, installments, loans, withTx } from "@credit/db/loans";
import { and, eq, inArray, lte } from "drizzle-orm";
import { getLoansDb } from "../db.js";
import { insertOutbox, writeAudit } from "@credit/service-kit";
import type { MonitoringResult } from "./types.js";

export async function runMonitoring(input: { todayUtc: string }): Promise<MonitoringResult> {
	const { db } = getLoansDb();
	return withTx(db, async (tx) => {
		// Lock today's due rows; concurrent runs get disjoint sets.
		const due = await tx
			.select({ id: installments.id, loanId: installments.loanId })
			.from(installments)
			.where(and(eq(installments.status, "scheduled"), lte(installments.dueDate, input.todayUtc)))
			.for("update", { skipLocked: true });

		// Conditional update on the locked ids only — never touches rows a
		// concurrent run locked, never re-marks an already-overdue row.
		const marked =
			due.length === 0
				? []
				: await tx
						.update(installments)
						.set({ status: "overdue" })
						.where(
							and(
								eq(installments.status, "scheduled"),
								inArray(
									installments.id,
									due.map((d) => d.id),
								),
							),
						)
						.returning({ id: installments.id, loanId: installments.loanId });

		// Reconcile: every overdue installment without a payment_overdue
		// alert needs one — covers the rows just marked plus any older gap.
		// The alert unique (installment_id, type) + ON CONFLICT DO NOTHING
		// makes concurrent inserts converge: only the winner returns a row,
		// and only the winner writes audit/outbox below.
		const missing = await tx
			.select({ id: installments.id, loanId: installments.loanId })
			.from(installments)
			.where(eq(installments.status, "overdue"));

		const withAlert = new Set<string>();
		if (missing.length > 0) {
			const existing = await tx
				.select({ installmentId: ewsAlerts.installmentId })
				.from(ewsAlerts)
				.where(
					inArray(
						ewsAlerts.installmentId,
						missing.map((m) => m.id),
					),
				);
			for (const row of existing) {
				if (row.installmentId) withAlert.add(row.installmentId);
			}
		}

		const loanIds = new Map<string, string>();
		for (const m of missing) loanIds.set(m.loanId, m.loanId);
		for (const m of marked) loanIds.set(m.loanId, m.loanId);
		const loanRows =
			loanIds.size === 0
				? []
				: await tx
						.select({ id: loans.id, applicationId: loans.applicationId })
						.from(loans)
						.where(inArray(loans.id, [...loanIds.keys()]));
		const appByLoan = new Map(loanRows.map((l) => [l.id, l.applicationId]));

		let alertsCreated = 0;
		const touched = new Set(marked.map((m) => m.loanId));
		for (const m of missing) {
			if (withAlert.has(m.id)) continue;
			const inserted = await tx
				.insert(ewsAlerts)
				.values({
					loanId: m.loanId,
					installmentId: m.id,
					type: "payment_overdue",
					severity: "medium",
					status: "open",
					details: { installmentId: m.id, dueDate: input.todayUtc },
				})
				// No arbiter: the (installment_id, type) unique is partial
				// (WHERE installment_id IS NOT NULL), which Postgres won't
				// match to a column-only ON CONFLICT target.
				.onConflictDoNothing()
				.returning({ id: ewsAlerts.id });
			const alertId = inserted[0]?.id;
			if (!alertId) continue; // lost a race: the winner alerted already
			alertsCreated++;
			touched.add(m.loanId);
			const applicationId = appByLoan.get(m.loanId);
			await writeAudit(tx, {
				...(applicationId !== undefined ? { applicationId } : {}),
				loanId: m.loanId,
				actor: "system",
				action: "ews.alert",
				entity: "ews_alert",
				payload: {
					alertId,
					loanId: m.loanId,
					installmentId: m.id,
					alertType: "payment_overdue",
					severity: "medium",
				},
			});
			await insertOutbox(tx, {
				type: "ews.alert",
				key: m.loanId,
				payload: {
					alertId,
					loanId: m.loanId,
					installmentId: m.id,
					alertType: "payment_overdue",
					severity: "medium",
				},
				dedupeKey: dedupeEwsAlert(alertId),
				...(applicationId !== undefined ? { applicationId } : {}),
				loanId: m.loanId,
			});
		}

		// Recompute every loan this run changed with the core status helper.
		// Untouched loans are left alone, so a no-op rerun writes nothing.
		let loansUpdated = 0;
		for (const loanId of touched) {
			const items = await tx
				.select({
					status: installments.status,
					dueDate: installments.dueDate,
					principalCents: installments.principalCents,
				})
				.from(installments)
				.where(eq(installments.loanId, loanId));
			const status = deriveLoanStatus(items.map((i) => ({ status: i.status })));
			const nextDueDate = computeNextDueDate(
				items.map((i) => ({ dueDate: i.dueDate, status: i.status })),
			);
			const outstandingCents = items
				.filter((i) => i.status !== "paid")
				.reduce((sum, i) => sum + i.principalCents, 0);
			await tx
				.update(loans)
				.set({ status, nextDueDate, outstandingCents })
				.where(eq(loans.id, loanId));
			loansUpdated++;
		}

		return {
			markedOverdue: marked.length,
			alertsCreated,
			loansUpdated,
		};
	});
}
