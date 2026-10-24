// Loans (SPEC FR-9.1): role-scoped list/detail + officer alert acknowledge,
// plus the internal loan-by-application lookup the P1b gateway uses to
// compose the application detail response. Loans carry denormalised
// application columns (reference/applicant/product) — ownership scoping
// never joins to the applications database.
import { ewsAlerts, installments, loans, payments, withTx, type Db } from "@credit/db/loans";
import {
	HttpError,
	internalFetch,
	requireOfficer,
	requireService,
	writeAudit,
	type ServiceApp,
} from "@credit/service-kit";
import { and, count, desc, eq, inArray, lte } from "drizzle-orm";
import { Hono } from "hono";
import type { LoansEnv } from "../env.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function summarizeLoan(loan: typeof loans.$inferSelect): Record<string, unknown> {
	return {
		id: loan.id,
		applicationId: loan.applicationId,
		reference: loan.applicationReference,
		principalCents: loan.principalCents,
		termMonths: loan.termMonths,
		rateBps: loan.rateBps,
		monthlyPaymentCents: loan.monthlyPaymentCents,
		status: loan.status,
		outstandingCents: loan.outstandingCents,
		nextDueDate: loan.nextDueDate,
		disbursedAt: loan.disbursedAt.toISOString(),
	};
}

export interface LoansRouteDeps {
	db: Db;
	env: Pick<LoansEnv, "applicationsUrl" | "internalSecret">;
	/** Test seam: stub the applications binding check; default is global fetch. */
	fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

/** Officer-only routes (review queues, approvals, case reads) — the shared
 * service-kit gate (401 without a signed user, 403 on role mismatch). */
export const requireOfficerRole = requireOfficer;

export function loansRoutes(deps: LoansRouteDeps): ServiceApp {
	const app: ServiceApp = new Hono();
	const { db, env } = deps;
	const fetchImpl = deps.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init));

	app.get("/api/loans", async (c) => {
		const me = c.var.user;
		const rows = await db
			.select()
			.from(loans)
			.where(me.role === "officer" ? undefined : eq(loans.applicantUserId, me.id))
			.orderBy(desc(loans.disbursedAt));
		return c.json({ items: rows.map((loan) => summarizeLoan(loan)) });
	});

	app.get("/api/loans/:id", async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		if (!UUID_RE.test(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const rows = await db.select().from(loans).where(eq(loans.id, id));
		const loan = rows[0];
		if (!loan || (me.role !== "officer" && loan.applicantUserId !== me.id)) {
			throw new HttpError(404, "NOT_FOUND", "not found");
		}
		const [items, alertRows] = await Promise.all([
			db
				.select()
				.from(installments)
				.where(eq(installments.loanId, id))
				.orderBy(installments.number),
			db.select().from(ewsAlerts).where(eq(ewsAlerts.loanId, id)),
		]);
		const paid = await db
			.select()
			.from(payments)
			.where(
				inArray(
					payments.installmentId,
					items.map((i) => i.id),
				),
			);
		return c.json({
			loan: summarizeLoan(loan),
			installments: items,
			payments: paid,
			alerts: alertRows,
		});
	});

	app.post("/api/loans/:id/alerts/:alertId/acknowledge", requireOfficerRole, async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		const alertId = c.req.param("alertId");
		if (!UUID_RE.test(id) || !UUID_RE.test(alertId)) {
			throw new HttpError(404, "NOT_FOUND", "not found");
		}
		const updated = await withTx(db, async (tx) => {
			const rows = await tx
				.update(ewsAlerts)
				.set({ status: "acknowledged", acknowledgedBy: me.id })
				.where(
					and(eq(ewsAlerts.id, alertId), eq(ewsAlerts.loanId, id), eq(ewsAlerts.status, "open")),
				)
				.returning({ id: ewsAlerts.id, loanId: ewsAlerts.loanId });
			const won = rows[0];
			if (won) {
				const loanRows = await tx
					.select({ applicationId: loans.applicationId })
					.from(loans)
					.where(eq(loans.id, id));
				await writeAudit(tx, {
					...(loanRows[0] ? { applicationId: loanRows[0].applicationId } : {}),
					loanId: id,
					actor: me.id,
					action: "ews.alert.acknowledged",
					entity: "ews_alert",
					payload: { alertId, loanId: id },
				});
			}
			return won ?? null;
		});
		if (updated) return c.json({ id: updated.id, status: "acknowledged" });
		const existing = await db
			.select({ id: ewsAlerts.id, status: ewsAlerts.status })
			.from(ewsAlerts)
			.where(and(eq(ewsAlerts.id, alertId), eq(ewsAlerts.loanId, id)));
		if (!existing[0]) throw new HttpError(404, "NOT_FOUND", "not found");
		throw new HttpError(409, "ALERT_NOT_OPEN", `alert is ${existing[0].status}`);
	});

	// Internal composition lookup for the gateway (P1b): loan summary plus
	// paid/overdue installment counts for one application. Same ownership
	// rule as the detail route — cross-applicant reads are 404.
	app.get("/internal/loans/by-application/:id", async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		if (!UUID_RE.test(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const rows = await db.select().from(loans).where(eq(loans.applicationId, id));
		const loan = rows[0];
		if (!loan || (me.role !== "officer" && loan.applicantUserId !== me.id)) {
			throw new HttpError(404, "NOT_FOUND", "not found");
		}
		const items = await db
			.select({ status: installments.status })
			.from(installments)
			.where(eq(installments.loanId, loan.id));
		return c.json({
			loan: {
				...summarizeLoan(loan),
			},
			installments: {
				total: items.length,
				paid: items.filter((i) => i.status === "paid").length,
				overdue: items.filter((i) => i.status === "overdue").length,
			},
		});
	});

	// Service-only context read: up to 10 loans for one applicant as of a
	// case date, each with installment counts + open EWS count. The read is
	// bound to the calling case first: the applications service revalidates
	// `contextAnalysisConsent` and that the applicant owns this application
	// (fail closed), so a caller-chosen applicationId can never widen the
	// scope. The caller's `asOf` must equal the binding's case as-of day —
	// a caller-chosen day would widen/narrow the exposure window — and
	// `disbursedAt <= asOf` end-of-day: future loans are not yet knowable,
	// and `asOf` itself must not be in the future. Consent/applicant denials
	// audit `context.denied` (ids/code only); success audits `context.read`
	// (route/count only) after the binding check. Serializes
	// summarizeLoan fields only — applicantUserId is never returned.
	app.get("/internal/loans/by-applicant/:userId", requireService, async (c) => {
		const me = c.var.user;
		const userId = c.req.param("userId");
		if (!UUID_RE.test(userId)) throw new HttpError(404, "NOT_FOUND", "not found");
		const applicationId = c.req.query("applicationId") ?? "";
		if (!UUID_RE.test(applicationId)) {
			throw new HttpError(400, "VALIDATION_ERROR", "applicationId is required");
		}
		const asOf = c.req.query("asOf") ?? "";
		if (!DAY_RE.test(asOf)) {
			throw new HttpError(400, "VALIDATION_ERROR", "asOf is required as YYYY-MM-DD");
		}
		// Strict calendar day: round-trips through UTC and is not in the
		// future, so the caller cannot widen the exposure window.
		const asOfDay = new Date(`${asOf}T00:00:00Z`);
		if (Number.isNaN(asOfDay.getTime()) || asOfDay.toISOString().slice(0, 10) !== asOf) {
			throw new HttpError(400, "VALIDATION_ERROR", "invalid asOf");
		}
		if (asOf > new Date().toISOString().slice(0, 10)) {
			throw new HttpError(400, "VALIDATION_ERROR", "asOf cannot be in the future");
		}
		// Denied binding (consent/applicant): audit ids/code only, then fail.
		const deny = async (code: string, status: 403 | 404, message: string): Promise<never> => {
			await withTx(db, (tx) =>
				writeAudit(tx, {
					applicationId,
					actor: me.id,
					action: "context.denied",
					entity: "application",
					payload: { route: "loans", code },
				}),
			);
			throw new HttpError(
				status,
				code === "CONTEXT_CONSENT_REQUIRED" ? code : "NOT_FOUND",
				message,
			);
		};
		// Bind to the calling case before touching loan rows: consent and
		// applicant ownership come from the applications service, never
		// from the caller. Any failure (network, timeout, non-OK, shape
		// drift) fails closed with no loan query.
		const bindPath = `/internal/applications/${applicationId}/research-context`;
		let bindRes: Response;
		try {
			bindRes = await internalFetch(
				env.applicationsUrl,
				bindPath,
				// The applications internal route is service-only: sign the
				// caller's id/email with the service role (never forward the
				// officer's role to a service gate).
				{ id: me.id, email: me.email, role: "service" },
				{
					secret: env.internalSecret,
					fetchImpl: (async (url, init) =>
						fetchImpl(String(url), init as RequestInit)) as typeof fetch,
					timeoutMs: 5_000,
				},
			);
		} catch {
			throw new HttpError(503, "APPLICATIONS_UNAVAILABLE", "application context is unavailable");
		}
		if (bindRes.status === 404) throw new HttpError(404, "NOT_FOUND", "not found");
		if (!bindRes.ok) {
			throw new HttpError(503, "APPLICATIONS_UNAVAILABLE", "application context is unavailable");
		}
		let binding: {
			contextAnalysisConsent?: unknown;
			applicantUserId?: unknown;
			caseFacts?: { asOf?: unknown };
		};
		try {
			binding = (await bindRes.json()) as typeof binding;
		} catch {
			throw new HttpError(503, "APPLICATIONS_UNAVAILABLE", "application context is unavailable");
		}
		if (binding?.contextAnalysisConsent !== true) {
			await deny("CONTEXT_CONSENT_REQUIRED", 403, "context analysis consent is required");
		}
		// The caller's asOf must equal the case as-of day from the binding
		// (its caseFacts.asOf is the submittedAt day). A caller-chosen day
		// would widen/narrow the exposure window. Bindings without a case
		// as-of (test stubs) keep the validated query day.
		const bindingAsOf =
			typeof binding?.caseFacts?.asOf === "string" ? binding.caseFacts.asOf.slice(0, 10) : null;
		if (bindingAsOf !== null && bindingAsOf !== asOf) {
			throw new HttpError(400, "VALIDATION_ERROR", "asOf must match the case as-of");
		}
		if (binding?.applicantUserId !== userId) {
			await deny("APPLICANT_MISMATCH", 404, "not found");
		}
		const asOfEnd = new Date(`${asOf}T23:59:59.999Z`);
		const rows = await db
			.select()
			.from(loans)
			.where(and(eq(loans.applicantUserId, userId), lte(loans.disbursedAt, asOfEnd)))
			.orderBy(desc(loans.disbursedAt))
			.limit(10);
		await withTx(db, (tx) =>
			writeAudit(tx, {
				applicationId,
				actor: me.id,
				action: "context.read",
				entity: "application",
				payload: { route: "loans", loanCount: rows.length },
			}),
		);
		if (rows.length === 0) return c.json({ loans: [] });
		const ids = rows.map((r) => r.id);
		const [instRows, alertRows] = await Promise.all([
			db
				.select({ loanId: installments.loanId, status: installments.status })
				.from(installments)
				.where(inArray(installments.loanId, ids)),
			db
				.select({ loanId: ewsAlerts.loanId })
				.from(ewsAlerts)
				.where(and(inArray(ewsAlerts.loanId, ids), eq(ewsAlerts.status, "open"))),
		]);
		const counts = new Map(ids.map((id) => [id, { total: 0, paid: 0, overdue: 0, ewsOpen: 0 }]));
		for (const row of instRows) {
			const entry = counts.get(row.loanId);
			if (!entry) continue;
			entry.total += 1;
			if (row.status === "paid") entry.paid += 1;
			else if (row.status === "overdue") entry.overdue += 1;
		}
		for (const row of alertRows) {
			const entry = counts.get(row.loanId);
			if (entry) entry.ewsOpen += 1;
		}
		return c.json({
			loans: rows.map((loan) => {
				const entry = counts.get(loan.id) ?? { total: 0, paid: 0, overdue: 0, ewsOpen: 0 };
				return {
					...summarizeLoan(loan),
					installments: { total: entry.total, paid: entry.paid, overdue: entry.overdue },
					ewsOpen: entry.ewsOpen,
				};
			}),
		});
	});

	// Dashboard counts for the portfolio service (FR-9.2): loan status counts.
	app.get("/internal/stats", requireOfficerRole, async (c) => {
		const loanCounts = await db
			.select({ status: loans.status, n: count() })
			.from(loans)
			.groupBy(loans.status);
		return c.json({ loans: Object.fromEntries(loanCounts.map((r) => [r.status, r.n])) });
	});

	return app;
}
