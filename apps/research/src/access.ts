// T00 case-level authorization for sensitive research (credit_research).
// Officers self-claim `assigned_officer` on first run; only `service` may
// grant/revoke the specialist roles (enforced by `requireService` on the
// routes — these helpers take the caller as data). Every read/write and
// every grant/revoke/claim/denial appends one `research_audit_log` row with
// ids and codes only, never PII. Audit writes are never caught: if the
// audit insert fails the request fails instead of silently dropping
// security history.
import {
	researchAccessGrants,
	researchAuditLog,
	withTx,
	type Db,
	type Tx,
} from "@credit/db/research";
import { HttpError } from "@credit/service-kit";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { getRun, type RunRow } from "./lifecycle.js";
import { isUuid } from "./ids.js";

export const ACCESS_ROLES = [
	"assigned_officer",
	"compliance",
	"policy_owner",
	"safeguarding",
] as const;

export type AccessRole = (typeof ACCESS_ROLES)[number];

export type AuditAction =
	| "run.ensure"
	| "run.read"
	| "run.view"
	| "finding.review"
	| "bundle.read"
	| "access.grant"
	| "access.revoke"
	| "access.claim"
	| "access.denied"
	| "auto.ensure"
	| "auto.duplicate"
	| "auto.skip"
	// T18 context stage (SPEC-t17-t18 §4): officer reads, denials, stage
	// completion/failure, retry, and per-signal reviews. D0 allowlist only.
	| "context.read"
	| "context.denied"
	| "context.completed"
	| "context.failed"
	| "context.retry"
	| "context.signal_review"
	| "context.purge";

export interface AuditInput {
	applicationId: string;
	runId?: string | null;
	actorId: string;
	actorRole: string;
	action: AuditAction;
	/** Ids and codes only — never names, emails, case facts, or quotes. */
	metadata?: Record<string, unknown>;
}

export type GrantRow = typeof researchAccessGrants.$inferSelect;

/** Append one audit row. Throws on failure so callers fail closed. */
export async function auditResearch(db: Db | Tx, input: AuditInput): Promise<void> {
	await db.insert(researchAuditLog).values({
		applicationId: input.applicationId,
		runId: input.runId ?? null,
		actorId: input.actorId,
		actorRole: input.actorRole,
		action: input.action,
		metadata: input.metadata ?? {},
	});
}

/** True when the user holds any active grant on the application. */
export async function hasResearchAccess(
	db: Db | Tx,
	applicationId: string,
	userId: string,
): Promise<boolean> {
	const rows = await db
		.select({ id: researchAccessGrants.id })
		.from(researchAccessGrants)
		.where(
			and(
				eq(researchAccessGrants.applicationId, applicationId),
				eq(researchAccessGrants.userId, userId),
				isNull(researchAccessGrants.revokedAt),
			),
		)
		.limit(1);
	return rows.length > 0;
}

/** Route guard: 404 (no disclosure) without an active grant. The denial
 * itself is audited before throwing, so cross-officer probes leave history.
 * Callers behind `requireOfficer` pass the officer role; applicants never
 * reach here (403 first). */
export async function requireResearchAccess(
	db: Db | Tx,
	applicationId: string,
	userId: string,
	actorRole = "officer",
): Promise<void> {
	if (!(await hasResearchAccess(db, applicationId, userId))) {
		await auditResearch(db, {
			applicationId,
			actorId: userId,
			actorRole,
			action: "access.denied",
		});
		throw new HttpError(404, "NOT_FOUND", "not found");
	}
}

/**
 * Pair run scoping with the grant guard for review routes that resolve the
 * run from a child row (finding/signal): unknown ids and cross-case runs
 * return the same non-disclosing 404 before any audit (the same shape as the
 * guard); only a grant denial is audited. Scope first, then guard. Returns
 * the scoped run for status checks.
 */
export async function requireRunAccess(
	db: Db,
	applicationId: string,
	runId: string,
	userId: string,
	actorRole = "officer",
): Promise<RunRow> {
	if (!isUuid(applicationId) || !isUuid(runId)) {
		throw new HttpError(404, "NOT_FOUND", "not found");
	}
	const run = await getRun(db, runId);
	if (!run || run.applicationId !== applicationId) {
		throw new HttpError(404, "NOT_FOUND", "not found");
	}
	await requireResearchAccess(db, applicationId, userId, actorRole);
	return run;
}

/**
 * Claim-on-first-run: the first officer to ensure a run owns the case.
 * Only the caller's own active `assigned_officer` grant authorizes ensure
 * (idempotent no-op). A caller holding only a specialist grant
 * (`compliance`, `policy_owner`, `safeguarding`) is denied with 404
 * (non-disclosure, audited) — specialists read via `hasResearchAccess`
 * (latest/view/bundle/audit) but never ensure. Another user's active
 * `assigned_officer` grant → 404 with an audited denial. A user with a
 * *revoked* grant for the application may not self-claim (audited
 * denial/404): only the service `grantResearchAccess` path may re-grant
 * them. Advisory lock serializes concurrent first claims.
 *
 * The denial audit writes outside the claim transaction: the tx callback
 * throws to reject the claim, and `db.transaction` rolls back everything
 * it did — so auditing inside would silently lose the denial. (The grant +
 * claim audit on success commit together, atomically.)
 */
/** Thrown inside the claim tx to reject a cross-officer claim; caught
 * outside so the denial audit commits instead of rolling back. */
class ClaimDenied {
	constructor(readonly accessRole: string) {}
}

export async function claimOfficerAccess(
	db: Db,
	applicationId: string,
	officerId: string,
): Promise<{ claimed: boolean }> {
	try {
		return await withTx(db, async (tx) => {
			await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${applicationId}))`);
			const active = await tx
				.select()
				.from(researchAccessGrants)
				.where(
					and(
						eq(researchAccessGrants.applicationId, applicationId),
						isNull(researchAccessGrants.revokedAt),
					),
				);
			// Only the claimant's own active `assigned_officer` grant authorizes ensure (idempotent). A specialist-only holder is denied — specialists read via `hasResearchAccess`, never ensure. This precedes the owner check so a co-owner is never blocked by the first, and precedes the revoked check so a service re-grant's live row wins over its revoked history.
			const own = active.find((g) => g.userId === officerId);
			if (own) {
				if (own.accessRole === "assigned_officer") return { claimed: false };
				throw new ClaimDenied(own.accessRole);
			}
			// Another user's active `assigned_officer` blocks the claim; other users' specialist-only grants never do.
			const owner = active.find((g) => g.accessRole === "assigned_officer");
			if (owner) throw new ClaimDenied(owner.accessRole);
			// A revoked grant for this application blocks self-claim: only
			// the service grant path may re-grant a revoked user.
			const revoked = await tx
				.select({ accessRole: researchAccessGrants.accessRole })
				.from(researchAccessGrants)
				.where(
					and(
						eq(researchAccessGrants.applicationId, applicationId),
						eq(researchAccessGrants.userId, officerId),
						isNotNull(researchAccessGrants.revokedAt),
					),
				)
				.limit(1);
			if (revoked[0]) throw new ClaimDenied(revoked[0].accessRole);
			// Otherwise this officer owns the case from here.
			await tx.insert(researchAccessGrants).values({
				applicationId,
				userId: officerId,
				accessRole: "assigned_officer",
				grantedBy: officerId,
			});
			await auditResearch(tx, {
				applicationId,
				actorId: officerId,
				actorRole: "officer",
				action: "access.claim",
				metadata: { accessRole: "assigned_officer" },
			});
			return { claimed: true };
		});
	} catch (err) {
		if (err instanceof ClaimDenied) {
			await auditResearch(db, {
				applicationId,
				actorId: officerId,
				actorRole: "officer",
				action: "access.denied",
				metadata: { accessRole: err.accessRole },
			});
			throw new HttpError(404, "NOT_FOUND", "not found");
		}
		throw err;
	}
}

/**
 * T11 claim-on-read: auto-triggered runs carry no officer grant, so the
 * first officer to open one claims `assigned_officer` via T00
 * `claimOfficerAccess` (audited); any later officer gets the same 404
 * non-disclosure as a cross-officer probe. No run for the application →
 * plain `requireResearchAccess` (404 + audited denial, no orphan grant).
 */
export async function requireOrClaimResearchAccess(
	db: Db,
	applicationId: string,
	officerId: string,
	actorRole = "officer",
): Promise<void> {
	if (await hasResearchAccess(db, applicationId, officerId)) return;
	const runs = (await db.execute(
		sql`SELECT id FROM agent_runs WHERE application_id = ${applicationId} LIMIT 1`,
	)) as unknown as Array<{ id: string }>;
	if (runs.length === 0) {
		await requireResearchAccess(db, applicationId, officerId, actorRole);
		return;
	}
	await claimOfficerAccess(db, applicationId, officerId);
}

/**
 * Service-only grant (the route enforces `requireService`). Re-granting an
 * active holder updates the role instead of duplicating; a revoked holder
 * may be granted again. Every grant is audited with ids/roles only.
 */
export async function grantResearchAccess(
	db: Db,
	input: {
		applicationId: string;
		userId: string;
		accessRole: AccessRole;
		grantedBy: string;
		granterRole: string;
	},
): Promise<GrantRow> {
	return withTx(db, async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.applicationId}))`);
		const existing = await tx
			.select()
			.from(researchAccessGrants)
			.where(
				and(
					eq(researchAccessGrants.applicationId, input.applicationId),
					eq(researchAccessGrants.userId, input.userId),
					isNull(researchAccessGrants.revokedAt),
				),
			)
			.limit(1);
		let row: GrantRow;
		if (existing[0]) {
			const [updated] = await tx
				.update(researchAccessGrants)
				.set({ accessRole: input.accessRole, grantedBy: input.grantedBy })
				.where(eq(researchAccessGrants.id, existing[0].id))
				.returning();
			row = updated;
		} else {
			const [inserted] = await tx
				.insert(researchAccessGrants)
				.values({
					applicationId: input.applicationId,
					userId: input.userId,
					accessRole: input.accessRole,
					grantedBy: input.grantedBy,
				})
				.returning();
			row = inserted;
		}
		await auditResearch(tx, {
			applicationId: input.applicationId,
			actorId: input.grantedBy,
			actorRole: input.granterRole,
			action: "access.grant",
			metadata: { targetUserId: input.userId, accessRole: input.accessRole },
		});
		return row;
	});
}

/** Service-only revoke. No active grant → 404. The revoke is audited. */
export async function revokeResearchAccess(
	db: Db,
	input: { applicationId: string; userId: string; revokedBy: string; revokerRole: string },
): Promise<void> {
	return withTx(db, async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.applicationId}))`);
		const [revoked] = await tx
			.update(researchAccessGrants)
			.set({ revokedAt: new Date() })
			.where(
				and(
					eq(researchAccessGrants.applicationId, input.applicationId),
					eq(researchAccessGrants.userId, input.userId),
					isNull(researchAccessGrants.revokedAt),
				),
			)
			.returning({ id: researchAccessGrants.id, accessRole: researchAccessGrants.accessRole });
		if (!revoked) throw new HttpError(404, "NOT_FOUND", "not found");
		await auditResearch(tx, {
			applicationId: input.applicationId,
			actorId: input.revokedBy,
			actorRole: input.revokerRole,
			action: "access.revoke",
			metadata: { targetUserId: input.userId, accessRole: revoked.accessRole },
		});
	});
}
