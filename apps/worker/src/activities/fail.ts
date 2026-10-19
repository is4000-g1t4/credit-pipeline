// markFailed (SPEC FR-6.10/§3.5): conditional UPDATE on credit_applications
// from non-terminal states with no decision, plus a credit_loans existence
// check; otherwise a no-op. failed is not a decision — audit only when the
// row actually flips.
//
// No cross-DB transaction exists, so the loan check is check-then-act. The
// race it leaves (loan booked between check and update) cannot fire from
// one workflow's sequential activities, and the reconciler only touches
// stale/ended workflows — a booking that far along has either committed
// its terminal status (conditional update no-ops) or failed outright.
import { applications, decisions, withTx } from "@credit/db/applications";
import { loans } from "@credit/db/loans";
import { and, eq, exists, inArray, not } from "drizzle-orm";
import { getApplicationsDb, getLoansDb } from "../db.js";
import { writeAudit } from "@credit/service-kit";
import type { MarkFailedResult } from "./types.js";

export async function markFailed(input: {
	applicationId: string;
	reason: string;
}): Promise<MarkFailedResult> {
	const loanRows = await getLoansDb()
		.db.select({ id: loans.id })
		.from(loans)
		.where(eq(loans.applicationId, input.applicationId));
	if (loanRows[0]) return { marked: false };
	const { db } = getApplicationsDb();
	return withTx(db, async (tx) => {
		const updated = await tx
			.update(applications)
			.set({ status: "failed", failedReason: input.reason.slice(0, 500) })
			.where(
				and(
					eq(applications.id, input.applicationId),
					inArray(applications.status, ["submitted", "processing", "pending_review"]),
					not(
						exists(
							tx
								.select({ id: decisions.id })
								.from(decisions)
								.where(eq(decisions.applicationId, input.applicationId)),
						),
					),
				),
			)
			.returning({ id: applications.id });
		if (!updated[0]) return { marked: false };
		await writeAudit(tx, {
			applicationId: input.applicationId,
			actor: "system",
			action: "application.failed",
			entity: "application",
			payload: { reason: input.reason.slice(0, 500) },
		});
		return { marked: true };
	});
}
