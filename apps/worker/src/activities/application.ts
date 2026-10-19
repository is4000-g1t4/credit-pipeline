// Application loading (SPEC FR-6.1 step 1, FR-6.10): the submitted→processing
// transition happens only via WHERE status='submitted'; terminal states
// return null (workflow exits untouched); processing|pending_review re-entry
// continues idempotently.

import { isTerminal } from "@credit/core";
import { applications } from "@credit/db/applications";
import { and, eq } from "drizzle-orm";
import { getApplicationsDb } from "../db.js";
import type { ApplicationDto } from "./types.js";

export type ApplicationRow = typeof applications.$inferSelect;

export async function loadApplicationRow(applicationId: string): Promise<ApplicationRow> {
	const { db } = getApplicationsDb();
	const rows = await db.select().from(applications).where(eq(applications.id, applicationId));
	const row = rows[0];
	if (!row) throw new Error(`application not found: ${applicationId}`);
	return row;
}

export function toApplicationDto(row: ApplicationRow): ApplicationDto {
	return {
		id: row.id,
		reference: row.reference,
		type: row.type,
		product: row.product,
		status: row.status,
		amountCents: row.amountCents,
		termMonths: row.termMonths,
		purpose: row.purpose,
		identity: row.identity,
		financial: row.financial,
		business: row.business,
		submittedAt: row.submittedAt.toISOString(),
		decidedAt: row.decidedAt?.toISOString() ?? null,
	};
}

export async function loadApplicationAndSetProcessing(input: {
	applicationId: string;
}): Promise<ApplicationDto | null> {
	const { db } = getApplicationsDb();
	const updated = await db
		.update(applications)
		.set({ status: "processing" })
		.where(and(eq(applications.id, input.applicationId), eq(applications.status, "submitted")))
		.returning();
	if (updated[0]) return toApplicationDto(updated[0]);
	const row = await loadApplicationRow(input.applicationId);
	if (isTerminal(row.status)) return null;
	return toApplicationDto(row);
}

export async function loadApplication(input: { applicationId: string }): Promise<ApplicationDto> {
	return toApplicationDto(await loadApplicationRow(input.applicationId));
}
