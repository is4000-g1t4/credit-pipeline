// Internal API for sibling services (signed internal auth, no cookies).
// The stateless review service drives its queue + decision replay off these;
// portfolio drives its dashboard off /internal/stats. Officer-only: the
// gateway only routes officer callers here, and the service enforces it.
import {
	applications,
	decisions,
	documentFiles,
	policyEvaluations,
	scores,
	type Db,
} from "@credit/db/applications";
import {
	HttpError,
	readJson,
	requireOfficer,
	requireService,
	zodFields,
	type ServiceApp,
} from "@credit/service-kit";
import { caseFactsSchema, reportingDay, type CaseFacts } from "@credit/core";
import { and, asc, count, desc, eq, inArray, ne } from "drizzle-orm";
import { Hono } from "hono";
import type { Sql } from "postgres";
import { z } from "zod";
import { isUuid, UUID_RE } from "../ids.js";
import {
	clientNameFor,
	flagsForQueueItem,
	riskForScore,
	summarizeQueue,
	topFactorCodes,
	QUEUE_CAP,
} from "./queue-summary.js";
import {
	createLegalHold,
	grantAssignedOfficer,
	releaseLegalHold,
	revokeAssignedOfficer,
	runDocumentRetention,
	LockTimeout,
} from "../documents/index.js";
import type { ContextConfig } from "../context/index.js";
import { requireAssistCaseAccess } from "../assist/access.js";
import { internalContextRoutes } from "./internal-context.js";
import { internalPolicyRoutes } from "./internal-policy.js";

export interface InternalRouteDeps {
	db: Db;
	sql: Sql;
	/** Document retention/hold storage + lock bound (D1b). */
	documents: { storageDir: string; lockTimeoutMs: number };
	/** E2: active fraud reviews block document retention. */
	integrity?: { fraudReviewEnabled: boolean };
	/** T18 internal context reads (D3a): thresholds, window, cursor secret, caps. */
	context: ContextConfig;
	/** EN-07 case rule-failure contract: flag + second HMAC secret. */
	policyRuleContext?: { enabled: boolean; secret: string | null };
}

const UUID_SCHEMA = z.string().regex(UUID_RE);

const grantSchema = z.object({ userId: UUID_SCHEMA, role: z.literal("assigned_officer") }).strict();
const revokeSchema = z.object({ userId: UUID_SCHEMA }).strict();
const holdSchema = z.object({ reason: z.string().min(1).max(500) }).strict();

/** Bounded advisory-lock failures surface as 409, never 500. */
async function withLockTimeout<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof LockTimeout) {
			throw new HttpError(409, "LOCK_TIMEOUT", "the case is busy; retry the request");
		}
		throw err;
	}
}

const officer = requireOfficer;

// Single 16-key schema shared by the officer case-facts route and the
// service research-context route. Fail typed (no PII, no raw ZodError 500)
// on legacy/corrupt rows.
function buildCaseFacts(row: typeof applications.$inferSelect): CaseFacts {
	const identity = row.identity as { fullName?: string; city?: string };
	const business = row.business as {
		companyName?: string;
		registrationNumber?: string;
		industry?: string;
		yearsTrading?: number;
	} | null;
	const submittedAt = row.submittedAt?.toISOString() ?? null;
	// Drafts carry submittedAt=null and never reach case facts (D1 excludes
	// them with 404/409); fail typed on legacy/corrupt rows, as before.
	if (!submittedAt) {
		throw new HttpError(502, "CASE_FACTS_INVALID", "case facts are unavailable");
	}
	const parsed = caseFactsSchema.safeParse({
		applicationId: row.id,
		reference: row.reference,
		type: row.type,
		product: row.product,
		amountCents: row.amountCents,
		termMonths: row.termMonths,
		submittedAt,
		asOf: submittedAt,
		applicantName: identity.fullName ?? "",
		companyName: business?.companyName ?? null,
		registrationNumber: business?.registrationNumber ?? null,
		industry: business?.industry ?? null,
		yearsTrading: business?.yearsTrading ?? null,
		city: identity.city ?? null,
		aiResearchConsent: row.aiResearchConsent,
		status: row.status,
	});
	if (!parsed.success) {
		throw new HttpError(502, "CASE_FACTS_INVALID", "case facts are unavailable");
	}
	return parsed.data;
}

export function internalRoutes(deps: InternalRouteDeps): ServiceApp {
	const app: ServiceApp = new Hono();
	const { db, sql } = deps;
	const documents = deps.documents;
	const docLockMs = documents?.lockTimeoutMs ?? 5000;
	const storageDir = documents?.storageDir ?? ".data/documents";

	// Shared review queue (SPEC FR-7.1): pending oldest first, with
	// score/grade + top reasons. Shape matches the former review-service
	// queue so the UI contract is unchanged. UBS §1 adds clientName, city,
	// risk, flags and a bounded summary (max 100 items, id tiebreaker).
	app.get("/internal/review/queue", officer, async (c) => {
		const now = Date.now();
		const [pending, pendingCountRows] = await Promise.all([
			db
				.select()
				.from(applications)
				.where(eq(applications.status, "pending_review"))
				.orderBy(asc(applications.submittedAt), asc(applications.id))
				.limit(QUEUE_CAP),
			db.select({ n: count() }).from(applications).where(eq(applications.status, "pending_review")),
		]);
		const ids = pending.map((a) => a.id);
		const [scoreRows, policyRows] =
			ids.length === 0
				? [[], []]
				: await Promise.all([
						db.select().from(scores).where(inArray(scores.applicationId, ids)),
						db
							.select()
							.from(policyEvaluations)
							.where(inArray(policyEvaluations.applicationId, ids)),
					]);
		const scoreByApp = new Map(scoreRows.map((s) => [s.applicationId, s]));
		const policyByApp = new Map(policyRows.map((p) => [p.applicationId, p]));
		const items = pending.map((a) => {
			const score = scoreByApp.get(a.id);
			const policy = policyByApp.get(a.id);
			const reasons = Array.isArray(policy?.reasons)
				? (policy.reasons as Array<{ code: string }>).map((r) => r.code)
				: [];
			const factors = Array.isArray(score?.factors)
				? (score.factors as Array<{ code: string; points: number }>)
				: [];
			const identity = a.identity as { fullName?: string; city?: string };
			const business = a.business as { companyName?: string } | null;
			return {
				id: a.id,
				reference: a.reference,
				clientName: clientNameFor(a.type, identity, business),
				city: identity.city ?? null,
				type: a.type,
				product: a.product,
				amountCents: a.amountCents,
				termMonths: a.termMonths,
				// T17: drafts carry null; queue rows are submitted (non-null).
				submittedAt: a.submittedAt?.toISOString() ?? null,
				waitMs: a.submittedAt ? now - a.submittedAt.getTime() : 0,
				score: score?.score ?? null,
				grade: score?.grade ?? null,
				risk: riskForScore(score?.score ?? null),
				flags: flagsForQueueItem(
					typeof policy?.outcome === "string" ? policy.outcome : null,
					reasons,
				),
				reasons,
				topReasons: topFactorCodes(factors),
			};
		});
		return c.json({
			items,
			summary: summarizeQueue(items, pendingCountRows[0]?.n ?? items.length),
		});
	});

	// Decision replay probe for the review service (FR-6.2): current status
	// plus the terminal decision, if any. T17: drafts are owner-only —
	// officers get 404 here exactly like the case-facts route.
	app.get("/internal/applications/:id/decision", officer, async (c) => {
		const id = c.req.param("id");
		if (!isUuid(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const rows = await db.select().from(applications).where(eq(applications.id, id));
		const row = rows[0];
		if (!row) throw new HttpError(404, "NOT_FOUND", "not found");
		if (row.status === "draft") throw new HttpError(404, "NOT_FOUND", "not found");
		const decisionRows = await db.select().from(decisions).where(eq(decisions.applicationId, id));
		const decision = decisionRows[0];
		return c.json({
			status: row.status,
			decision: decision
				? { id: decision.id, outcome: decision.outcome, requestId: decision.requestId }
				: null,
		});
	});

	// Allowlisted case facts for the officer-triggered research service
	// (Phase 2). Never expose DOB, national ID, address, bureau, or documents.
	app.get("/internal/applications/:id/case-facts", officer, async (c) => {
		const id = c.req.param("id");
		if (!isUuid(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const rows = await db.select().from(applications).where(eq(applications.id, id));
		const row = rows[0];
		if (!row) throw new HttpError(404, "NOT_FOUND", "not found");
		// T17: drafts never reach case facts — officers 404.
		if (row.status === "draft") throw new HttpError(404, "NOT_FOUND", "not found");
		return c.json(buildCaseFacts(row));
	});

	// T00 service-only research context (future auto-trigger principal).
	// Same 16-key case facts plus the internal applicant user id, so the
	// service can scope work without a second lookup. `applicantUserId` is
	// internal routing data: it must never enter the agent prompt or trace.
	// `contextAnalysisConsent` rides beside (never inside) the strict facts
	// so T18 can skip its stage without touching the T11 gate.
	app.get("/internal/applications/:id/research-context", requireService, async (c) => {
		const id = c.req.param("id");
		if (!isUuid(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const rows = await db.select().from(applications).where(eq(applications.id, id));
		const row = rows[0];
		if (!row) throw new HttpError(404, "NOT_FOUND", "not found");
		// T17: context/T11 only run after submit — drafts 409 here.
		if (row.status === "draft") {
			throw new HttpError(409, "CASE_NOT_SUBMITTED", "application is not submitted");
		}
		return c.json({
			caseFacts: buildCaseFacts(row),
			applicantUserId: row.applicantUserId,
			contextAnalysisConsent: row.contextAnalysisConsent,
		});
	});

	// Case-assistant need-to-know check (officer-signed). Research calls this
	// before the model runs so the Ask tab follows the same rule as the other
	// case-assist routes: any non-draft case, except one actively assigned to
	// another officer (non-leaking 404) or a revoked officer.
	app.get("/internal/applications/:id/assistant-access", officer, async (c) => {
		const id = c.req.param("id");
		if (!isUuid(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		await requireAssistCaseAccess(db, id, c.var.user);
		return c.json({ applicationId: id });
	});

	// Case-assistant assessment context (service-only): latest score,
	// policy evaluation, and the unique decision plus live document
	// metadata. No PII, no document text, no filenames/hashes/keys.
	// Drafts 404 like the other case reads.
	app.get("/internal/applications/:id/assistant-context", requireService, async (c) => {
		const id = c.req.param("id");
		if (!isUuid(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const rows = await db.select().from(applications).where(eq(applications.id, id));
		const row = rows[0];
		if (!row || row.status === "draft") throw new HttpError(404, "NOT_FOUND", "not found");
		const [scoreRows, policyRows, decisionRows, docRows] = await Promise.all([
			db
				.select()
				.from(scores)
				.where(eq(scores.applicationId, id))
				.orderBy(desc(scores.createdAt))
				.limit(1),
			db.select().from(policyEvaluations).where(eq(policyEvaluations.applicationId, id)),
			db.select().from(decisions).where(eq(decisions.applicationId, id)).limit(1),
			db
				.select({
					id: documentFiles.id,
					kind: documentFiles.kind,
					status: documentFiles.status,
					ocrStatus: documentFiles.ocrStatus,
					pageCount: documentFiles.pageCount,
					documentDate: documentFiles.documentDate,
					periodEnd: documentFiles.periodEnd,
					uploadedAt: documentFiles.uploadedAt,
				})
				.from(documentFiles)
				.where(and(eq(documentFiles.applicationId, id), ne(documentFiles.status, "deleted")))
				.orderBy(desc(documentFiles.uploadedAt))
				.limit(50),
		]);
		const score = scoreRows[0];
		// evaluatedAt is null on legacy rows — compare on the effective
		// evaluation time so a null row never beats a newer evaluation.
		const policy = policyRows.sort((a, b) => {
			const at = (a.evaluatedAt ?? a.createdAt).getTime();
			const bt = (b.evaluatedAt ?? b.createdAt).getTime();
			return bt - at || b.createdAt.getTime() - a.createdAt.getTime();
		})[0];
		const decision = decisionRows[0];
		return c.json({
			applicationId: row.id,
			status: row.status,
			submittedAt: row.submittedAt?.toISOString() ?? null,
			decidedAt: row.decidedAt?.toISOString() ?? null,
			score: score
				? {
						score: score.score,
						grade: score.grade,
						modelVersion: score.modelVersion,
						factors: score.factors,
						affordability: score.affordability,
					}
				: null,
			policyEvaluation: policy
				? {
						policyVersion: policy.policyVersion,
						outcome: policy.outcome,
						reasons: policy.reasons,
						maxAmountCents: policy.maxAmountCents,
						evaluatedAt: (policy.evaluatedAt ?? policy.createdAt).toISOString(),
					}
				: null,
			decision: decision
				? {
						outcome: decision.outcome,
						decidedBy: decision.decidedBy,
						approvedAmountCents: decision.approvedAmountCents,
						termMonths: decision.termMonths,
						rateBps: decision.rateBps,
						reasons: decision.reasons,
						decidedAt: decision.decidedAt.toISOString(),
					}
				: null,
			documents: docRows.map((d) => ({
				id: d.id,
				kind: d.kind,
				status: d.status,
				ocrStatus: d.ocrStatus,
				pageCount: d.pageCount,
				documentDate: d.documentDate,
				periodEnd: d.periodEnd,
				uploadedAt: d.uploadedAt.toISOString(),
			})),
		});
	});

	// Dashboard counts for the portfolio service (FR-9.2): application
	// status counts + avg submitted→decided seconds. T17: drafts never
	// reach officer dashboards — they are owner-only until submitted.
	app.get("/internal/stats", officer, async (c) => {
		const appCounts = await db
			.select({ status: applications.status, n: count() })
			.from(applications)
			.where(ne(applications.status, "draft"))
			.groupBy(applications.status);
		const timing = (await sql`
			SELECT avg(EXTRACT(EPOCH FROM (decided_at - submitted_at))) AS avg_seconds,
			       count(*)::int AS decided
			FROM applications WHERE decided_at IS NOT NULL
		`) as Array<{ avg_seconds: string | null; decided: number }>;
		// UBS §2: decisions recorded today in the Asia/Singapore reporting
		// day (bounded both sides). Booking inserts the row, so this is the
		// decision-record day, not an officer-click timestamp.
		const day = reportingDay(new Date());
		const decidedToday = (await sql`
			SELECT count(*)::int AS n FROM decisions
			WHERE created_at >= (${day}::date::timestamp AT TIME ZONE 'Asia/Singapore')
			  AND created_at < ((${day}::date + 1)::timestamp AT TIME ZONE 'Asia/Singapore')
		`) as Array<{ n: number }>;
		return c.json({
			applications: Object.fromEntries(appCounts.map((r) => [r.status, r.n])),
			avgDecisionSeconds:
				timing[0]?.avg_seconds === null || timing[0]?.avg_seconds === undefined
					? null
					: Number(timing[0].avg_seconds),
			decidedApplications: timing[0]?.decided ?? 0,
			decisionsToday: decidedToday[0]?.n ?? 0,
		});
	});

	// --- D1b document assignment + retention (SPEC-t01-t02 §5/§6). All
	// service-only (signed service role); never exposed via the gateway.
	// Responses carry ids/counts only — no document content, filenames,
	// quotes, or expected/observed values.

	app.post("/internal/applications/:id/document-access/grant", requireService, async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		if (!isUuid(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const parsed = grantSchema.safeParse(await readJson(c));
		if (!parsed.success) {
			throw new HttpError(400, "VALIDATION_ERROR", "invalid grant", zodFields(parsed.error));
		}
		const { assignment, idempotent } = await withLockTimeout(() =>
			grantAssignedOfficer(db, {
				applicationId: id,
				userId: parsed.data.userId,
				grantedBy: me.id,
				lockTimeoutMs: docLockMs,
			}),
		);
		return c.json(
			{
				assignment: {
					applicationId: assignment.applicationId,
					userId: assignment.userId,
					accessRole: assignment.accessRole,
					grantedAt: assignment.grantedAt.toISOString(),
				},
				idempotent,
			},
			200,
		);
	});

	app.post("/internal/applications/:id/document-access/revoke", requireService, async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		if (!isUuid(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const parsed = revokeSchema.safeParse(await readJson(c));
		if (!parsed.success) {
			throw new HttpError(400, "VALIDATION_ERROR", "invalid revoke", zodFields(parsed.error));
		}
		const { assignment } = await withLockTimeout(() =>
			revokeAssignedOfficer(db, {
				applicationId: id,
				userId: parsed.data.userId,
				actor: me.id,
				lockTimeoutMs: docLockMs,
			}),
		);
		return c.json({ applicationId: assignment.applicationId, userId: assignment.userId }, 200);
	});

	app.post("/internal/applications/:id/documents/legal-hold", requireService, async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		if (!isUuid(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const parsed = holdSchema.safeParse(await readJson(c));
		if (!parsed.success) {
			throw new HttpError(400, "VALIDATION_ERROR", "invalid hold", zodFields(parsed.error));
		}
		const hold = await withLockTimeout(() =>
			createLegalHold(db, {
				applicationId: id,
				documentFileId: null,
				reason: parsed.data.reason,
				createdBy: me.id,
				lockTimeoutMs: docLockMs,
			}),
		);
		return c.json({ holdId: hold.id, applicationId: hold.applicationId }, 201);
	});

	app.post("/internal/applications/:id/documents/:fileId/legal-hold", requireService, async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		const fileId = c.req.param("fileId");
		if (!isUuid(id) || !isUuid(fileId)) {
			throw new HttpError(404, "NOT_FOUND", "not found");
		}
		const parsed = holdSchema.safeParse(await readJson(c));
		if (!parsed.success) {
			throw new HttpError(400, "VALIDATION_ERROR", "invalid hold", zodFields(parsed.error));
		}
		const hold = await withLockTimeout(() =>
			createLegalHold(db, {
				applicationId: id,
				documentFileId: fileId,
				reason: parsed.data.reason,
				createdBy: me.id,
				lockTimeoutMs: docLockMs,
			}),
		);
		return c.json(
			{ holdId: hold.id, applicationId: hold.applicationId, documentFileId: hold.documentFileId },
			201,
		);
	});

	app.post(
		"/internal/applications/:id/documents/legal-holds/:holdId/release",
		requireService,
		async (c) => {
			const me = c.var.user;
			const id = c.req.param("id");
			const holdId = c.req.param("holdId");
			if (!isUuid(id) || !isUuid(holdId)) {
				throw new HttpError(404, "NOT_FOUND", "not found");
			}
			const hold = await withLockTimeout(() =>
				releaseLegalHold(db, {
					applicationId: id,
					holdId,
					actor: me.id,
					lockTimeoutMs: docLockMs,
				}),
			);
			return c.json({ holdId: hold.id, applicationId: hold.applicationId }, 200);
		},
	);

	app.post("/internal/applications/:id/documents/retention/run", requireService, async (c) => {
		const id = c.req.param("id");
		if (!isUuid(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const rows = await db.select().from(applications).where(eq(applications.id, id));
		if (!rows[0]) throw new HttpError(404, "NOT_FOUND", "not found");
		const counts = await withLockTimeout(() =>
			runDocumentRetention({
				db,
				lockTimeoutMs: docLockMs,
				storageDir,
				applicationId: id,
				fraudReviewEnabled: deps.integrity?.fraudReviewEnabled ?? false,
			}),
		);
		return c.json(counts, 200);
	});

	// T18 context reads + EN-07 rule failures live in sub-routers mounted at
	// the same paths, so route shapes are unchanged.
	app.route("/", internalContextRoutes({ db, context: deps.context }));
	app.route("/", internalPolicyRoutes({ db, policyRuleContext: deps.policyRuleContext }));
	return app;
}
