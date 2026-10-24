// Monitoring integration (compose): real loans-DB fixtures — one scheduled
// installment past due, one pre-existing overdue gap (reconcile path), one
// future control. First run marks + alerts both; second run is a no-op.
// Application/user ids are synthetic uuids (no cross-DB rows needed).
//
// Dev-worker race: a locally running worker shares this compose DB and its
// monitoring sweep may mark our fixtures before our first call (the sweep
// is idempotent, so the end state is identical). The test polls the sweep
// until our loan converges and asserts the per-loan end state — global
// counts are shared with any dev worker and are not asserted exactly.

import { randomUUID } from "node:crypto";
import { ewsAlerts, installments, loans } from "@credit/db/loans";
import { auditLog, outboxEvents } from "@credit/db/shared";
import { asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMonitoring } from "../../src/activities/monitoring.js";
import { closeDb } from "../../src/db.js";
import { isoDay, testLoansDb, waitFor } from "./helpers.js";

const { db, sql } = testLoansDb();

const tag = randomUUID().slice(0, 8);
const applicationId = randomUUID();
const applicantUserId = randomUUID();
let loanId = "";
const dueA = isoDay(-1); // scheduled + past due → marked overdue
const dueB = isoDay(-5); // already overdue, no alert → reconciled
const dueC = isoDay(1); // scheduled + future → untouched
const PRINCIPALS = { a: 25000, b: 26000, c: 27000 };

beforeAll(async () => {
	[loanId] = await db
		.insert(loans)
		.values({
			applicationId,
			applicationReference: `APP-T-${tag.toUpperCase()}`,
			applicantUserId,
			product: "personal_loan",
			principalCents: 1200000,
			termMonths: 48,
			rateBps: 650,
			monthlyPaymentCents: 28458,
			status: "active",
			disbursedAt: new Date(),
			outstandingCents: 1200000,
			nextDueDate: dueC,
		})
		.returning({ id: loans.id })
		.then((r) => r.map((x) => x.id));
	await db.insert(installments).values([
		{
			loanId,
			number: 1,
			dueDate: dueA,
			principalCents: PRINCIPALS.a,
			interestCents: 2000,
			totalCents: PRINCIPALS.a + 2000,
			paidCents: 0,
			status: "scheduled",
		},
		{
			loanId,
			number: 2,
			dueDate: dueB,
			principalCents: PRINCIPALS.b,
			interestCents: 2000,
			totalCents: PRINCIPALS.b + 2000,
			paidCents: 0,
			status: "overdue",
		},
		{
			loanId,
			number: 3,
			dueDate: dueC,
			principalCents: PRINCIPALS.c,
			interestCents: 2000,
			totalCents: PRINCIPALS.c + 2000,
			paidCents: 0,
			status: "scheduled",
		},
	]);
});

afterAll(async () => {
	try {
		if (loanId) {
			await db.delete(auditLog).where(eq(auditLog.loanId, loanId));
			await db.delete(ewsAlerts).where(eq(ewsAlerts.loanId, loanId));
			await db.delete(outboxEvents).where(eq(outboxEvents.key, loanId));
			await db.delete(installments).where(eq(installments.loanId, loanId));
			await db.delete(loans).where(eq(loans.id, loanId));
		}
	} finally {
		await closeDb();
		await sql.end();
	}
});

describe("runMonitoring (integration)", () => {
	it("marks overdue, alerts both gaps, recomputes the loan; rerun no-ops", async () => {
		const today = isoDay(0);
		// Poll the sweep until our fixtures converge — whoever runs the
		// marking (us or a dev worker), the idempotent end state matches.
		await waitFor("sweep marks fixtures", async () => {
			await runMonitoring({ todayUtc: today });
			const states = await db
				.select({ status: installments.status })
				.from(installments)
				.where(eq(installments.loanId, loanId));
			return states.filter((s) => s.status === "overdue").length === 2;
		});

		const alerts = await db.select().from(ewsAlerts).where(eq(ewsAlerts.loanId, loanId));
		expect(alerts).toHaveLength(2);
		for (const alert of alerts) {
			expect(alert).toMatchObject({
				type: "payment_overdue",
				severity: "medium",
				status: "open",
			});
		}

		const outbox = await db
			.select()
			.from(outboxEvents)
			.where(
				inArray(
					outboxEvents.dedupeKey,
					alerts.map((a) => `ews.alert:${a.id}`),
				),
			);
		expect(outbox).toHaveLength(2);
		for (const row of outbox) {
			expect(row.topic).toBe("credit.ews.alert");
			expect(row.publishedAt).toBeNull();
		}

		const [loan] = await db.select().from(loans).where(eq(loans.id, loanId));
		expect(loan?.status).toBe("overdue");
		expect(loan?.nextDueDate).toBe(dueB); // earliest unpaid
		expect(loan?.outstandingCents).toBe(PRINCIPALS.a + PRINCIPALS.b + PRINCIPALS.c);

		// Per-loan delta: both past-due installments overdue, future untouched.
		const states = await db
			.select({ dueDate: installments.dueDate, status: installments.status })
			.from(installments)
			.where(eq(installments.loanId, loanId));
		expect(states.filter((s) => s.status === "overdue")).toHaveLength(2);
		expect(states.find((s) => s.dueDate === dueC)?.status).toBe("scheduled");

		const audits = await db.select().from(auditLog).where(eq(auditLog.loanId, loanId));
		expect(audits.filter((a) => a.action === "ews.alert")).toHaveLength(2);

		const beforeSecond = await db
			.select({ id: installments.id, status: installments.status })
			.from(installments)
			.where(eq(installments.loanId, loanId))
			.orderBy(asc(installments.id));
		const outboxBefore = await db
			.select({ id: outboxEvents.id })
			.from(outboxEvents)
			.where(eq(outboxEvents.key, loanId));
		const auditsBefore = await db.select().from(auditLog).where(eq(auditLog.loanId, loanId));

		await runMonitoring({ todayUtc: today });
		// Per-loan no-op: this loan gains no alerts, outbox rows, audits, or
		// status changes on rerun. (Global counts may include other loans
		// sharing the compose DB, so they are not asserted exactly.)
		const afterSecond = await db
			.select({ id: ewsAlerts.id })
			.from(ewsAlerts)
			.where(eq(ewsAlerts.loanId, loanId));
		expect(afterSecond).toHaveLength(2);
		const outboxAfter = await db
			.select({ id: outboxEvents.id })
			.from(outboxEvents)
			.where(eq(outboxEvents.key, loanId));
		expect(outboxAfter).toHaveLength(outboxBefore.length);
		expect(outboxAfter).toHaveLength(2);
		const auditsAfter = await db.select().from(auditLog).where(eq(auditLog.loanId, loanId));
		expect(auditsAfter).toHaveLength(auditsBefore.length);
		expect(auditsAfter.filter((a) => a.action === "ews.alert")).toHaveLength(2);
		const afterStatuses = await db
			.select({ id: installments.id, status: installments.status })
			.from(installments)
			.where(eq(installments.loanId, loanId))
			.orderBy(asc(installments.id));
		expect(afterStatuses).toEqual(beforeSecond);
	});
});
