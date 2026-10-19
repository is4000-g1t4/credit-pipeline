// Human review (SPEC FR-6.2, FR-7): STATELESS. Queue + decision state live
// in the applications service (signed internal API); the officer decision
// itself travels via the Temporal update. This service validates, replays a
// terminal decision on matching requestId (fetching the loan id from the
// loans service when needed), and otherwise awaits the update.
//
// Officer enforcement happens inside the service (the gateway only proves
// identity): applicants get 403, unsigned requests never reach here (401).
import { officerDecisionSchema } from "@credit/core";
import {
	GatewayError,
	HttpError,
	internalFetch,
	readJson,
	type ServiceApp,
	type ServiceVariables,
	type WorkflowGateway,
	zodFields,
} from "@credit/service-kit";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReviewRouteDeps {
	gateway: WorkflowGateway;
	applicationsUrl: string;
	loansUrl: string;
	internalSecret: string;
	fetchImpl?: typeof fetch;
}

interface DecisionProbe {
	status: string;
	decision: { id: string; outcome: string; requestId: string | null } | null;
}

export function reviewRoutes(deps: ReviewRouteDeps): ServiceApp {
	const app: ServiceApp = new Hono();
	const { gateway, applicationsUrl, loansUrl, internalSecret, fetchImpl } = deps;

	const officer = createMiddleware<{ Variables: ServiceVariables }>(async (c, next) => {
		const me = c.var.user;
		if (!me) throw new HttpError(401, "UNAUTHENTICATED", "login required");
		if (me.role !== "officer") throw new HttpError(403, "FORBIDDEN", "officer role required");
		await next();
	});

	const get = async (
		baseUrl: string,
		path: string,
		user: ServiceVariables["user"],
	): Promise<Response> => internalFetch(baseUrl, path, user, { secret: internalSecret, fetchImpl });

	app.get("/api/review/queue", officer, async (c) => {
		const res = await get(applicationsUrl, "/internal/review/queue", c.var.user);
		if (!res.ok) throw new HttpError(502, "BAD_GATEWAY", "upstream service unavailable");
		return c.json(await res.json());
	});

	app.post("/api/review/:id/decision", officer, async (c) => {
		const me = c.var.user;
		const id = c.req.param("id");
		if (!UUID_RE.test(id)) throw new HttpError(404, "NOT_FOUND", "not found");
		const parsed = officerDecisionSchema.safeParse(await readJson(c));
		if (!parsed.success) {
			throw new HttpError(422, "VALIDATION_ERROR", "invalid decision", zodFields(parsed.error));
		}
		const input = parsed.data;
		// Terminal replay first (FR-6.2): same requestId → original 200,
		// different id → 409. Only then send the update.
		const probeRes = await get(applicationsUrl, `/internal/applications/${id}/decision`, me);
		if (probeRes.status === 404) throw new HttpError(404, "NOT_FOUND", "not found");
		if (!probeRes.ok) throw new HttpError(502, "BAD_GATEWAY", "upstream service unavailable");
		const probe = (await probeRes.json()) as DecisionProbe;
		if (probe.decision) {
			if (probe.decision.requestId === input.requestId) {
				// A declined replay is terminal as-is. An approved replay is
				// only terminal once the loan exists: no loan yet means the
				// booking saga is still converging (reconciler retries), so
				// 409 and let the officer retry rather than report booked.
				if (probe.decision.outcome !== "approved") {
					return c.json({
						outcome: "declined",
						decisionId: probe.decision.id,
						loanId: null,
					});
				}
				const loanRes = await get(loansUrl, `/internal/loans/by-application/${id}`, me);
				if (loanRes.ok) {
					return c.json({
						outcome: "booked",
						decisionId: probe.decision.id,
						loanId: ((await loanRes.json()) as { loan: { id: string } }).loan.id,
					});
				}
				if (loanRes.status !== 404) {
					throw new HttpError(502, "BAD_GATEWAY", "upstream service unavailable");
				}
				throw new HttpError(409, "BOOKING_INCOMPLETE", "booking is still converging; retry");
			}
			throw new HttpError(409, "DECISION_CONFLICT", "case was already decided");
		}
		if (probe.status !== "pending_review") {
			throw new HttpError(409, "CASE_NOT_PENDING", "case is not awaiting an officer decision");
		}
		try {
			const result = await gateway.sendOfficerDecision(id, {
				requestId: input.requestId,
				outcome: input.outcome,
				...(input.approvedAmountCents !== undefined
					? { approvedAmountCents: input.approvedAmountCents }
					: {}),
				...(input.termMonths !== undefined ? { termMonths: input.termMonths } : {}),
				...(input.reasonCode !== undefined ? { reasonCode: input.reasonCode } : {}),
				...(input.notes !== undefined ? { notes: input.notes } : {}),
				officerUserId: me.id,
			});
			return c.json(result);
		} catch (err) {
			if (err instanceof GatewayError) {
				throw new HttpError(err.status, err.code, err.message);
			}
			throw err;
		}
	});

	return app;
}
