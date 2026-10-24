// Reconciler-store integration (compose): the real drizzleReconcilerStore
// terminal guards — markFailed/markExpired never overwrite a terminal
// status, a decision, or a loan — exercised against real Postgres, not the
// unit-test fake. Rows are uniquely scoped and cleaned up.
import { randomUUID } from "node:crypto";
import { applications, decisions } from "@credit/db/applications";
import { installments, loans } from "@credit/db/loans";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { drizzleReconcilerStore } from "../../src/reconciler.js";
import { closeDb } from "../../src/db.js";
import { testDb, testLoansDb } from "./helpers.js";

const appsHandle = testDb();
const loansHandle = testLoansDb();
const appsDb = appsHandle.db;
const loansDb = loansHandle.db;

const appIds: string[] = [];

async function seedApp(
	status: "submitted" | "processing" | "pending_review" | "booked" | "declined",
): Promise<string> {
	const [app] = await appsDb
		.insert(applications)
		.values({
			reference: `APP-RS-${randomUUID().slice(0, 8).toUpperCase()}`,
			applicantUserId: randomUUID(),
			type: "individual",
			product: "personal_loan",
			status,
			amountCents: 500000,
			termMonths: 24,
			purpose: "reconciler store guards",
			identity: {},
			financial: null,
			business: null,
			consents: [true, true, true],
			submittedAt: new Date(),
		})
		.returning({ id: applications.id });
	appIds.push(app.id);
	return app.id;
}

afterAll(async () => {
	try {
		for (const applicationId of appIds) {
			const loanRows = await loansDb
				.select({ id: loans.id })
				.from(loans)
				.where(eq(loans.applicationId, applicationId));
			for (const loan of loanRows) {
				await loansDb.delete(installments).where(eq(installments.loanId, loan.id));
				await loansDb.delete(loans).where(eq(loans.id, loan.id));
			}
			await appsDb.delete(decisions).where(eq(decisions.applicationId, applicationId));
			await appsDb.delete(applications).where(eq(applications.id, applicationId));
		}
	} finally {
		await closeDb();
		await appsHandle.sql.end();
		await loansHandle.sql.end();
	}
});

describe("drizzleReconcilerStore terminal guards (integration)", () => {
	it("markFailed never overwrites a terminal status", async () => {
		const store = drizzleReconcilerStore();
		const bookedId = await seedApp("booked");
		expect(await store.markFailed(bookedId, "workflow-ended-without-decision")).toBe(false);
		const [booked] = await appsDb
			.select({ status: applications.status })
			.from(applications)
			.where(eq(applications.id, bookedId));
		expect(booked?.status).toBe("booked");

		const declinedId = await seedApp("declined");
		expect(await store.markFailed(declinedId, "workflow-ended-without-decision")).toBe(false);
		const [declined] = await appsDb
			.select({ status: applications.status })
			.from(applications)
			.where(eq(applications.id, declinedId));
		expect(declined?.status).toBe("declined");
	});

	it("markExpired never overwrites a non-pending status", async () => {
		const store = drizzleReconcilerStore();
		const processingId = await seedApp("processing");
		expect(await store.markExpired(processingId)).toBe(false);
		const [row] = await appsDb
			.select({ status: applications.status })
			.from(applications)
			.where(eq(applications.id, processingId));
		expect(row?.status).toBe("processing");
	});

	it("markFailed passes a stale non-terminal case with no decision or loan", async () => {
		const store = drizzleReconcilerStore();
		const id = await seedApp("submitted");
		expect(await store.markFailed(id, "workflow-ended-without-decision")).toBe(true);
		const [row] = await appsDb
			.select({ status: applications.status })
			.from(applications)
			.where(eq(applications.id, id));
		expect(row?.status).toBe("failed");
	});

	it("markFailed refuses a case that already has a decision", async () => {
		const store = drizzleReconcilerStore();
		const id = await seedApp("processing");
		await appsDb.insert(decisions).values({
			applicationId: id,
			outcome: "declined",
			decidedBy: "system",
			reasons: [{ code: "SCORE_TOO_LOW", text: "too low" }],
			snapshot: {},
		});
		expect(await store.markFailed(id, "workflow-ended-without-decision")).toBe(false);
		const [row] = await appsDb
			.select({ status: applications.status })
			.from(applications)
			.where(eq(applications.id, id));
		expect(row?.status).toBe("processing");
	});
});
