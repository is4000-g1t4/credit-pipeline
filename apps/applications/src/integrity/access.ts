// E2 access gates. Integrity is assigned-officer only; the fraud review uses
// the same case assignment (there is no separate reviewer user). Missing or
// stranger cases 404; applicants get 403 before any existence check.

import { and, eq, isNull } from "drizzle-orm";
import { applications, caseAccessGrants, type Db } from "@credit/db/applications";
import { HttpError, type ServiceVariables } from "@credit/service-kit";

export { isUuid } from "../ids.js";

export interface IntegrityActor {
	id: string;
	role: "applicant" | "officer" | "service";
}

export async function requireIntegrityCaseAccess(
	db: Db,
	applicationId: string,
	actor: IntegrityActor,
): Promise<typeof applications.$inferSelect> {
	if (actor.role !== "officer") {
		throw new HttpError(403, "FORBIDDEN", "officer role required");
	}
	const [application] = await db
		.select()
		.from(applications)
		.where(eq(applications.id, applicationId))
		.limit(1);
	if (!application || application.status === "draft") {
		throw new HttpError(404, "NOT_FOUND", "not found");
	}
	const grants = await db
		.select({ id: caseAccessGrants.id })
		.from(caseAccessGrants)
		.where(
			and(
				eq(caseAccessGrants.applicationId, applicationId),
				eq(caseAccessGrants.userId, actor.id),
				isNull(caseAccessGrants.revokedAt),
			),
		)
		.limit(1);
	if (grants.length === 0) throw new HttpError(404, "NOT_FOUND", "not found");
	if (!application.documentProcessingConsent) {
		throw new HttpError(403, "CONSENT_REQUIRED", "document processing consent is required");
	}
	return application;
}

export async function requireFraudOfficer(
	db: Db,
	actor: IntegrityActor,
): Promise<{ reviewer: boolean }> {
	void db;
	if (actor.role !== "officer" && actor.role !== "service") {
		throw new HttpError(403, "FORBIDDEN", "officer role required");
	}
	return { reviewer: actor.role === "officer" || actor.role === "service" };
}

export function actorOf(c: { var: ServiceVariables }): IntegrityActor {
	return { id: c.var.user.id, role: c.var.user.role as IntegrityActor["role"] };
}
