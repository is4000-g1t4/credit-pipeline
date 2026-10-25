// EN-01/EN-02 case access for case-assist routes.
//
// Officers may open any non-draft case that is not actively assigned to
// another officer (the same need-to-know rule research uses). Document
// evidence has a stricter ACL: only the assigned officer gets document text;
// everyone else sees a typed `access_denied` source instead.
import { applications, caseAccessGrants, type Db } from "@credit/db/applications";
import { HttpError } from "@credit/service-kit";
import { and, eq, isNotNull, isNull } from "drizzle-orm";

export type AssistRole = "applicant" | "officer" | "service";

export interface AssistActor {
	id: string;
	email: string;
	role: AssistRole;
}

export interface AccessibleCase {
	application: typeof applications.$inferSelect;
	/** True when the caller holds the active assigned_officer grant. */
	assignedToMe: boolean;
}

/** Officer case access; applicant/service callers are 403, missing/draft
 * cases and another officer's assigned case are non-leaking 404. */
export async function requireAssistCaseAccess(
	db: Db,
	applicationId: string,
	user: AssistActor,
): Promise<AccessibleCase> {
	if (user.role !== "officer") {
		throw new HttpError(403, "FORBIDDEN", "officer role required");
	}
	const rows = await db.select().from(applications).where(eq(applications.id, applicationId));
	const application = rows[0];
	if (!application || application.status === "draft") {
		throw new HttpError(404, "NOT_FOUND", "not found");
	}
	const grants = await db
		.select({ userId: caseAccessGrants.userId })
		.from(caseAccessGrants)
		.where(
			and(
				eq(caseAccessGrants.applicationId, applicationId),
				eq(caseAccessGrants.accessRole, "assigned_officer"),
				isNull(caseAccessGrants.revokedAt),
			),
		);
	const mine = grants.some((grant) => grant.userId === user.id);
	if (!mine && grants.length > 0) {
		throw new HttpError(404, "NOT_FOUND", "not found");
	}
	// A revoked officer may not self-restore access just because the case is
	// unassigned; only the service grant path can re-grant them.
	if (!mine) {
		const revoked = await db
			.select({ id: caseAccessGrants.id })
			.from(caseAccessGrants)
			.where(
				and(
					eq(caseAccessGrants.applicationId, applicationId),
					eq(caseAccessGrants.userId, user.id),
					isNotNull(caseAccessGrants.revokedAt),
				),
			)
			.limit(1);
		if (revoked.length > 0) throw new HttpError(404, "NOT_FOUND", "not found");
	}
	return { application, assignedToMe: mine };
}

/** Memo generation is a pre-decision action; terminal cases are 409. */
export function requireMemoableCase(kase: AccessibleCase): void {
	if (kase.application.status !== "pending_review") {
		throw new HttpError(409, "CASE_NOT_PENDING", "case is not awaiting an officer decision");
	}
}
