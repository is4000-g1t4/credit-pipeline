// Internal API for sibling services (signed internal auth, no cookies).
// The stateless review service drives its queue + decision replay off these;
// portfolio drives its dashboard off /internal/stats. Officer-only: the
// gateway only routes officer callers here, and the service enforces it.
import {
	applications,
	customerAccounts,
	customerTransactions,
	decisions,
	documentCrosschecks,
	documentFiles,
	documentFindings,
	externalReports,
	kycChecks,
	policyEvaluations,
	scores,
	withTx,
	type Db,
} from "@credit/db/applications";
import {
	HttpError,
	readJson,
	requireService,
	writeAudit,
	zodFields,
	type ServiceApp,
	type ServiceVariables,
} from "@credit/service-kit";
import { caseFactsSchema, type CaseFacts } from "@credit/core";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, lte, ne } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { Sql } from "postgres";
import { z } from "zod";
import { isUuid, UUID_RE } from "../ids.js";
import {
	CONTEXT_METRICS_POLICY_VERSION,
	CONTEXT_METRICS_ROW_CAP,
	computeCandidateSignals,
	contextWindow,
	decodeCursor,
	encodeCursor,
	type ContextConfig,
	type MetricTx,
} from "../context/index.js";
import { getCustomerProfile, type CustomerProfileRow } from "../customer/service.js";
import {
	createLegalHold,
	grantAssignedOfficer,
	releaseLegalHold,
	revokeAssignedOfficer,
	runDocumentRetention,
	LockTimeout,
} from "../documents/index.js";

function isoDay(d: Date): string {
	return d.toISOString().slice(0, 10);
}

export interface InternalRouteDeps {
	db: Db;
	sql: Sql;
	/** Document retention/hold storage + lock bound (D1b). */
	documents: { storageDir: string; lockTimeoutMs: number };
	/** T18 internal context reads (D3a): thresholds, window, cursor secret, caps. */
	context: ContextConfig;
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

const officer = createMiddleware<{ Variables: ServiceVariables }>(async (c, next) => {
	const me = c.var.user;
	if (!me) throw new HttpError(401, "UNAUTHENTICATED", "login required");
	if (me.role !== "officer") throw new HttpError(403, "FORBIDDEN", "officer role required");
	await next();
});

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
	// queue so the UI contract is unchanged.
	app.get("/internal/review/queue", officer, async (c) => {
		const now = Date.now();
		const pending = await db
			.select()
			.from(applications)
			.where(eq(applications.status, "pending_review"))
			.orderBy(asc(applications.submittedAt))
			.limit(100);
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
		return c.json({
			items: pending.map((a) => {
				const score = scoreByApp.get(a.id);
				const policy = policyByApp.get(a.id);
				const reasons = Array.isArray(policy?.reasons)
					? (policy.reasons as Array<{ code: string }>).map((r) => r.code)
					: [];
				const factors = Array.isArray(score?.factors)
					? (score.factors as Array<{ code: string; points: number }>)
					: [];
				const topReasons = [...factors]
					.sort((x, y) => Math.abs(y.points) - Math.abs(x.points))
					.slice(0, 5)
					.map((f) => f.code);
				return {
					id: a.id,
					reference: a.reference,
					type: a.type,
					product: a.product,
					amountCents: a.amountCents,
					termMonths: a.termMonths,
					// T17: drafts carry null; queue rows are submitted (non-null).
					submittedAt: a.submittedAt?.toISOString() ?? null,
					waitMs: a.submittedAt ? now - a.submittedAt.getTime() : 0,
					score: score?.score ?? null,
					grade: score?.grade ?? null,
					reasons,
					topReasons,
				};
			}),
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
		return c.json({
			applications: Object.fromEntries(appCounts.map((r) => [r.status, r.n])),
			avgDecisionSeconds:
				timing[0]?.avg_seconds === null || timing[0]?.avg_seconds === undefined
					? null
					: Number(timing[0].avg_seconds),
			decidedApplications: timing[0]?.decided ?? 0,
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
			}),
		);
		return c.json(counts, 200);
	});

	// --- T18 internal context reads, D3a (SPEC-t17-t18 §2.3/§3.2/§3.3). ---
	// Service-only (signed service role): the D3b context agent's tools.
	// Every call revalidates application existence, `submitted` state,
	// `contextAnalysisConsent`, and as-of/window bounds; drafts 409 with
	// CASE_NOT_SUBMITTED, cross-application/account IDs 404. Success audits
	// `context.read`, denials `context.denied` — ids/codes/counts only, no
	// content, descriptions, counterparties, or document text.
	const context = deps.context;
	const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

	interface ContextCase {
		app: typeof applications.$inferSelect;
		profile: CustomerProfileRow | null;
		asOf: Date;
		from: Date;
		to: Date;
	}

	async function auditContext(
		action: "context.read" | "context.denied",
		applicationId: string,
		actor: string,
		payload: Record<string, unknown>,
	): Promise<void> {
		await withTx(db, (tx) =>
			writeAudit(tx, { applicationId, actor, action, entity: "application", payload }),
		);
	}

	async function requireContextCase(
		id: string,
		route: string,
		actor: string,
	): Promise<ContextCase> {
		const rows = await db.select().from(applications).where(eq(applications.id, id));
		const row = rows[0];
		if (!row) throw new HttpError(404, "NOT_FOUND", "not found");
		if (row.status === "draft" || !row.submittedAt) {
			await auditContext("context.denied", id, actor, { route, code: "CASE_NOT_SUBMITTED" });
			throw new HttpError(409, "CASE_NOT_SUBMITTED", "application is not submitted");
		}
		if (!row.contextAnalysisConsent) {
			await auditContext("context.denied", id, actor, { route, code: "CONTEXT_CONSENT_REQUIRED" });
			throw new HttpError(403, "CONTEXT_CONSENT_REQUIRED", "context analysis consent is required");
		}
		const profile = await getCustomerProfile(db, row.applicantUserId);
		const asOf = row.submittedAt;
		const window = contextWindow(asOf, context.historyMonths);
		return { app: row, profile, asOf, from: window.from, to: window.to };
	}

	function parseWindowParam(value: string | undefined, name: string): Date | null {
		if (value === undefined || value === "") return null;
		if (!DAY_RE.test(value)) {
			throw new HttpError(400, "VALIDATION_ERROR", `invalid ${name}: use YYYY-MM-DD`);
		}
		const at = new Date(`${value}T00:00:00Z`);
		if (Number.isNaN(at.getTime())) {
			throw new HttpError(400, "VALIDATION_ERROR", `invalid ${name}: use YYYY-MM-DD`);
		}
		return at;
	}

	/** Caller bounds clamp into the case window — never widen. */
	function clampWindow(
		kase: ContextCase,
		c: { req: { query(name: string): string | undefined } },
	): { from: Date; to: Date } {
		const from = parseWindowParam(c.req.query("from"), "from") ?? kase.from;
		const to = parseWindowParam(c.req.query("to"), "to") ?? kase.to;
		const clampedFrom = new Date(Math.max(kase.from.getTime(), from.getTime()));
		const clampedTo = new Date(Math.min(kase.to.getTime(), to.getTime()));
		if (clampedFrom.getTime() > clampedTo.getTime()) {
			throw new HttpError(400, "VALIDATION_ERROR", "empty window: from is after to");
		}
		return { from: clampedFrom, to: clampedTo };
	}

	async function requireOwnedAccount(
		kase: ContextCase,
		route: string,
		actor: string,
		accountId: string,
	): Promise<typeof customerAccounts.$inferSelect> {
		const rows = await db.select().from(customerAccounts).where(eq(customerAccounts.id, accountId));
		const account = rows[0];
		if (!account || !kase.profile || account.customerId !== kase.profile.id) {
			await auditContext("context.denied", kase.app.id, actor, {
				route,
				code: "ACCOUNT_NOT_FOUND",
			});
			throw new HttpError(404, "NOT_FOUND", "not found");
		}
		return account;
	}

	// Segment, customerSince, KYC status/expiry, city only.
	app.get("/internal/applications/:id/context/profile", requireService, async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		if (!isUuid(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const kase = await requireContextCase(id, "profile", me.id);
		if (!kase.profile) throw new HttpError(404, "NOT_FOUND", "not found");
		const identity = (kase.profile.identity ?? {}) as Record<string, unknown>;
		const city = typeof identity["city"] === "string" ? (identity["city"] as string) : null;
		await auditContext("context.read", id, me.id, { route: "profile" });
		return c.json({
			applicationId: id,
			asOf: kase.asOf.toISOString(),
			customer: {
				segment: kase.profile.segment,
				customerSince: kase.profile.customerSince,
				kycStatus: kase.profile.kycStatus,
				kycVerifiedAt: kase.profile.kycVerifiedAt?.toISOString() ?? null,
				kycExpiresAt: kase.profile.kycExpiresAt?.toISOString() ?? null,
			},
			city,
		});
	});

	// Account IDs/types/currencies/status only — no numbers or names.
	app.get("/internal/applications/:id/context/accounts", requireService, async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		if (!isUuid(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const kase = await requireContextCase(id, "accounts", me.id);
		if (!kase.profile) throw new HttpError(404, "NOT_FOUND", "not found");
		const rows = await db
			.select()
			.from(customerAccounts)
			.where(eq(customerAccounts.customerId, kase.profile.id))
			.orderBy(asc(customerAccounts.id));
		await auditContext("context.read", id, me.id, { route: "accounts", accountCount: rows.length });
		return c.json({
			applicationId: id,
			asOf: kase.asOf.toISOString(),
			accounts: rows.map((a) => ({
				id: a.id,
				accountType: a.accountType,
				currency: a.currency,
				status: a.status,
			})),
		});
	});

	// Bounded owned-account/period page. `cursor` is HMAC-bound to
	// (application, account, from, to); at most maxPages pages per account.
	app.get("/internal/applications/:id/context/transactions", requireService, async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		if (!isUuid(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const kase = await requireContextCase(id, "transactions", me.id);
		const accountId = c.req.query("accountId") ?? "";
		if (!isUuid(accountId)) {
			throw new HttpError(400, "VALIDATION_ERROR", "accountId is required");
		}
		await requireOwnedAccount(kase, "transactions", me.id, accountId);
		const { from, to } = clampWindow(kase, c);
		let offset = 0;
		const rawCursor = c.req.query("cursor");
		if (rawCursor) {
			const decoded = decodeCursor(context.cursorSecret, rawCursor);
			if (
				!decoded ||
				decoded.app !== id ||
				decoded.acct !== accountId ||
				decoded.from !== isoDay(from) ||
				decoded.to !== isoDay(to)
			) {
				throw new HttpError(400, "VALIDATION_ERROR", "invalid cursor");
			}
			offset = decoded.off;
		}
		const rowCap = context.maxPages * context.pageLimit;
		const items =
			offset >= rowCap
				? []
				: await db
						.select()
						.from(customerTransactions)
						.where(
							and(
								eq(customerTransactions.accountId, accountId),
								gte(customerTransactions.postedAt, from),
								lte(customerTransactions.postedAt, to),
							),
						)
						.orderBy(asc(customerTransactions.postedAt), asc(customerTransactions.id))
						.limit(context.pageLimit)
						.offset(offset);
		const nextCursor =
			items.length === context.pageLimit && offset + context.pageLimit < rowCap
				? encodeCursor(context.cursorSecret, {
						app: id,
						acct: accountId,
						from: isoDay(from),
						to: isoDay(to),
						off: offset + context.pageLimit,
					})
				: null;
		await auditContext("context.read", id, me.id, {
			route: "transactions",
			accountId,
			transactionCount: items.length,
		});
		return c.json({
			applicationId: id,
			asOf: kase.asOf.toISOString(),
			window: { from: from.toISOString(), to: to.toISOString() },
			accountId,
			items: items.map((tx) => ({
				id: tx.id,
				accountId: tx.accountId,
				postedAt: tx.postedAt.toISOString(),
				amountCents: tx.amountCents,
				balanceAfterCents: tx.balanceAfterCents,
				currency: tx.currency,
				description: tx.description,
				counterparty: tx.counterparty,
				category: tx.category,
				returned: tx.returned,
			})),
			nextCursor,
		});
	});

	// Deterministic v1 candidate signals over ≤maxAccounts owned accounts.
	app.get("/internal/applications/:id/context/metrics", requireService, async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		if (!isUuid(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const kase = await requireContextCase(id, "metrics", me.id);
		const { from, to } = clampWindow(kase, c);
		const rawIds = c.req.query("accountIds");
		let scopedIds: string[];
		if (rawIds === undefined || rawIds === "") {
			const all = kase.profile
				? await db
						.select({ id: customerAccounts.id })
						.from(customerAccounts)
						.where(eq(customerAccounts.customerId, kase.profile.id))
						.orderBy(asc(customerAccounts.id))
						.limit(context.maxAccounts)
				: [];
			scopedIds = all.map((a) => a.id);
		} else {
			const ids = [
				...new Set(
					rawIds
						.split(",")
						.map((s) => s.trim())
						.filter((s) => s !== ""),
				),
			];
			if (ids.length === 0) throw new HttpError(400, "VALIDATION_ERROR", "accountIds is empty");
			if (ids.length > context.maxAccounts) {
				throw new HttpError(400, "VALIDATION_ERROR", `at most ${context.maxAccounts} account IDs`);
			}
			for (const accountId of ids) {
				if (!isUuid(accountId)) {
					throw new HttpError(400, "VALIDATION_ERROR", "invalid account ID");
				}
				await requireOwnedAccount(kase, "metrics", me.id, accountId);
			}
			scopedIds = ids;
		}
		const rows =
			scopedIds.length === 0
				? []
				: await db
						.select()
						.from(customerTransactions)
						.where(
							and(
								inArray(customerTransactions.accountId, scopedIds),
								gte(customerTransactions.postedAt, from),
								lte(customerTransactions.postedAt, to),
							),
						)
						.orderBy(asc(customerTransactions.postedAt), asc(customerTransactions.id))
						.limit(CONTEXT_METRICS_ROW_CAP);
		const business = (kase.app.business ?? null) as Record<string, unknown> | null;
		const declared =
			business !== null && typeof business["monthlyFcfCents"] === "number"
				? (business["monthlyFcfCents"] as number)
				: null;
		const signals = computeCandidateSignals({
			transactions: rows.map((tx): MetricTx => ({
				id: tx.id,
				accountId: tx.accountId,
				postedAt: tx.postedAt,
				amountCents: tx.amountCents,
				balanceAfterCents: tx.balanceAfterCents,
				counterparty: tx.counterparty,
				category: tx.category,
				returned: tx.returned,
			})),
			window: { from, to },
			declaredMonthlyFcfCents: declared,
			scopeAccountIds: scopedIds,
			thresholds: {
				historyMonths: context.historyMonths,
				negativeBalanceDays: context.negativeBalanceDays,
				revenueConcentrationPct: context.revenueConcentrationPct,
				cashDepositSharePct: context.cashDepositSharePct,
				fcfVariancePct: context.fcfVariancePct,
			},
		});
		await auditContext("context.read", id, me.id, {
			route: "metrics",
			accountCount: scopedIds.length,
			transactionCount: rows.length,
			signalCount: signals.length,
		});
		return c.json({
			applicationId: id,
			asOf: kase.asOf.toISOString(),
			window: { from: from.toISOString(), to: to.toISOString() },
			accountIds: scopedIds,
			policyVersion: CONTEXT_METRICS_POLICY_VERSION,
			signals,
		});
	});

	// Declared application financial block for expected-vs-observed comparison.
	app.get("/internal/applications/:id/context/financials", requireService, async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		if (!isUuid(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const kase = await requireContextCase(id, "financials", me.id);
		await auditContext("context.read", id, me.id, { route: "financials" });
		return c.json({
			applicationId: id,
			asOf: kase.asOf.toISOString(),
			reference: kase.app.reference,
			type: kase.app.type,
			product: kase.app.product,
			amountCents: kase.app.amountCents,
			termMonths: kase.app.termMonths,
			purpose: kase.app.purpose,
			submittedAt: kase.app.submittedAt?.toISOString() ?? null,
			status: kase.app.status,
			business: kase.app.business,
			financial: kase.app.financial,
		});
	});

	// Latest succeeded, non-redacted crosscheck with live files, max 50:
	// field/status/confidence/document/page + expected/observed/reason only,
	// each capped to 200 chars at this boundary (crosscheck text is
	// unbounded). Null-file needs_chase rows are included; quotes/page text
	// (quote/quoteHash/offsets) never leave. A failed/redacted latest run
	// returns a stale marker, never older runs.
	const clip = (v: unknown): string | null => (typeof v === "string" ? v.slice(0, 200) : null);
	app.get("/internal/applications/:id/context/document-findings", requireService, async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		if (!isUuid(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const kase = await requireContextCase(id, "document-findings", me.id);
		const latest = await db
			.select()
			.from(documentCrosschecks)
			.where(eq(documentCrosschecks.applicationId, id))
			.orderBy(desc(documentCrosschecks.startedAt), desc(documentCrosschecks.id))
			.limit(1);
		const crosscheck = latest[0];
		if (!crosscheck) {
			await auditContext("context.read", id, me.id, {
				route: "document-findings",
				findingCount: 0,
			});
			return c.json({
				applicationId: id,
				asOf: kase.asOf.toISOString(),
				crosscheck: null,
				findings: [],
			});
		}
		if (crosscheck.status !== "succeeded") {
			await auditContext("context.read", id, me.id, {
				route: "document-findings",
				findingCount: 0,
			});
			return c.json({
				applicationId: id,
				asOf: kase.asOf.toISOString(),
				crosscheck: { id: crosscheck.id, status: crosscheck.status },
				findings: [],
				stale: true,
			});
		}
		const findings = await db
			.select()
			.from(documentFindings)
			.where(
				and(
					eq(documentFindings.crosscheckId, crosscheck.id),
					eq(documentFindings.applicationId, id),
				),
			)
			.orderBy(asc(documentFindings.createdAt), asc(documentFindings.id))
			.limit(50);
		const fileIds = [
			...new Set(findings.flatMap((f) => (f.documentFileId ? [f.documentFileId] : []))),
		];
		const files =
			fileIds.length === 0
				? []
				: await db.select().from(documentFiles).where(inArray(documentFiles.id, fileIds));
		const live = new Set(files.filter((f) => f.status !== "deleted").map((f) => f.id));
		const presented = findings
			.filter((f) =>
				f.documentFileId === null ? f.status === "needs_chase" : live.has(f.documentFileId),
			)
			.map((f) => ({
				id: f.id,
				field: f.field,
				status: f.status,
				confidence: f.confidence,
				expected: clip(f.expected),
				observed: clip(f.observed),
				reason: clip(f.reason),
				documentFileId: f.documentFileId,
				pageNumber: f.pageNumber,
			}));
		await auditContext("context.read", id, me.id, {
			route: "document-findings",
			findingCount: presented.length,
		});
		return c.json({
			applicationId: id,
			asOf: kase.asOf.toISOString(),
			crosscheck: { id: crosscheck.id, status: crosscheck.status },
			findings: presented,
		});
	});

	// Internal applicant routing id for the D3b agent's tools — never PII,
	// never a second lookup.
	app.get("/internal/applications/:id/context/applicant", requireService, async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		if (!isUuid(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const kase = await requireContextCase(id, "applicant", me.id);
		await auditContext("context.read", id, me.id, { route: "applicant" });
		return c.json({ applicationId: id, applicantUserId: kase.app.applicantUserId });
	});

	// Prior submitted applications by the same applicant (current excluded,
	// drafts excluded), newest first, hard cap 10. Decisions join by
	// applicationId; reasons collapse to string codes only — notes and
	// snapshots never leave.
	app.get("/internal/applications/:id/context/credit-history", requireService, async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		if (!isUuid(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const kase = await requireContextCase(id, "credit-history", me.id);
		const priors = await db
			.select()
			.from(applications)
			.where(
				and(
					eq(applications.applicantUserId, kase.app.applicantUserId),
					ne(applications.id, id),
					ne(applications.status, "draft"),
					isNotNull(applications.submittedAt),
					lte(applications.submittedAt, kase.asOf),
				),
			)
			.orderBy(desc(applications.submittedAt), desc(applications.id))
			.limit(10);
		const priorIds = priors.map((p) => p.id);
		const decisionRows =
			priorIds.length === 0
				? []
				: await db.select().from(decisions).where(inArray(decisions.applicationId, priorIds));
		const decisionByApp = new Map(decisionRows.map((d) => [d.applicationId, d]));
		await auditContext("context.read", id, me.id, {
			route: "credit-history",
			priorApplicationCount: priors.length,
		});
		return c.json({
			applicationId: id,
			asOf: kase.asOf.toISOString(),
			priorApplications: priors.map((p) => {
				const d = decisionByApp.get(p.id);
				// One known flag for the whole prior: when the row or its
				// decision is decided after the case as-of, nothing is yet
				// knowable — status, decidedAt, and the decision are all
				// masked, so the outcome cannot leak through an unmasked
				// half (e.g. a decision stamped before as-of on a row
				// decided after it).
				const known = !(
					(d != null && d.decidedAt > kase.asOf) ||
					(p.decidedAt !== null && p.decidedAt > kase.asOf)
				);
				const decided = known ? (d ?? null) : null;
				const reasons = Array.isArray(decided?.reasons)
					? (decided.reasons as unknown[]).flatMap((r) =>
							typeof r === "string"
								? [r]
								: r !== null &&
									  typeof r === "object" &&
									  typeof (r as { code?: unknown }).code === "string"
									? [(r as { code: string }).code]
									: [],
						)
					: [];
				return {
					reference: p.reference,
					type: p.type,
					product: p.product,
					amountCents: p.amountCents,
					termMonths: p.termMonths,
					status: known ? p.status : "unknown_at_as_of",
					submittedAt: p.submittedAt?.toISOString() ?? null,
					decidedAt: known ? (p.decidedAt?.toISOString() ?? null) : null,
					decision: decided
						? {
								outcome: decided.outcome,
								approvedAmountCents: decided.approvedAmountCents,
								termMonths: decided.termMonths,
								reasons,
								decidedAt: decided.decidedAt.toISOString(),
							}
						: null,
				};
			}),
		});
	});

	// External bureau/bank reports with an allowlisted numeric summary per
	// kind — the raw payload never leaves.
	app.get("/internal/applications/:id/context/external-reports", requireService, async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		if (!isUuid(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const kase = await requireContextCase(id, "external-reports", me.id);
		const rows = await db
			.select()
			.from(externalReports)
			.where(eq(externalReports.applicationId, id))
			.orderBy(asc(externalReports.kind), asc(externalReports.provider));
		const summarize = (kind: string, payload: unknown): Record<string, number> => {
			const keys =
				kind === "bureau"
					? ["bureauScore", "delinquencies", "utilizationPct", "inquiries6m"]
					: kind === "bank"
						? ["monthlyInflowCents", "monthlyFreeCashFlowCents", "accountAgeYears"]
						: [];
			if (payload === null || typeof payload !== "object") return {};
			const record = payload as Record<string, unknown>;
			const summary: Record<string, number> = {};
			for (const key of keys) {
				const value = record[key];
				if (typeof value === "number") summary[key] = value;
			}
			return summary;
		};
		await auditContext("context.read", id, me.id, {
			route: "external-reports",
			reportCount: rows.length,
		});
		return c.json({
			applicationId: id,
			asOf: kase.asOf.toISOString(),
			reports: rows.map((r) => ({
				kind: r.kind,
				provider: r.provider,
				version: r.version,
				fetchedAt: r.fetchedAt.toISOString(),
				summary: summarize(r.kind, r.payload),
			})),
		});
	});

	// KYC check types/statuses only — details never leave.
	app.get("/internal/applications/:id/context/kyc-checks", requireService, async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		if (!isUuid(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const kase = await requireContextCase(id, "kyc-checks", me.id);
		const rows = await db
			.select()
			.from(kycChecks)
			.where(eq(kycChecks.applicationId, id))
			.orderBy(asc(kycChecks.type));
		await auditContext("context.read", id, me.id, {
			route: "kyc-checks",
			checkCount: rows.length,
		});
		return c.json({
			applicationId: id,
			asOf: kase.asOf.toISOString(),
			checks: rows.map((r) => ({ type: r.type, status: r.status })),
		});
	});

	return app;
}
