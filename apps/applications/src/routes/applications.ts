// Intake (SPEC FR-1.7/1.8): idempotent submit with the advisory lock FIRST
// inside the transaction, then key resolution, then the 3-active limit, then
// the insert. A concurrent same-key insert that trips the unique constraint
// is re-read outside the aborted transaction and replayed — never a 500.
//
// Identity comes from the signed internal headers (requireInternal sets
// `c.var.user`); there is no session/cookie logic here. The detail response
// omits the loan summary — the P1b gateway composes it from loans-service
// via GET /internal/loans/by-application/:id.
import {
	applicationCreateSchema,
	dedupeApplicationSubmitted,
	DOCUMENT_CONSENT_VERSION,
	generateReference,
	hashCanonical,
	isAdult,
} from "@credit/core";
import {
	applications,
	auditLog,
	customerProfiles,
	decisions,
	documentFiles,
	documents,
	externalReports,
	fraudReviews,
	idempotencyKeys,
	kycChecks,
	policyEvaluations,
	scores,
	withTx,
	type Db,
} from "@credit/db/applications";
import {
	HttpError,
	insertOutbox,
	readJson,
	writeAudit,
	zodFields,
	type Logger,
	type ServiceApp,
	type WorkflowGateway,
} from "@credit/service-kit";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { isUniqueViolation } from "../documents/pipeline.js";
import { isUuid, readIdempotencyReplay } from "../ids.js";

const documentConsentSchema = z.object({ consent: z.boolean() }).strict();

function summarize(row: typeof applications.$inferSelect): Record<string, unknown> {
	return {
		id: row.id,
		reference: row.reference,
		type: row.type,
		product: row.product,
		status: row.status,
		amountCents: row.amountCents,
		termMonths: row.termMonths,
		// T17: drafts carry submittedAt=null; direct-create rows stay non-null.
		submittedAt: row.submittedAt?.toISOString() ?? null,
		decidedAt: row.decidedAt?.toISOString() ?? null,
	};
}

type DecisionRow = typeof decisions.$inferSelect;

/** Applicants see only their own outcome fields; officer-only internals
 * (officerUserId, requestId, snapshot, notes) stay officer-visible. */
function presentDecision(row: DecisionRow, role: string): Record<string, unknown> {
	if (role === "officer") return row;
	return {
		id: row.id,
		outcome: row.outcome,
		decidedBy: row.decidedBy,
		approvedAmountCents: row.approvedAmountCents,
		termMonths: row.termMonths,
		rateBps: row.rateBps,
		reasons: row.reasons,
		decidedAt: row.decidedAt,
	};
}

export interface ApplicationsRouteDeps {
	db: Db;
	gateway: WorkflowGateway;
	logger: Logger;
	/** T01 feature flag (SPEC-t01-t02 §10): exposed as `documentsEnabled`
	 * in the case detail so the UI can hide the panel when off. */
	documentsEnabled: boolean;
}

export function applicationsRoutes(deps: ApplicationsRouteDeps): ServiceApp {
	const app: ServiceApp = new Hono();
	const { db, gateway, logger, documentsEnabled } = deps;

	app.post("/api/applications", async (c) => {
		const me = c.var.user;
		if (me.role !== "applicant") {
			throw new HttpError(403, "FORBIDDEN", "applicants only");
		}
		// T17: direct create remains only for applicants with no customer
		// profile. Profiled customers must use draft → requirements → submit
		// (profile/KYC status does not change this guard).
		const owned = await db
			.select({ id: customerProfiles.id })
			.from(customerProfiles)
			.where(eq(customerProfiles.userId, me.id))
			.limit(1);
		if (owned.length > 0) {
			throw new HttpError(409, "DRAFT_REQUIRED", "profiled applicants must use drafts");
		}
		const key = c.req.header("Idempotency-Key")?.trim();
		if (!key) {
			throw new HttpError(400, "MISSING_IDEMPOTENCY_KEY", "Idempotency-Key header is required");
		}
		const body = await readJson(c);
		const parsed = applicationCreateSchema.safeParse(body);
		if (!parsed.success) {
			throw new HttpError(400, "VALIDATION_ERROR", "invalid application", zodFields(parsed.error));
		}
		const data = parsed.data;
		const now = new Date();
		if (!isAdult(data.identity.dob, now)) {
			throw new HttpError(400, "VALIDATION_ERROR", "invalid application", {
				"identity.dob": ["owner must be 18 or older"],
			});
		}
		if (data.identity.email.toLowerCase() !== me.email.toLowerCase()) {
			throw new HttpError(400, "VALIDATION_ERROR", "invalid application", {
				"identity.email": ["must match the signed-in email"],
			});
		}
		const requestHash = hashCanonical(body);

		// Fast path: exact replay without a write transaction.
		const fast = await readIdempotencyReplay(db, { userId: me.id, key, requestHash });
		if (fast) return c.json(fast, 201);

		let outcome: { id: string; reference: string };
		let replayed = true;
		try {
			outcome = await withTx(db, async (tx) => {
				await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${me.id}))`);
				const rows = await tx
					.select()
					.from(idempotencyKeys)
					.where(and(eq(idempotencyKeys.userId, me.id), eq(idempotencyKeys.key, key)));
				const existing = rows[0];
				if (existing) {
					if (existing.requestHash !== requestHash) {
						throw new HttpError(
							409,
							"IDEMPOTENCY_CONFLICT",
							"Idempotency-Key was already used with a different payload",
						);
					}
					return existing.response as { id: string; reference: string };
				}
				const active = await tx
					.select({ id: applications.id })
					.from(applications)
					.where(
						and(
							eq(applications.applicantUserId, me.id),
							inArray(applications.status, ["submitted", "processing", "pending_review"]),
						),
					);
				if (active.length >= 3) {
					throw new HttpError(409, "TOO_MANY_APPLICATIONS", "at most 3 non-terminal applications");
				}
				// Reference is random-unique; retry once on a freak collision.
				let inserted: { id: string; reference: string } | null = null;
				let lastErr: unknown = null;
				for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
					try {
						const [row] = await tx
							.insert(applications)
							.values({
								reference: generateReference(now.getUTCFullYear()),
								applicantUserId: me.id,
								type: data.type,
								product: data.product,
								status: "submitted",
								amountCents: data.amountCents,
								termMonths: data.termMonths,
								purpose: data.purpose,
								identity: data.identity,
								financial: data.individual ?? null,
								business: data.sme ?? null,
								consents: data.consents,
								aiResearchConsent: data.aiResearchConsent,
								documentProcessingConsent: data.documentProcessingConsent,
								documentConsentAt: data.documentProcessingConsent ? now : null,
								documentConsentVersion: data.documentProcessingConsent
									? DOCUMENT_CONSENT_VERSION
									: null,
								submittedAt: now,
							})
							.returning({
								id: applications.id,
								reference: applications.reference,
							});
						inserted = row;
					} catch (err) {
						lastErr = err;
						if (!isUniqueViolation(err)) throw err;
					}
				}
				if (!inserted) throw lastErr;
				const response = { id: inserted.id, reference: inserted.reference };
				await tx.insert(idempotencyKeys).values({
					userId: me.id,
					key,
					requestHash,
					applicationId: inserted.id,
					response,
				});
				await writeAudit(tx, {
					applicationId: inserted.id,
					actor: me.id,
					action: "application.submitted",
					entity: "application",
					payload: {
						reference: inserted.reference,
						type: data.type,
						product: data.product,
						amountCents: data.amountCents,
						termMonths: data.termMonths,
					},
				});
				await insertOutbox(tx, {
					type: "application.submitted",
					key: inserted.id,
					payload: {
						applicationId: inserted.id,
						reference: inserted.reference,
						type: data.type,
						product: data.product,
						amountCents: data.amountCents,
						termMonths: data.termMonths,
					},
					dedupeKey: dedupeApplicationSubmitted(inserted.id),
					applicationId: inserted.id,
				});
				return response;
			});
			replayed = false;
		} catch (err) {
			if (err instanceof HttpError) throw err;
			// The tx aborted on a unique violation: a concurrent same-key
			// insert won the race. Re-read outside and replay on hash match.
			if (!isUniqueViolation(err)) throw err;
			const winner = await readIdempotencyReplay(db, { userId: me.id, key, requestHash });
			if (!winner) throw err;
			return c.json(winner, 201);
		}

		if (!replayed) {
			// After commit: start app-{id} (REJECT_DUPLICATE; AlreadyStarted is
			// success inside the gateway). Start failure leaves
			// workflow_started_at NULL for the reconciler (FR-1.8/6.9).
			try {
				await gateway.startApplication(outcome.id);
				await db
					.update(applications)
					.set({ workflowStartedAt: new Date() })
					.where(eq(applications.id, outcome.id));
			} catch (err) {
				logger.warn(
					{ applicationId: outcome.id, err },
					"workflow start failed; reconciler will repair",
				);
			}
		}
		return c.json(outcome, 201);
	});

	app.get("/api/applications", async (c) => {
		const me = c.var.user;
		const rawLimit = Number(c.req.query("limit") ?? 20);
		const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 20, 1), 100);
		const cursor = c.req.query("cursor");
		let cursorAt: Date | null = null;
		let cursorId = "";
		if (cursor) {
			const sep = cursor.indexOf(",");
			const at = sep < 0 ? null : new Date(cursor.slice(0, sep));
			if (sep < 0 || !at || Number.isNaN(at.getTime()) || !isUuid(cursor.slice(sep + 1))) {
				throw new HttpError(400, "INVALID_CURSOR", "cursor must be '<ISO-8601>,<uuid>'");
			}
			cursorAt = at;
			cursorId = cursor.slice(sep + 1);
		}
		const conditions = [
			...(me.role === "officer" ? [] : [eq(applications.applicantUserId, me.id)]),
			// T17: drafts never appear in officer lists/queue; owners see them.
			...(me.role === "officer" ? [sql`CAST(${applications.status} AS text) != 'draft'`] : []),
			...(cursorAt
				? [sql`(${applications.createdAt}, ${applications.id}) < (${cursorAt}, ${cursorId})`]
				: []),
		];
		const rows = await db
			.select()
			.from(applications)
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(desc(applications.createdAt), desc(applications.id))
			.limit(limit);
		const last = rows[rows.length - 1];
		return c.json({
			items: rows.map(summarize),
			nextCursor:
				rows.length === limit && last ? `${last.createdAt.toISOString()},${last.id}` : null,
		});
	});

	app.get("/api/applications/:id", async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		if (!isUuid(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const rows = await db.select().from(applications).where(eq(applications.id, id));
		const row = rows[0];
		// Cross-applicant access → 404, never 403 (FR-11.2). T17: officers
		// get 404 on drafts — drafts are owner-only until submitted.
		if (!row || (me.role !== "officer" && row.applicantUserId !== me.id)) {
			throw new HttpError(404, "NOT_FOUND", "not found");
		}
		if (row.status === "draft" && me.role === "officer") {
			throw new HttpError(404, "NOT_FOUND", "not found");
		}
		const [checks, reports, docs, scoreRows, policyRows, decisionRows] = await Promise.all([
			db.select().from(kycChecks).where(eq(kycChecks.applicationId, id)),
			db.select().from(externalReports).where(eq(externalReports.applicationId, id)),
			db.select().from(documents).where(eq(documents.applicationId, id)),
			db.select().from(scores).where(eq(scores.applicationId, id)),
			db.select().from(policyEvaluations).where(eq(policyEvaluations.applicationId, id)),
			db.select().from(decisions).where(eq(decisions.applicationId, id)),
		]);
		const audits = await db.select().from(auditLog).where(eq(auditLog.applicationId, id));
		// ponytail: the activity feed lives in the portfolio DB now — the
		// timeline is audit-only; every transition is still audited.
		const timeline = audits
			.map((a) => ({
				at: a.createdAt.toISOString(),
				kind: "audit" as const,
				actor: a.actor,
				action: a.action,
				entity: a.entity,
				payload: a.payload,
			}))
			.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
		return c.json({
			application: {
				...summarize(row),
				identity: row.identity,
				financial: row.financial,
				business: row.business,
				consents: row.consents,
				aiResearchConsent: row.aiResearchConsent,
				documentProcessingConsent: row.documentProcessingConsent,
				documentConsentAt: row.documentConsentAt?.toISOString() ?? null,
				documentConsentVersion: row.documentConsentVersion,
				contextAnalysisConsent: row.contextAnalysisConsent,
				contextConsentAt: row.contextConsentAt?.toISOString() ?? null,
				contextConsentVersion: row.contextConsentVersion,
				/** T01 feature flag (SPEC-t01-t02 §10): the panel hides when
				 * false; the mock `documents` checklist above is unaffected. */
				documentsEnabled,
				purpose: row.purpose,
				workflowStartedAt: row.workflowStartedAt?.toISOString() ?? null,
				failedReason: row.failedReason,
			},
			checks,
			externalReports: reports,
			documents: docs,
			score: scoreRows[0] ?? null,
			policyEvaluation: policyRows[0] ?? null,
			decision: decisionRows[0] ? presentDecision(decisionRows[0], me.role) : null,
			timeline,
		});
	});

	// Document-processing consent opt-in/out for legacy applications (T01).
	// Owner-only: officers and other applicants get the same 404 as a
	// missing case (FR-11.2 non-leaking). Withdrawal schedules deletion of
	// every non-deleted file through the retention path; D1 rechecks
	// consent under this same per-application lock before finalizing.
	app.patch("/api/applications/:id/document-consent", async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		if (!isUuid(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		if (!documentsEnabled) throw new HttpError(404, "NOT_FOUND", "not found");
		const parsed = documentConsentSchema.safeParse(await readJson(c));
		if (!parsed.success) {
			throw new HttpError(400, "VALIDATION_ERROR", "invalid consent", zodFields(parsed.error));
		}
		const now = new Date();
		const updated = await withTx(db, async (tx) => {
			await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${id}))`);
			const rows = await tx.select().from(applications).where(eq(applications.id, id));
			const row = rows[0];
			if (!row || me.role !== "applicant" || row.applicantUserId !== me.id) {
				throw new HttpError(404, "NOT_FOUND", "not found");
			}
			await tx
				.update(applications)
				.set({
					documentProcessingConsent: parsed.data.consent,
					documentConsentAt: now,
					documentConsentVersion: DOCUMENT_CONSENT_VERSION,
				})
				.where(eq(applications.id, id));
			if (!parsed.data.consent) {
				await tx
					.update(documentFiles)
					.set({ retentionUntil: now })
					.where(
						and(
							eq(documentFiles.applicationId, id),
							sql`CAST(${documentFiles.status} AS text) != 'deleted'`,
						),
					);
				// A withdrawn consent invalidates officer-facing evidence too:
				// the brief is stale (and the fraud route withholds it).
				await tx
					.update(fraudReviews)
					.set({ briefStaleAt: now, updatedAt: now })
					.where(
						and(
							eq(fraudReviews.applicationId, id),
							sql`${fraudReviews.status} IN ('open','needs_info')`,
						),
					);
				await writeAudit(tx, {
					applicationId: id,
					actor: me.id,
					action: "integrity.review_staled",
					entity: "fraud_review",
					payload: { feature: "document_integrity", reason: "consent_withdrawn" },
				});
			}
			await writeAudit(tx, {
				applicationId: id,
				actor: me.id,
				action: "document.consent_updated",
				entity: "application",
				payload: { consent: parsed.data.consent },
			});
			return parsed.data.consent;
		});
		return c.json({
			documentProcessingConsent: updated,
			documentConsentAt: now.toISOString(),
			documentConsentVersion: DOCUMENT_CONSENT_VERSION,
		});
	});

	return app;
}
