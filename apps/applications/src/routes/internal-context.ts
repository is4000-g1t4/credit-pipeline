// T18 internal context reads, D3a (SPEC-t17-t18 §2.3/§3.2/§3.3).
// Service-only (signed service role): the D3b context agent's tools.
// Every call revalidates application existence, `submitted` state,
// `contextAnalysisConsent`, and as-of/window bounds; drafts 409 with
// CASE_NOT_SUBMITTED, cross-application/account IDs 404. Success audits
// `context.read`, denials `context.denied` — ids/codes/counts only, no
// content, descriptions, counterparties, or document text.
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
	withTx,
	type Db,
} from "@credit/db/applications";
import {
	HttpError,
	requireService,
	writeAudit,
	type ServiceApp,
} from "@credit/service-kit";
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, ne } from "drizzle-orm";
import { Hono } from "hono";
import { isUuid } from "../ids.js";
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

export interface InternalContextRouteDeps {
	db: Db;
	/** T18 internal context reads (D3a): thresholds, window, cursor secret, caps. */
	context: ContextConfig;
}

function isoDay(d: Date): string {
	return d.toISOString().slice(0, 10);
}

export function internalContextRoutes(deps: InternalContextRouteDeps): ServiceApp {
	const app: ServiceApp = new Hono();
	const { db } = deps;
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
					(d !== null && d !== undefined && d.decidedAt > kase.asOf) ||
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
